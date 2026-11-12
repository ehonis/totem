/**
 * Pool chart: one provider's pooled remaining quota over the visible range.
 * Solid = recorded by the server, dashed = projected at the chosen burn rate,
 * with every reset jump labelled by how much it adds back, and a marker
 * wherever a limit ran out or the weekly limit refilled (solid, before Now) or
 * is projected to (dashed, after it).
 *
 * Zooms and pans along time inside `bounds` (usePoolChartZoom.ts); the page
 * holds the view, so every card moves together.
 *
 * Layout only; all numbers come from poolModel.ts.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { poolText } from './poolText';
import type { TimeView } from './poolZoom';
import { usePoolChartZoom } from './usePoolChartZoom';
import {
  DAY_MS,
  HOUR_MS,
  idleSpans,
  type PoolModel,
  type PoolLimitEvent,
  type PoolLimitEventKind,
  type IdleSchedule,
  type SeriesPoint,
} from './poolModel';
import {
  bandOpacity,
  EVENT_LONG_KEY,
  EVENT_PAST_KEY,
  EVENT_SHORT_KEY,
  formatPercent,
  formatRate,
  formatStamp,
} from './poolFormat';
import styles from './PoolChart.module.css';

export type PoolChartMode = 'remaining' | 'rate';

export interface PoolChartProps {
  model: PoolModel;
  mode: PoolChartMode;
  startMs: number;
  endMs: number;
  now: number;
  showAccounts: boolean;
  /** Hour columns instead of day columns, for the 5-hour view. */
  hourly?: boolean;
  /** Nightly block with no projected usage, shaded from now onward. */
  idle?: IdleSchedule;
  /** Accessible name, e.g. "Claude pool". */
  label: string;
  /** Smallest refill worth a label, in pool percent. */
  minResetLabel?: number;
  /** Which limit events, recorded and projected, get a marker. */
  eventKinds?: readonly PoolLimitEventKind[];
  /** The page's whole range; `startMs`/`endMs` are the part of it on screen. */
  bounds: TimeView;
  /** Asks the page for a new view; `null` for the whole range. */
  onViewChange: (view: TimeView | null) => void;
  /** A second pool drawn as a line on the same scale (Claude's Fable cap). */
  overlay?: { label: string; model: PoolModel } | null;
}

const HEIGHT = 380;
const M = { top: 44, right: 14, bottom: 46, left: 56 };
const LABEL_W = 44;
const LABEL_H = 16;
/** Baselines of the two marker label rows above the plot. */
const EVENT_ROWS = [M.top - 24, M.top - 7];
/** How close the crosshair has to be for the tooltip to list a marker. */
const EVENT_HOVER_PX = 8;
const EVENT_CHAR_W = 6.8;
/** Column widths for the hour axis, in minutes; each divides a day evenly. */
const HOUR_STEPS_MIN = [15, 30, 60, 180, 360, 720];
const WHOLE_PAGE_HOUR_STEPS_MIN = [180, 360];
const MIN_COLUMN_PX = 42;
/** A partial day at the view's edge narrower than this gets no label. */
const MIN_DAY_LABEL_PX = 28;

