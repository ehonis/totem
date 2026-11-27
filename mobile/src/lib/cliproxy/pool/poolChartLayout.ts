/**
 * The pool chart's layout, apart from drawing it: scales, the stacked account
 * bands, where reset labels and limit markers fit, the time columns and their
 * labels, and what the crosshair reads at a moment. PoolChart.tsx draws it on
 * the dashboard; the iPhone app draws the same layout with react-native-svg
 * from a byte-for-byte copy (mobile/src/lib/cliproxy/pool/), so the two charts
 * cannot disagree about a number or a label.
 *
 * Pixels here are the chart's own: `x` and `y` place a time and a value.
 */

import { DAY_MS, type PoolLimitEvent, type PoolLimitEventKind, type PoolModel, type SeriesPoint } from './poolModel';
import { EVENT_SHORT_KEY, formatStamp } from './poolFormat';
import { poolText } from './poolText';

export type PoolChartMode = 'remaining' | 'rate';

/** The plot's place inside the chart, and the scales onto it. */
export interface ChartFrame {
  startMs: number;
  endMs: number;
  /** The whole chart, axes included. */
  width: number;
  plotLeft: number;
  plotTop: number;
  plotW: number;
  plotH: number;
  yMax: number;
  x: (ms: number) => number;
  y: (v: number) => number;
}

export function chartFrame({
  startMs,
  endMs,
  width,
  height,
  margin,
  yMax,
}: {
  startMs: number;
  endMs: number;
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  yMax: number;
}): ChartFrame {
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const span = endMs - startMs;
  return {
    startMs,
    endMs,
    width,
    plotLeft: margin.left,
    plotTop: margin.top,
    plotW,
    plotH,
    yMax,
    x: (ms: number) => margin.left + ((ms - startMs) / span) * plotW,
    y: (v: number) => margin.top + (1 - Math.max(0, Math.min(v, yMax)) / yMax) * plotH,
  };
}

