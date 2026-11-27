// The pool chart's touch, turn and phone-width rules, apart from React Native.
//
// The pinch, as a view: the time under the fingers when they landed stays under
// them while they spread, close and slide, as the web's two-finger pinch does
// (poolZoom.ts pinchView). iOS reports a pinch as one focal point and a scale,
// not two fingers, so the view is rebuilt from those.
import { clampView, MIN_ZOOM_SPAN_MS, type TimeView } from '../../lib/cliproxy/pool/poolZoom.ts'

/**
 * The view `scale` times narrower than `from` (over 1 zooms in) with `anchorMs`
 * at `frac` of the plot's width (where the fingers' midpoint is now). Kept inside
 * `bounds` and no narrower than the minimum; `null` is the whole range.
 */
export function focalView(from: TimeView, bounds: TimeView, anchorMs: number, scale: number, frac: number): TimeView | null {
  const span0 = from.endMs - from.startMs
  if (!(scale > 0) || !(span0 > 0) || !Number.isFinite(frac)) return clampView(from, bounds)
  const full = bounds.endMs - bounds.startMs
  const span = Math.min(full, Math.max(Math.min(MIN_ZOOM_SPAN_MS, full), span0 / scale))
  const at = Math.min(1, Math.max(0, frac))
  const startMs = anchorMs - at * span
  return clampView({ startMs, endMs: startMs + span }, bounds)
}

/** 1: the top of the phone to the left (a quarter turn anticlockwise); -1: to the right. */
export type Turn = 1 | -1

/**
 * The safe-area padding of the sideways view, which is drawn a quarter turn
 * round: its left edge is the phone's top (the Dynamic Island) or bottom (the
 * home bar), whichever way the phone is turned.
 */
export function turnedInsets(turn: Turn, insets: { top: number; right: number; bottom: number; left: number }) {
  return turn === 1
    ? { left: insets.top, right: insets.bottom, top: insets.right, bottom: insets.left }
    : { left: insets.bottom, right: insets.top, top: insets.left, bottom: insets.right }
}

/**
 * The refills worth a label on a narrow chart: the biggest one in each slice of
 * the view, `slots` slices to its width, in time order. Labels at a phone's width
 * otherwise sit at every 5-hour refill of every account. The slices are counted
 * from `anchorMs` (the page's start, which holds still while two fingers zoom
 * and slide), so the labels don't jump between refills on every frame; the view
 * can therefore show part of one more slice at an edge.
 */
export function thinResets<R extends { t: number; delta: number }>(resets: readonly R[], startMs: number, endMs: number, slots: number, anchorMs = startMs): R[] {
  const span = endMs - startMs
  if (!(span > 0) || !(slots > 0)) return [...resets]
  const width = span / slots
  const best = new Map<number, R>()
  for (const r of resets) {
    if (r.t < startMs || r.t > endMs) continue
    const slot = Math.floor((r.t - anchorMs) / width)
    const held = best.get(slot)
    if (!held || r.delta > held.delta) best.set(slot, r)
  }
  return [...best.values()].sort((a, b) => a.t - b.t)
}
