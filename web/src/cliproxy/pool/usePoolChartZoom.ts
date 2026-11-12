/**
 * Zoom and pan input for one pool chart: a mouse drag selects a stretch to
 * zoom to, Ctrl/⌘ + scroll or a trackpad pinch zooms under the pointer (Safari
 * sends the pinch as gesture events), two fingers pinch on a phone, a
 * sideways scroll pans, and double-click shows the whole range. The page
 * holds the view; this only reports the next one through `onViewChange`.
 */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { clampView, panView, pinchView, zoomView, ZOOM_STEP, type TimeView } from './poolZoom';

/** A drag shorter than this is a click, not a zoom selection. */
const DRAG_MIN_PX = 6;

type Span = { from: number; to: number };

export function usePoolChartZoom({
  wrapRef,
  view,
  bounds,
  width,
  plotLeft,
  plotW,
  hoverT,
  setHoverT,
  onViewChange,
}: {
  wrapRef: RefObject<HTMLDivElement | null>;
  view: TimeView;
  bounds: TimeView;
  /** The chart's width in its own pixels, and the plot's place inside it. */
  width: number;
  plotLeft: number;
  plotW: number;
  hoverT: number | null;
  setHoverT: (t: number | null) => void;
  onViewChange: (view: TimeView | null) => void;
}) {
  const span = view.endMs - view.startMs;
  const zoomed = view.startMs > bounds.startMs || view.endMs < bounds.endMs;
  const tAt = (px: number) => view.startMs + ((px - plotLeft) / plotW) * span;

  /** The stretch a mouse drag has covered so far, in chart pixels. */
  const [drag, setDragState] = useState<Span | null>(null);
  // Mirrored in a ref: pointer events can arrive faster than React re-renders.
  const dragRef = useRef<Span | null>(null);
  const setDrag = (next: Span | null) => {
    dragRef.current = next;
    setDragState(next);
  };
  const touches = useRef(new Map<number, number>());
  const pinch = useRef<{ ids: [number, number]; t: [number, number] } | null>(null);

  // The wheel and gesture listeners are attached by hand (React's wheel
  // listener is passive and cannot stop the page scrolling), so they read the
  // latest view through a ref.
  const live = useRef({ view, bounds, width, plotLeft, plotW, zoomed, onViewChange });
  live.current = { view, bounds, width, plotLeft, plotW, zoomed, onViewChange };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Wheel events can outrun renders; each one builds on the last one's view.
    const apply = (next: TimeView | null) => {
      live.current.view = next ?? live.current.bounds;
      live.current.zoomed = next !== null;
      live.current.onViewChange(next);
    };
    const timeAtClient = (clientX: number) => {
      const { view, width, plotLeft, plotW } = live.current;
      const rect = el.getBoundingClientRect();
      const px = ((clientX - rect.left) / Math.max(1, rect.width)) * width;
      const frac = Math.min(1, Math.max(0, (px - plotLeft) / plotW));
      return view.startMs + frac * (view.endMs - view.startMs);
    };
    const onWheel = (event: WheelEvent) => {
      const { view, bounds, plotW, zoomed } = live.current;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? plotW : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      if (event.ctrlKey || event.metaKey) {
        // A trackpad pinch arrives as Ctrl + wheel with small deltas.
        event.preventDefault();
        const factor = Math.exp(Math.max(-1, Math.min(1, dy * 0.004)));
        apply(zoomView(view, bounds, factor, timeAtClient(event.clientX)));
        return;
      }
      if (!zoomed) return;
      const sideways = Math.abs(dx) > Math.abs(dy) ? dx : event.shiftKey ? dy : 0;
      if (sideways === 0) return;
      event.preventDefault();
      apply(panView(view, bounds, (sideways / plotW) * (view.endMs - view.startMs)));
    };
    // Safari reports a trackpad pinch as gesture events instead of Ctrl + wheel.
    // iOS sends them for a finger pinch too; while both fingers are on the
    // chart the pointer events already follow it, so they are ignored then.
    let gestureFrom: TimeView | null = null;
    type Gesture = Event & { scale: number; clientX: number };
    const onGestureStart = (event: Event) => {
      if (pinch.current) return;
      event.preventDefault();
      gestureFrom = live.current.view;
    };
    const onGestureChange = (event: Event) => {
      if (!gestureFrom || pinch.current) return;
      event.preventDefault();
      const gesture = event as Gesture;
      if (!(gesture.scale > 0)) return;
      apply(
        zoomView(gestureFrom, live.current.bounds, 1 / gesture.scale, timeAtClient(gesture.clientX)),
      );
    };
    const onGestureEnd = () => {
      gestureFrom = null;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    el.addEventListener('gestureend', onGestureEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
    };
  }, [wrapRef]);

  /** Chart pixels across, from a pointer's position on screen. */
  const pxOf = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return ((event.clientX - rect.left) / Math.max(1, rect.width)) * width;
  };
  const inPlot = (px: number) => px >= plotLeft && px <= plotLeft + plotW;
  const clampPx = (px: number) => Math.min(plotLeft + plotW, Math.max(plotLeft, px));

  const endTouch = (event: PointerEvent<SVGSVGElement>) => {
    touches.current.delete(event.pointerId);
    if (pinch.current && !pinch.current.ids.every((id) => touches.current.has(id))) {
      pinch.current = null;
    }
  };

  const svgHandlers = {
    onPointerDown(event: PointerEvent<SVGSVGElement>) {
      const px = pxOf(event);
      if (event.pointerType === 'touch') {
        touches.current.set(event.pointerId, px);
        if (touches.current.size === 2) {
          // Two fingers: pin the time under each one, then follow them.
          const [[idA, pxA], [idB, pxB]] = [...touches.current.entries()];
          pinch.current = { ids: [idA, idB], t: [tAt(pxA), tAt(pxB)] };
          setHoverT(null);
        }
        return;
      }
      if (event.button !== 0 || !inPlot(px)) return;
      try {
        // Keep the drag when the mouse leaves the chart.
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that already lifted: the drag still ends on this chart's pointerup.
      }
      setDrag({ from: px, to: px });
    },

    onPointerMove(event: PointerEvent<SVGSVGElement>) {
      const px = pxOf(event);
      if (event.pointerType === 'touch' && touches.current.has(event.pointerId)) {
        touches.current.set(event.pointerId, px);
        const held = pinch.current;
        if (held) {
          const pA = touches.current.get(held.ids[0]);
          const pB = touches.current.get(held.ids[1]);
          if (pA === undefined || pB === undefined) return;
          const next = pinchView(held.t[0], held.t[1], pA - plotLeft, pB - plotLeft, plotW, bounds);
          if (next !== undefined) onViewChange(next);
          return;
        }
      }
      const dragging = dragRef.current;
      if (dragging) {
        setDrag({ from: dragging.from, to: clampPx(px) });
        setHoverT(tAt(clampPx(px)));
        return;
      }
      setHoverT(inPlot(px) ? tAt(px) : null);
    },

    onPointerUp(event: PointerEvent<SVGSVGElement>) {
      if (event.pointerType === 'touch') {
        endTouch(event);
        return;
      }
      const dragging = dragRef.current;
      if (!dragging) return;
      setDrag(null);
      const to = clampPx(pxOf(event));
      if (Math.abs(to - dragging.from) < DRAG_MIN_PX) return;
      const [a, b] = dragging.from < to ? [dragging.from, to] : [to, dragging.from];
      onViewChange(clampView({ startMs: tAt(a), endMs: tAt(b) }, bounds));
    },

    onPointerCancel(event: PointerEvent<SVGSVGElement>) {
      if (event.pointerType === 'touch') endTouch(event);
      setDrag(null);
    },

    onPointerLeave() {
      if (!dragRef.current) setHoverT(null);
    },

    onDoubleClick() {
      if (zoomed) onViewChange(null);
    },
  };

  /** Slide the view so `t` is on screen, as the keyboard crosshair walks off an edge. */
  const follow = (t: number) => {
    if (t < view.startMs) onViewChange(panView(view, bounds, t - view.startMs));
    else if (t > view.endMs) onViewChange(panView(view, bounds, t - view.endMs));
  };

  /** Slide the view so `t` sits in its middle, as Home does for Now. */
  const centerOn = (t: number) => {
    onViewChange(panView(view, bounds, t - (view.startMs + span / 2)));
  };

  /**
   * `+`/`-` zoom around the crosshair (or the middle) and `0` shows the whole
   * range. With Ctrl, ⌘ or Alt held the keys are the browser's page zoom, so
   * they are left alone. True when the key was used.
   */
  const onZoomKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const zoomIn = event.key === '+' || event.key === '=';
    const zoomOut = event.key === '-' || event.key === '_';
    if (!zoomIn && !zoomOut && event.key !== '0') return false;
    event.preventDefault();
    if (event.key === '0') {
      onViewChange(null);
      return true;
    }
    const anchor =
      hoverT !== null && hoverT >= view.startMs && hoverT <= view.endMs
        ? hoverT
        : view.startMs + span / 2;
    onViewChange(zoomView(view, bounds, zoomIn ? ZOOM_STEP : 1 / ZOOM_STEP, anchor));
    return true;
  };

  const cancelDrag = () => {
    if (dragRef.current) setDrag(null);
  };

  /** The selection to draw, once the drag is long enough to count. */
  const selection = drag && Math.abs(drag.to - drag.from) >= DRAG_MIN_PX ? drag : null;

  return { zoomed, selection, svgHandlers, onZoomKey, follow, centerOn, cancelDrag };
}
