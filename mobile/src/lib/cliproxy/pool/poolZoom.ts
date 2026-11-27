/**
 * Zoom and pan for the pool charts: a visible window inside the page's range.
 * Every chart on the page shares one view, so the cards stay lined up.
 * `null` means the whole range is shown.
 */

export interface TimeView {
  startMs: number;
  endMs: number;
}

/** The narrowest view; history points are minutes apart, so closer shows nothing new. */
export const MIN_ZOOM_SPAN_MS = 30 * 60_000;

/** How far one zoom-in step (button or key) narrows the view. */
export const ZOOM_STEP = 0.5;

/**
 * Fit a view inside the bounds: no narrower than the minimum, no wider than
 * the bounds, slid back in when it overhangs an edge. A view that covers the
 * whole range is `null`, so "zoomed" has one meaning everywhere.
 */
export function clampView(view: TimeView, bounds: TimeView): TimeView | null {
  const full = bounds.endMs - bounds.startMs;
  if (!(full > 0)) return null;
  const want = view.endMs - view.startMs;
  if (!Number.isFinite(want) || !Number.isFinite(view.startMs)) return null;
  const span = Math.min(full, Math.max(Math.min(MIN_ZOOM_SPAN_MS, full), want));
  if (span >= full - 1) return null;
  const startMs = Math.min(bounds.endMs - span, Math.max(bounds.startMs, view.startMs));
  return { startMs, endMs: startMs + span };
}

/**
 * Scale the view by `factor` (under 1 zooms in) keeping `anchorMs` at the
 * same place on screen, as a pinch or a scroll under the pointer does.
 */
export function zoomView(
  view: TimeView,
  bounds: TimeView,
  factor: number,
  anchorMs: number,
): TimeView | null {
  const span = view.endMs - view.startMs;
  if (!(span > 0) || !(factor > 0)) return clampView(view, bounds);
  const full = bounds.endMs - bounds.startMs;
  const next = Math.min(full, Math.max(Math.min(MIN_ZOOM_SPAN_MS, full), span * factor));
  const frac = Math.min(1, Math.max(0, (anchorMs - view.startMs) / span));
  const anchor = view.startMs + frac * span;
  const startMs = anchor - frac * next;
  return clampView({ startMs, endMs: startMs + next }, bounds);
}

/** Slide the view by `deltaMs`, stopping at the edges of the bounds. */
export function panView(view: TimeView, bounds: TimeView, deltaMs: number): TimeView | null {
  return clampView(
    { startMs: view.startMs + deltaMs, endMs: view.endMs + deltaMs },
    bounds,
  );
}

/**
 * The view that keeps the times `t0` and `t1` under two fingers at `p0` and
 * `p1` (pixels from the plot's left edge, across a plot `plotW` wide). Past
 * the zoom limits the scale stops and the view holds the fingers' midpoint.
 * Undefined when the fingers are too close together to read a scale from.
 */
export function pinchView(
  t0: number,
  t1: number,
  p0: number,
  p1: number,
  plotW: number,
  bounds: TimeView,
): TimeView | null | undefined {
  if (Math.abs(p1 - p0) < 24 || !(plotW > 0)) return undefined;
  const span = ((t1 - t0) * plotW) / (p1 - p0);
  if (!(span > 0)) return undefined;
  const midFrac = (p0 + p1) / 2 / plotW;
  const midMs = (t0 + t1) / 2;
  const full = bounds.endMs - bounds.startMs;
  const fitted = Math.min(full, Math.max(Math.min(MIN_ZOOM_SPAN_MS, full), span));
  const startMs = midMs - midFrac * fitted;
  return clampView({ startMs, endMs: startMs + fitted }, bounds);
}

/**
 * One step of the range arrows while zoomed: slide by a whole view, moving
 * to the next page when the view runs off this one and paging allows it.
 * Returns the settings patch, or null when there is nowhere to go.
 */
export function stepZoomedView(
  view: TimeView,
  bounds: TimeView,
  direction: -1 | 1,
  offset: number,
  limits: { min: number; max: number },
): { zoom: TimeView | null; offset?: number } | null {
  const span = view.endMs - view.startMs;
  const shifted = { startMs: view.startMs + direction * span, endMs: view.endMs + direction * span };
  const fits = direction > 0 ? shifted.endMs <= bounds.endMs : shifted.startMs >= bounds.startMs;
  if (fits) return { zoom: shifted };
  const atEdge = direction > 0 ? view.endMs >= bounds.endMs : view.startMs <= bounds.startMs;
  const nextOffset = offset + direction;
  if (nextOffset >= limits.min && nextOffset <= limits.max) {
    // Pages overlap, so a view up to a page step wide lands inside the next
    // page; a wider one is clamped into it when the page renders.
    return { zoom: shifted, offset: nextOffset };
  }
  if (atEdge) return null;
  return { zoom: clampView(shifted, bounds) };
}