/** First index whose time is at or after `t` in a sorted series. */
export function lowerBound(series: readonly { t: number }[], t: number) {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The points inside [from, to] plus one on each side, so a line still runs to
 * the plot's edges when the view is narrower than the gap between points.
 */
export function windowed<T extends { t: number }>(series: readonly T[], from: number, to: number): T[] {
  if (series.length === 0) return [];
  const first = Math.max(0, lowerBound(series, from) - 1);
  const last = Math.min(series.length, lowerBound(series, to + 1) + 1);
  return series.slice(first, last);
}

export type Box = { x0: number; x1: number; y0: number; y1: number };
export const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export function niceCeil(value: number) {
  if (value <= 1) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  // Steps whose half is still a round tick label.
  for (const step of [1, 2, 4, 5, 10]) {
    if (step * exp >= value) return step * exp;
  }
  return 10 * exp;
}

/** Lookup on a sorted series; the later point wins on equal timestamps. */
export function valueAt(series: SeriesPoint[], t: number): number | null {
  if (series.length === 0 || t < series[0].t || t > series[series.length - 1].t) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  if (b.t === a.t || t === a.t) return a.v;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

export function indexAt(series: SeriesPoint[], t: number) {
  let best = 0;
  for (let i = 0; i < series.length; i += 1) {
    if (series[i].t <= t) best = i;
    else break;
  }
  return best;
}

/** The value axis' top: the pool's capacity, or a round number above the fastest drain. */
export function chartYMax(model: PoolModel, rateMode: boolean) {
  if (!rateMode) return Math.max(100, model.capacity);
  const peak = Math.max(0, ...model.recordedRate.map((p) => p.v), ...model.projectedRate.map((p) => p.v));
  return niceCeil(peak * 1.25 || 1);
}

export interface BandPoint {
  t: number;
  lo: number;
  hi: number;
}

/** Each account's share of the pool, stacked in account order. */
export function accountBands(model: PoolModel) {
  const keys = model.accounts.map((a) => a.key);
  const build = (times: SeriesPoint[], byAccount: Record<string, number[]>) => {
    const lower = times.map(() => 0);
    return keys.map((key) => {
      const values = byAccount[key] ?? [];
      const top = times.map((_, i) => lower[i] + (values[i] ?? 0));
      const band = times.map((p, i) => ({ t: p.t, lo: lower[i], hi: top[i] }));
      for (let i = 0; i < lower.length; i += 1) lower[i] = top[i];
      return band;
    });
  };
  const rec = build(model.recorded, model.recordedByAccount);
  const proj = build(model.projected, model.projectedByAccount);
  return keys.map((key, index) => ({ key, recorded: rec[index], projected: proj[index] }));
}

/** A series as an SVG path; the same string draws on the web and in the app. */
export function linePath(frame: ChartFrame, series: SeriesPoint[]) {
  return series
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${frame.x(p.t).toFixed(1)},${frame.y(p.v).toFixed(1)}`)
    .join('');
}

/** The area under a series, down to zero. */
export function areaPath(frame: ChartFrame, series: SeriesPoint[]) {
  return series.length < 2
    ? ''
    : `${linePath(frame, series)}L${frame.x(series[series.length - 1].t).toFixed(1)},${frame.y(0)}L${frame.x(series[0].t).toFixed(1)},${frame.y(0)}Z`;
}

/** One account's band inside the view, as a closed path. */
export function bandPath(frame: ChartFrame, band: BandPoint[]) {
  const pts = windowed(band, frame.startMs, frame.endMs);
  if (pts.length < 2) return '';
  const top = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${frame.x(p.t).toFixed(1)},${frame.y(p.hi).toFixed(1)}`);
  const bottom = [...pts].reverse().map((p) => `L${frame.x(p.t).toFixed(1)},${frame.y(p.lo).toFixed(1)}`);
  return `${top.join('')}${bottom.join('')}Z`;
}

export interface ResetLabel {
  key: string;
  x: number;
  y: number;
  text: string;
  projected: boolean;
  title: string;
}

/**
 * "+40%" over each refill big enough to name, placed where it overlaps no
 * other label and stays off the Now label.
 */
export function placeResetLabels(
  model: PoolModel,
  frame: ChartFrame,
  {
    now,
    minResetLabel = 0,
    locale,
    labelW = 44,
    labelH = 16,
  }: { now: number; minResetLabel?: number; locale?: string; labelW?: number; labelH?: number },
): ResetLabel[] {
  const { startMs, endMs, x, y, plotW, plotTop, plotH } = frame;
  const placed: Box[] = [];
  const out: ResetLabel[] = [];
  for (const reset of model.resets) {
    if (reset.t < startMs || reset.t > endMs || reset.delta < minResetLabel) continue;
    const series = reset.projected ? model.projected : model.recorded;
    const v = valueAt(series, reset.t + 1) ?? valueAt(series, reset.t);
    if (v === null) continue;
    const cx = x(reset.t);
    const lineY = y(v);
    // The Now label and dot own the space around the present moment.
    if (now >= startMs && now <= endMs && Math.abs(cx - x(now)) < labelW / 2 + 4) {
      continue;
    }
    // On a narrow chart only the bigger refills earn a label.
    if (plotW < 400 && reset.delta < 20) continue;
    // Above the line first, then tucked under it, then further up.
    const candidates = [lineY - 12, lineY + 20, lineY - 30, lineY + 38];
    let chosen: number | null = null;
    for (const cy of candidates) {
      const box = { x0: cx - labelW / 2, x1: cx + labelW / 2, y0: cy - labelH, y1: cy + 2 };
      if (cy - labelH < 6 || cy > plotTop + plotH - 4) continue;
      if (placed.some((other) => overlaps(box, other))) continue;
      placed.push(box);
      chosen = cy;
      break;
    }
    if (chosen === null) continue;
    out.push({
      key: `${reset.t}-${reset.projected ? 'p' : 'r'}`,
      x: cx,
      y: chosen,
      text: `+${Math.round(reset.delta)}%`,
      projected: reset.projected,
      title: `${formatStamp(reset.t, locale)} · ${reset.labels.join(', ')}`,
    });
  }
  return out;
}

export interface ChartMarker {
  key: string;
  event: PoolLimitEvent;
  cx: number;
  text: string;
  /** The label's baseline, or null when no row had room for it. */
  labelY: number | null;
}

/**
 * A marker wherever a limit ran out or the weekly limit refilled (recorded,
 * before Now) or is projected to (after it), each labelled in the first of
 * `rows` with room. Sorted by time.
 */
export function placeMarkers(
  model: PoolModel,
  frame: ChartFrame,
  {
    now,
    eventKinds,
    rows,
    charW = 6.8,
  }: { now: number; eventKinds: readonly PoolLimitEventKind[]; rows: readonly number[]; charW?: number },
): ChartMarker[] {
  const { startMs, endMs, x, width } = frame;
  const { t } = poolText;
  const placed: Box[] = [];
  if (now >= startMs && now <= endMs) {
    // The Now label sits in the top row.
    placed.push({ x0: x(now) - 20, x1: x(now) + 20, y0: rows[0] - 14, y1: rows[0] + 3 });
  }
  // What is coming claims label space before what already happened; weekly
  // run-outs first, 5-hour ones repeat and give way.
  const priority: Record<PoolLimitEventKind, number> = {
    'weekly-out': 0,
    'weekly-reset': 1,
    'five-out': 2,
  };
  const rank = (e: PoolLimitEvent) => priority[e.kind] + (e.recorded ? 3 : 0);
  const events = model.limitEvents
    .filter(
      (e) =>
        eventKinds.includes(e.kind) &&
        (e.recorded ? e.t <= now : e.t > now) &&
        e.t >= startMs &&
        e.t <= endMs,
    )
    .sort((a, b) => rank(a) - rank(b) || a.t - b.t);
  const out = events.map((event: PoolLimitEvent) => {
    const cx = x(event.t);
    const text = t(EVENT_SHORT_KEY[event.kind]);
    const half = (text.length * charW) / 2 + 4;
    let labelY: number | null = null;
    for (const row of rows) {
      const box = { x0: cx - half, x1: cx + half, y0: row - 14, y1: row + 3 };
      if (box.x0 < 2 || box.x1 > width - 2) continue;
      if (placed.some((other) => overlaps(box, other))) continue;
      placed.push(box);
      labelY = row;
      break;
    }
    const key = `${event.kind}-${event.t}-${event.recorded ? 'r' : 'p'}`;
    return { key, event, cx, text, labelY };
  });
  return out.sort((a, b) => a.event.t - b.event.t);
}

/** Column widths for the hour axis, in minutes; each divides a day evenly. */
const HOUR_STEPS_MIN = [15, 30, 60, 180, 360, 720];
const WHOLE_PAGE_HOUR_STEPS_MIN = [180, 360];
/** A partial day at the view's edge narrower than this gets no label. */
const MIN_DAY_LABEL_PX = 28;

/** Hour columns for the 5-hour view and for any view zoomed to three days or less. */
export const usesHourColumns = (hourly: boolean, spanMs: number) => hourly || spanMs <= 3 * DAY_MS;

export interface TimeColumn {
  /** Where the column starts on the calendar; may lie before the view. */
  t: number;
  /** The column's visible part. */
  from: number;
  end: number;
  weekday: string;
  day: string;
  weekend: boolean;
  today: boolean;
}

/**
 * The axis' columns: calendar days, or even hour steps (the narrowest that
 * leaves `minColumnPx` for a label) when `hourColumns`; midnight carries the date.
 */
export function timeColumns({
  startMs,
  endMs,
  now,
  locale,
  hourColumns,
  zoomed,
  plotW,
  minColumnPx = 42,
}: {
  startMs: number;
  endMs: number;
  now: number;
  locale?: string;
  hourColumns: boolean;
  zoomed: boolean;
  plotW: number;
  minColumnPx?: number;
}): TimeColumn[] {
  const out: TimeColumn[] = [];
  if (hourColumns) {
    // The whole 5-hour page keeps its 3- or 6-hour columns at any width.
    const steps = zoomed ? HOUR_STEPS_MIN : WHOLE_PAGE_HOUR_STEPS_MIN;
    const pxPerMin = plotW / ((endMs - startMs) / 60_000);
    const stepMin = steps.find((step) => step * pxPerMin >= minColumnPx) ?? steps[steps.length - 1];
    const d = new Date(startMs);
    const minutes = d.getHours() * 60 + d.getMinutes() + (d.getSeconds() || d.getMilliseconds() ? 1 : 0);
    d.setHours(0, Math.ceil(minutes / stepMin) * stepMin, 0, 0);
    const clock: Intl.DateTimeFormatOptions =
      stepMin < 60 ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' };
    while (d.getTime() < endMs) {
      const colStart = d.getTime();
      const next = new Date(d);
      next.setMinutes(next.getMinutes() + stepMin);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      out.push({
        t: colStart,
        from: colStart,
        end: Math.min(next.getTime(), endMs),
        weekday: d.toLocaleTimeString(locale, clock),
        day: midnight ? d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric' }) : '',
        weekend: false,
        today: now >= colStart && now < next.getTime(),
      });
      d.setTime(next.getTime());
    }
    // Zoomed inside one day there is no midnight; the first column names the day.
    if (out.length > 0 && !out.some((col) => col.day !== '')) {
      out[0].day = new Date(out[0].t).toLocaleDateString(locale, {
        weekday: 'short',
        day: 'numeric',
      });
    }
    return out;
  }
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  // Step by calendar day, not 24h: a DST change makes one day 23 or 25 hours.
  const d = new Date(startMs);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() < endMs) {
    const dayStart = d.getTime();
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    out.push({
      t: dayStart,
      from: Math.max(dayStart, startMs),
      end: Math.min(next.getTime(), endMs),
      weekday: d.toLocaleDateString(locale, { weekday: 'short' }),
      day: String(d.getDate()),
      weekend: d.getDay() === 0 || d.getDay() === 6,
      today: dayStart === todayStart,
    });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * Which columns get a label and where it sits: thinned when columns get
 * narrow, counted from today so today always keeps its label.
 */
export function columnLabels(columns: TimeColumn[], frame: ChartFrame, hourColumns: boolean) {
  const pxPerDay = frame.plotW / Math.max(1, columns.length);
  const labelEvery = hourColumns ? (pxPerDay < 34 ? 2 : 1) : pxPerDay < 18 ? 3 : pxPerDay < 34 ? 2 : 1;
  const anchor = Math.max(
    0,
    columns.findIndex((col) => col.today),
  );
  return columns.flatMap((col, index) => {
    // A sliver of a day at the view's edge would print over the axis.
    if (!hourColumns && frame.x(col.end) - frame.x(col.from) < MIN_DAY_LABEL_PX) return [];
    if (!(Math.abs(index - anchor) % labelEvery === 0 || (hourColumns && col.day !== ''))) return [];
    return [{ column: col, x: frame.x(hourColumns ? col.t : (col.from + col.end) / 2) }];
  });
}

export interface HoverAccount {
  label: string;
  v: number | null;
  weekly: number | null;
  five: number | null;
  binding?: 'weekly' | 'five';
}

export interface HoverReading {
  t: number;
  v: number;
  isProjected: boolean;
  accounts: HoverAccount[];
  /** True when the accounts carry both limits (the combined view). */
  windowed: boolean;
  events: PoolLimitEvent[];
  overlayV: number | null;
}

/**
 * What the crosshair at `hoverT` reads: the pool's level, each account's own
 * level (and both limits behind it in the combined view), the markers within
 * `nearPx` of it, and the overlay's level.
 */
export function hoverReading({
  model,
  frame,
  hoverT,
  now,
  rateMode,
  showAccounts,
  markers,
  overlay,
  nearPx = 8,
}: {
  model: PoolModel;
  frame: ChartFrame;
  hoverT: number | null;
  now: number;
  rateMode: boolean;
  showAccounts: boolean;
  markers: ChartMarker[];
  overlay: PoolModel | null;
  nearPx?: number;
}): HoverReading | null {
  const { startMs, endMs, plotW } = frame;
  if (hoverT === null || hoverT < startMs || hoverT > endMs) return null;
  const isProjected = hoverT > now;
  const series = rateMode
    ? isProjected
      ? model.projectedRate
      : model.recordedRate
    : isProjected
      ? model.projected
      : model.recorded;
  const v = valueAt(series, hoverT);
  if (v === null) return null;
  let accounts: HoverAccount[] = [];
  // The combined view lists both limits behind each account's usable level.
  const windows = rateMode
    ? undefined
    : isProjected
      ? model.windowsByAccount?.projected
      : model.windowsByAccount?.recorded;
  if (!rateMode && (showAccounts || windows)) {
    const base = isProjected ? model.projected : model.recorded;
    const byAccount = isProjected ? model.projectedByAccount : model.recordedByAccount;
    const idx = indexAt(base, hoverT);
    // Each account's own level, not its weighted share of the pool.
    accounts = model.accounts.map((a) => {
      const own = windows?.[a.key]?.[idx];
      return {
        label: a.label,
        v: own?.unread ? null : ((byAccount[a.key]?.[idx] ?? 0) * 100) / a.share,
        weekly: own?.weekly ?? null,
        five: own?.five ?? null,
        binding: own?.binding,
      };
    });
  }
  const near = (nearPx * (endMs - startMs)) / plotW;
  const events = markers.map((m) => m.event).filter((e) => Math.abs(e.t - hoverT) <= near);
  const overlayV = overlay && !rateMode ? valueAt(isProjected ? overlay.projected : overlay.recorded, hoverT) : null;
  return { t: hoverT, v, isProjected, accounts, windowed: !!windows, events, overlayV };
}