/** First index whose time is at or after `t` in a sorted series. */
function lowerBound(series: readonly { t: number }[], t: number) {
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
function windowed<T extends { t: number }>(series: readonly T[], from: number, to: number): T[] {
  if (series.length === 0) return [];
  const first = Math.max(0, lowerBound(series, from) - 1);
  const last = Math.min(series.length, lowerBound(series, to + 1) + 1);
  return series.slice(first, last);
}

type Box = { x0: number; x1: number; y0: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function niceCeil(value: number) {
  if (value <= 1) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  // Steps whose half is still a round tick label.
  for (const step of [1, 2, 4, 5, 10]) {
    if (step * exp >= value) return step * exp;
  }
  return 10 * exp;
}

/** Lookup on a sorted series; the later point wins on equal timestamps. */
function valueAt(series: SeriesPoint[], t: number): number | null {
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

const eventName = (e: PoolLimitEvent) => (e.recorded ? EVENT_PAST_KEY : EVENT_LONG_KEY)[e.kind];

function indexAt(series: SeriesPoint[], t: number) {
  let best = 0;
  for (let i = 0; i < series.length; i += 1) {
    if (series[i].t <= t) best = i;
    else break;
  }
  return best;
}

export function PoolChart({
  model,
  mode,
  startMs,
  endMs,
  now,
  showAccounts,
  hourly = false,
  idle,
  label,
  minResetLabel = 0,
  eventKinds = [],
  bounds,
  onViewChange,
  overlay = null,
}: PoolChartProps) {
  const { t, i18n } = poolText;
  const locale = i18n.resolvedLanguage;
  const gradientId = useId();
  const clipId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [hoverT, setHoverT] = useState<number | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.max(320, Math.round(el.clientWidth)));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;
  const span = endMs - startMs;
  const x = (ms: number) => M.left + ((ms - startMs) / span) * plotW;

  const zoom = usePoolChartZoom({
    wrapRef,
    view: { startMs, endMs },
    bounds,
    width,
    plotLeft: M.left,
    plotW,
    hoverT,
    setHoverT,
    onViewChange,
  });

  const rateMode = mode === 'rate';
  const recorded = rateMode ? model.recordedRate : model.recorded;
  const projected = rateMode ? model.projectedRate : model.projected;

  const yMax = useMemo(() => {
    if (!rateMode) return Math.max(100, model.capacity);
    const peak = Math.max(
      0,
      ...model.recordedRate.map((p) => p.v),
      ...model.projectedRate.map((p) => p.v)
    );
    return niceCeil(peak * 1.25 || 1);
  }, [rateMode, model]);
  const y = (v: number) => M.top + (1 - Math.max(0, Math.min(v, yMax)) / yMax) * plotH;

  const visible = (series: SeriesPoint[]) => windowed(series, startMs, endMs);
  const line = (series: SeriesPoint[]) =>
    series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join('');
  const area = (series: SeriesPoint[]) =>
    series.length < 2
      ? ''
      : `${line(series)}L${x(series[series.length - 1].t).toFixed(1)},${y(0)}L${x(series[0].t).toFixed(1)},${y(0)}Z`;

  const recordedVisible = visible(recorded);
  const projectedVisible = visible(projected);
  const shownOverlay = rateMode ? null : overlay;
  const overlayRecorded = shownOverlay ? visible(shownOverlay.model.recorded) : [];
  const overlayProjected = shownOverlay ? visible(shownOverlay.model.projected) : [];

  /* ---------- per-account stacked bands ---------- */

  const bands = useMemo(() => {
    if (!showAccounts || rateMode) return [];
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
  }, [showAccounts, rateMode, model]);

  const bandPath = (band: { t: number; lo: number; hi: number }[]) => {
    const pts = windowed(band, startMs, endMs);
    if (pts.length < 2) return '';
    const top = pts.map(
      (p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.hi).toFixed(1)}`
    );
    const bottom = [...pts].reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.lo).toFixed(1)}`);
    return `${top.join('')}${bottom.join('')}Z`;
  };

  /* ---------- reset labels ---------- */

  const resetLabels = useMemo(() => {
    if (rateMode) return [];
    const placed: Box[] = [];
    const out: {
      key: string;
      x: number;
      y: number;
      text: string;
      projected: boolean;
      title: string;
    }[] = [];
    for (const reset of model.resets) {
      if (reset.t < startMs || reset.t > endMs || reset.delta < minResetLabel) continue;
      const series = reset.projected ? model.projected : model.recorded;
      const v = valueAt(series, reset.t + 1) ?? valueAt(series, reset.t);
      if (v === null) continue;
      const cx = x(reset.t);
      const lineY = y(v);
      // The Now label and dot own the space around the present moment.
      if (now >= startMs && now <= endMs && Math.abs(cx - x(now)) < LABEL_W / 2 + 4) {
        continue;
      }
      // On a narrow chart only the bigger refills earn a label.
      if (plotW < 400 && reset.delta < 20) continue;
      // Above the line first, then tucked under it, then further up.
      const candidates = [lineY - 12, lineY + 20, lineY - 30, lineY + 38];
      let chosen: number | null = null;
      for (const cy of candidates) {
        const box = { x0: cx - LABEL_W / 2, x1: cx + LABEL_W / 2, y0: cy - LABEL_H, y1: cy + 2 };
        if (cy - LABEL_H < 6 || cy > M.top + plotH - 4) continue;
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
    // x/y depend on width and yMax, both captured via plotW/yMax.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateMode, model, startMs, endMs, plotW, yMax, locale, now, minResetLabel]);

  /* ---------- limit markers ---------- */

  const markers = useMemo(() => {
    const placed: Box[] = [];
    if (now >= startMs && now <= endMs) {
      // The Now label sits in the top row.
      placed.push({
        x0: x(now) - 20,
        x1: x(now) + 20,
        y0: EVENT_ROWS[0] - 14,
        y1: EVENT_ROWS[0] + 3,
      });
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
          e.t <= endMs
      )
      .sort((a, b) => rank(a) - rank(b) || a.t - b.t);
    const out = events.map((event: PoolLimitEvent) => {
      const cx = x(event.t);
      const text = t(EVENT_SHORT_KEY[event.kind]);
      const half = (text.length * EVENT_CHAR_W) / 2 + 4;
      let labelY: number | null = null;
      for (const row of EVENT_ROWS) {
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
    // x depends on width via plotW.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, eventKinds, startMs, endMs, now, plotW, width, t]);

  /* ---------- axes ---------- */

  // Hour columns for the 5-hour view and for any view zoomed to three days or less.
  const hourColumns = hourly || span <= 3 * DAY_MS;

  const days = useMemo(() => {
    const out: {
      /** Where the column starts on the calendar; may lie before the view. */
      t: number;
      /** The column's visible part. */
      from: number;
      end: number;
      weekday: string;
      day: string;
      weekend: boolean;
      today: boolean;
    }[] = [];
    if (hourColumns) {
      // The narrowest even step that leaves room for a label; midnight carries the date.
      // The whole 5-hour page keeps its 3- or 6-hour columns at any width.
      const steps = zoom.zoomed ? HOUR_STEPS_MIN : WHOLE_PAGE_HOUR_STEPS_MIN;
      const pxPerMin = plotW / ((endMs - startMs) / 60_000);
      const stepMin =
        steps.find((step) => step * pxPerMin >= MIN_COLUMN_PX) ?? steps[steps.length - 1];
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
  }, [startMs, endMs, now, locale, hourColumns, plotW, zoom.zoomed]);

  // Thin the day labels when days get narrow; today always keeps its label.
  const pxPerDay = plotW / Math.max(1, days.length);
  const labelEvery = hourColumns
    ? pxPerDay < 34
      ? 2
      : 1
    : pxPerDay < 18
      ? 3
      : pxPerDay < 34
        ? 2
        : 1;
  const anchor = Math.max(
    0,
    days.findIndex((day) => day.today)
  );
  const showDayLabel = (index: number) => {
    const day = days[index];
    // A sliver of a day at the view's edge would print over the axis.
    if (!hourColumns && x(day.end) - x(day.from) < MIN_DAY_LABEL_PX) return false;
    return Math.abs(index - anchor) % labelEvery === 0 || (hourColumns && day.day !== '');
  };
  const labelX = (day: (typeof days)[number]) =>
    x(hourColumns ? day.t : (day.from + day.end) / 2);

  const yTicks = [0, yMax / 2, yMax];
  const tickLabel = (v: number) =>
    rateMode ? (Number.isInteger(v) ? `${v}%/h` : formatRate(v)) : formatPercent(v);

  const nowVisible = now >= startMs && now <= endMs;
  const nowValue = rateMode ? (model.burnPerHour ?? 0) : (model.current ?? 0);

  /* ---------- hover / keyboard crosshair ---------- */

  const hover = useMemo(() => {
    if (hoverT === null || hoverT < startMs || hoverT > endMs) return null;
    const isProjected = hoverT > now;
    const series = isProjected ? projected : recorded;
    const v = valueAt(series, hoverT);
    if (v === null) return null;
    let accounts: {
      label: string;
      v: number | null;
      weekly: number | null;
      five: number | null;
      binding?: 'weekly' | 'five';
    }[] = [];
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
    const nearPx = (EVENT_HOVER_PX * span) / plotW;
    const events = markers.map((m) => m.event).filter((e) => Math.abs(e.t - hoverT) <= nearPx);
    const overlayV = shownOverlay
      ? valueAt(isProjected ? shownOverlay.model.projected : shownOverlay.model.recorded, hoverT)
      : null;
    return { t: hoverT, v, isProjected, accounts, windowed: !!windows, events, overlayV };
  }, [hoverT, startMs, endMs, now, projected, recorded, rateMode, showAccounts, model, markers, span, plotW, shownOverlay]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (zoom.onZoomKey(event)) return;
    // A zoomed view gets finer steps: about a hundredth of what is on screen.
    const base = hourly
      ? event.shiftKey
        ? HOUR_MS
        : 15 * 60_000
      : event.shiftKey
        ? DAY_MS
        : HOUR_MS;
    const step = Math.max(60_000, Math.min(base, event.shiftKey ? span / 4 : span / 96));
    const inView = (t: number) => t >= startMs && t <= endMs;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      // Start from the crosshair, else Now, else the middle of what is on screen.
      const from =
        hoverT !== null && inView(hoverT) ? hoverT : inView(now) ? now : startMs + span / 2;
      const next = Math.max(
        bounds.startMs,
        Math.min(bounds.endMs, from + (event.key === 'ArrowLeft' ? -step : step))
      );
      setHoverT(next);
      // The crosshair walks the whole range; the view follows it off either edge.
      zoom.follow(next);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHoverT(now);
      if (!inView(now) && now >= bounds.startMs && now <= bounds.endMs) zoom.centerOn(now);
    } else if (event.key === 'Escape') {
      zoom.cancelDrag();
      setHoverT(null);
    }
  };

  // Keep the whole tooltip inside the chart, however wide its rows make it.
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipW, setTooltipW] = useState(190);
  useLayoutEffect(() => {
    const w = tooltipRef.current?.offsetWidth;
    if (w && w !== tooltipW) setTooltipW(w);
  });
  const tooltipHalf = Math.min(tooltipW / 2 + 6, width / 2);
  const tooltipLeft = hover
    ? Math.min(Math.max(x(hover.t), tooltipHalf), width - tooltipHalf)
    : 0;
  const hasData = recordedVisible.length > 1 || projectedVisible.length > 1;

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      tabIndex={0}
      role="group"
      aria-label={t('quota_management.pool_chart_label', { name: label })}
      data-zoomed={zoom.zoomed ? 'true' : 'false'}
      onKeyDown={onKeyDown}
      onBlur={() => setHoverT(null)}
    >
      <svg
        className={styles.svg}
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        {...zoom.svgHandlers}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--pool-accent)" stopOpacity="0.28" />
            <stop offset="78%" stopColor="var(--pool-accent)" stopOpacity="0.02" />
          </linearGradient>
          <clipPath id={clipId}>
            <rect x={M.left} y={0} width={plotW} height={M.top + plotH} />
          </clipPath>
        </defs>

        {/* quiet hours and off days: only the projection assumes them, so shade the future */}
        {idleSpans(Math.max(startMs, now), endMs, idle ?? {}).map((span) => (
          <rect
            key={`q${span.startMs}`}
            className={styles.quietBand}
            x={x(span.startMs)}
            y={M.top}
            width={Math.max(0, x(span.endMs) - x(span.startMs))}
            height={plotH}
          />
        ))}

        {/* day columns + horizontal guides */}
        {days.filter((day) => day.t >= startMs).map((day) => (
          <line
            key={`g${day.t}`}
            className={styles.dayLine}
            x1={x(day.t)}
            x2={x(day.t)}
            y1={M.top}
            y2={M.top + plotH}
          />
        ))}
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line
              className={v === 0 ? styles.baseLine : styles.gridLine}
              x1={M.left}
              x2={M.left + plotW}
              y1={y(v)}
              y2={y(v)}
            />
            <text className={styles.yLabel} x={M.left - 10} y={y(v) + 4} textAnchor="end">
              {tickLabel(v)}
            </text>
          </g>
        ))}

        <g clipPath={`url(#${clipId})`}>
          {bands.length > 0 ? (
            bands.map((band, index) => (
              <g key={band.key} style={{ opacity: bandOpacity(index, bands.length) }}>
                <path className={styles.band} d={bandPath(band.recorded)} />
                <path
                  className={`${styles.band} ${styles.bandProjected}`}
                  d={bandPath(band.projected)}
                />
              </g>
            ))
          ) : (
            <>
              {recordedVisible.length > 1 && (
                <path d={area(recordedVisible)} fill={`url(#${gradientId})`} />
              )}
              {projectedVisible.length > 1 && (
                <path
                  d={area(projectedVisible)}
                  fill={`url(#${gradientId})`}
                  className={styles.projectedArea}
                />
              )}
            </>
          )}
          {recordedVisible.length > 1 && (
            <path className={styles.recordedLine} d={line(recordedVisible)} />
          )}
          {projectedVisible.length > 1 && (
            <path className={styles.projectedLine} d={line(projectedVisible)} />
          )}
          {overlayRecorded.length > 1 && (
            <path className={`${styles.recordedLine} ${styles.overlayLine}`} d={line(overlayRecorded)} />
          )}
          {overlayProjected.length > 1 && (
            <path className={`${styles.projectedLine} ${styles.overlayLine}`} d={line(overlayProjected)} />
          )}
        </g>

        {markers.map((marker) => (
          <g
            key={marker.key}
            className={`${styles[`event-${marker.event.kind}`]} ${marker.event.recorded ? styles.eventPast : ''}`}
          >
            <line
              className={styles.eventLine}
              x1={marker.cx}
              x2={marker.cx}
              y1={marker.labelY === null ? M.top : marker.labelY + 4}
              y2={M.top + plotH}
            />
            {marker.labelY !== null && (
              <text
                className={styles.eventLabel}
                x={marker.cx}
                y={marker.labelY}
                textAnchor="middle"
              >
                <title>
                  {`${t(eventName(marker.event))} · ${formatStamp(marker.event.t, locale)} · ${marker.event.labels.join(', ')}`}
                </title>
                {marker.text}
              </text>
            )}
          </g>
        ))}

        {resetLabels.map((label) => (
          <text
            key={label.key}
            className={label.projected ? styles.resetLabelProjected : styles.resetLabel}
            x={label.x}
            y={label.y}
            textAnchor="middle"
          >
            <title>{label.title}</title>
            {label.text}
          </text>
        ))}

        {nowVisible && (
          <g>
            <line
              className={styles.nowLine}
              x1={x(now)}
              x2={x(now)}
              y1={M.top - 14}
              y2={M.top + plotH + 4}
            />
            <text className={styles.nowLabel} x={x(now)} y={M.top - 20} textAnchor="middle">
              {t('quota_management.pool_now')}
            </text>
            {hasData && <circle className={styles.nowDot} cx={x(now)} cy={y(nowValue)} r={4.5} />}
            {shownOverlay?.model.current != null && (
              <circle
                className={`${styles.nowDot} ${styles.overlayDot}`}
                cx={x(now)}
                cy={y(shownOverlay.model.current)}
                r={3.5}
              />
            )}
          </g>
        )}

        {days.map((day, index) =>
          !showDayLabel(index) ? null : (
            <text
              key={`x${day.t}`}
              className={`${styles.xLabel} ${day.today ? styles.xLabelToday : ''}`}
              x={labelX(day)}
              y={M.top + plotH + 20}
              textAnchor="middle"
            >
              <tspan x={labelX(day)}>{day.weekday}</tspan>
              <tspan x={labelX(day)} dy={17}>
                {day.day}
              </tspan>
            </text>
          )
        )}

        {zoom.selection && (
          <rect
            className={styles.selection}
            x={Math.min(zoom.selection.from, zoom.selection.to)}
            y={M.top}
            width={Math.abs(zoom.selection.to - zoom.selection.from)}
            height={plotH}
          />
        )}

        {hover && (
          <g>
            <line
              className={styles.crosshair}
              x1={x(hover.t)}
              x2={x(hover.t)}
              y1={M.top}
              y2={M.top + plotH}
            />
            <circle className={styles.hoverDot} cx={x(hover.t)} cy={y(hover.v)} r={4} />
          </g>
        )}
      </svg>

      {!hasData && (
        <div className={styles.empty} role="status">
          {t('quota_management.pool_no_data')}
        </div>
      )}

      {hover && (
        <div
          ref={tooltipRef}
          className={styles.tooltip}
          style={{ left: tooltipLeft }}
          role="status"
          aria-live="polite"
        >
          <div className={styles.tooltipStamp}>{formatStamp(hover.t, locale)}</div>
          <div className={styles.tooltipValue}>
            <span>{rateMode ? formatRate(hover.v) : formatPercent(hover.v)}</span>
            <span className={styles.tooltipKind}>
              {hover.isProjected
                ? t('quota_management.pool_legend_projected')
                : t('quota_management.pool_legend_recorded')}
            </span>
          </div>
          {shownOverlay && hover.overlayV !== null && (
            <div className={`${styles.tooltipValue} ${styles.tooltipOverlay}`}>
              <span>{formatPercent(hover.overlayV)}</span>
              <span className={styles.tooltipKind}>{shownOverlay.label}</span>
            </div>
          )}
          {hover.events.length > 0 && (
            <ul className={styles.tooltipEvents}>
              {hover.events.map((e) => (
                <li key={`${e.kind}-${e.t}-${e.recorded ? 'r' : 'p'}`} className={styles[`event-${e.kind}`]}>
                  <span className={styles.tooltipEventName}>
                    {t(eventName(e))} · {formatStamp(e.t, locale)}
                  </span>
                  <span>{e.labels.join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
          {hover.accounts.length > 0 && hover.windowed && (
            <table className={styles.tooltipWindows}>
              {hover.accounts.some((a) => a.binding) && (
                <caption className={styles.tooltipNote}>
                  {t('quota_management.pool_tooltip_binding_note')}
                </caption>
              )}
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{t('quota_management.pool_tooltip_account')}</span>
                  </th>
                  <th scope="col">{t('quota_management.pool_tooltip_usable')}</th>
                  <th scope="col">{t('quota_management.pool_window_weekly')}</th>
                  <th scope="col">{t('quota_management.pool_window_five_hour')}</th>
                </tr>
              </thead>
              <tbody>
                {hover.accounts.map((a) => (
                  <tr key={a.label}>
                    <th scope="row">{a.label}</th>
                    <td className={styles.tooltipUsable}>{formatPercent(a.v)}</td>
                    {(['weekly', 'five'] as const).map((limit) => (
                      <td
                        key={limit}
                        className={
                          a.binding === limit
                            ? styles.tooltipBinding
                            : a.binding
                              ? styles.tooltipSlack
                              : undefined
                        }
                      >
                        {formatPercent(a[limit])}
                        {a.binding === limit && (
                          <span className="sr-only"> {t('quota_management.pool_tooltip_binding')}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {hover.accounts.length > 0 && !hover.windowed && (
            <ul className={styles.tooltipAccounts}>
              {hover.accounts.map((a) => (
                <li key={a.label}>
                  <span>{a.label}</span>
                  <span>{formatPercent(a.v)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
