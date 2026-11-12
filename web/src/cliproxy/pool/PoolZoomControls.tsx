/**
 * The panel's zoom controls: zoom out / in / whole-range buttons for the
 * range row, and the scrubber shown under it while zoomed. Both edit the one
 * view every chart card shares.
 */

import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import IconZoomIn from "@tabler/icons-react/dist/esm/icons/IconZoomIn.mjs";
import IconZoomOut from "@tabler/icons-react/dist/esm/icons/IconZoomOut.mjs";
import IconZoomReset from "@tabler/icons-react/dist/esm/icons/IconZoomReset.mjs";
import { poolText } from "./poolText";
import { MIN_ZOOM_SPAN_MS, clampView, panView, zoomView, ZOOM_STEP, type TimeView } from "./poolZoom";
import styles from "./QuotaPoolPanel.module.css";

type OnChange = (view: TimeView | null) => void;

export function ZoomButtons({
  range,
  view,
  zoomed,
  onChange,
}: {
  range: TimeView;
  view: TimeView;
  zoomed: boolean;
  onChange: OnChange;
}) {
  const { t } = poolText;
  const center = view.startMs + (view.endMs - view.startMs) / 2;
  const atMinZoom = view.endMs - view.startMs <= MIN_ZOOM_SPAN_MS + 1;
  return (
    <div className={styles.zoomButtons} role="group" aria-label={t("quota_management.pool_zoom")}>
      <button
        type="button"
        className={styles.navButton}
        onClick={() => onChange(zoomView(view, range, 1 / ZOOM_STEP, center))}
        disabled={!zoomed}
        aria-label={t("quota_management.pool_zoom_out")}
        title={t("quota_management.pool_zoom_out")}
      >
        <IconZoomOut size={16} />
      </button>
      <button
        type="button"
        className={styles.navButton}
        onClick={() => onChange(zoomView(view, range, ZOOM_STEP, center))}
        disabled={atMinZoom}
        aria-label={t("quota_management.pool_zoom_in")}
        title={`${t("quota_management.pool_zoom_in")}. ${t("quota_management.pool_zoom_hint")}`}
      >
        <IconZoomIn size={16} />
      </button>
      {zoomed && (
        <button
          type="button"
          className={styles.navButton}
          onClick={() => onChange(null)}
          aria-label={t("quota_management.pool_zoom_reset")}
          title={t("quota_management.pool_zoom_reset")}
        >
          <IconZoomReset size={16} />
        </button>
      )}
    </div>
  );
}

/**
 * The scrubber under the range row while zoomed: the whole range as a track
 * with the visible part as a thumb. Drag the thumb to pan, its edges to
 * resize, or press the track to jump there; arrow keys pan from the keyboard.
 */
export function ZoomTrack({
  range,
  view,
  now,
  valueText,
  onChange,
}: {
  range: TimeView;
  view: TimeView;
  now: number;
  valueText: string;
  onChange: OnChange;
}) {
  const { t } = poolText;
  const trackRef = useRef<HTMLDivElement>(null);
  const grab = useRef<{
    mode: "move" | "start" | "end";
    pointerMs: number;
    view: TimeView;
  } | null>(null);
  const full = range.endMs - range.startMs;
  const span = view.endMs - view.startMs;
  const pct = (ms: number) => ((ms - range.startMs) / full) * 100;
  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return range.startMs;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return range.startMs + frac * full;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const handle = target.dataset.handle as "start" | "end" | undefined;
    const onThumb = Boolean(target.closest("[data-thumb]"));
    const at = timeAt(event.clientX);
    let from = view;
    if (!handle && !onThumb) {
      // Pressing the bare track centres the view there, then drags from it.
      from = panView(view, range, at - (view.startMs + span / 2)) ?? view;
      onChange(from);
    }
    grab.current = { mode: handle ?? "move", pointerMs: at, view: from };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that already lifted: the drag simply ends at the track's edge.
    }
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const held = grab.current;
    if (!held) return;
    const delta = timeAt(event.clientX) - held.pointerMs;
    const { startMs, endMs } = held.view;
    if (held.mode === "move") {
      onChange(panView(held.view, range, delta));
    } else if (held.mode === "start") {
      // The dragged edge stops at the track's end and at the narrowest view;
      // the other edge stays where it is.
      const start = Math.max(range.startMs, Math.min(startMs + delta, endMs - MIN_ZOOM_SPAN_MS));
      onChange(clampView({ startMs: start, endMs }, range));
    } else {
      const end = Math.min(range.endMs, Math.max(endMs + delta, startMs + MIN_ZOOM_SPAN_MS));
      onChange(clampView({ startMs, endMs: end }, range));
    }
  };

  const release = () => {
    grab.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowLeft: -span / 10,
      ArrowRight: span / 10,
      ArrowDown: -span / 10,
      ArrowUp: span / 10,
      PageDown: -span,
      PageUp: span,
      Home: range.startMs - view.startMs,
      End: range.endMs - view.endMs,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    onChange(panView(view, range, moves[event.key]));
  };

  const startPct = pct(view.startMs);
  return (
    <div
      ref={trackRef}
      className={styles.zoomTrack}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
    >
      {now >= range.startMs && now <= range.endMs && (
        <span className={styles.zoomTrackNow} style={{ left: `${pct(now)}%` }} />
      )}
      <div
        data-thumb
        className={styles.zoomThumb}
        // A thumb held at its minimum width stays inside the track at the far end.
        style={
          {
            "--thumb-left": `${startPct}%`,
            "--thumb-width": `${(span / full) * 100}%`,
          } as CSSProperties
        }
        role="slider"
        tabIndex={0}
        aria-label={t("quota_management.pool_zoom_track")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(startPct)}
        aria-valuetext={valueText}
        onKeyDown={onKeyDown}
      >
        <span data-handle="start" className={styles.zoomHandle} />
        <span data-handle="end" className={styles.zoomHandle} />
      </div>
    </div>
  );
}
