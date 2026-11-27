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
} from './poolModel';
import {
  bandOpacity,
  EVENT_LONG_KEY,
  EVENT_PAST_KEY,
  formatPercent,
  formatRate,
  formatStamp,
} from './poolFormat';
import {
  accountBands,
  areaPath,
  bandPath,
  chartFrame,
  chartYMax,
  columnLabels,
  hoverReading,
  linePath,
  placeMarkers,
  placeResetLabels,
  timeColumns,
  usesHourColumns,
  windowed,
  type PoolChartMode,
} from './poolChartLayout';
import styles from './PoolChart.module.css';

export type { PoolChartMode };

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
/** Baselines of the two marker label rows above the plot. */
const EVENT_ROWS = [M.top - 24, M.top - 7];

const eventName = (e: PoolLimitEvent) => (e.recorded ? EVENT_PAST_KEY : EVENT_LONG_KEY)[e.kind];

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

  const rateMode = mode === 'rate';
  const yMax = useMemo(() => chartYMax(model, rateMode), [rateMode, model]);
  const frame = useMemo(
    () => chartFrame({ startMs, endMs, width, height: HEIGHT, margin: M, yMax }),
    [startMs, endMs, width, yMax],
  );
  const { plotW, plotH, x, y } = frame;
  const span = endMs - startMs;

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

  const recorded = rateMode ? model.recordedRate : model.recorded;
  const projected = rateMode ? model.projectedRate : model.projected;

  const visible = (series: typeof recorded) => windowed(series, startMs, endMs);
  const line = (series: typeof recorded) => linePath(frame, series);
  const area = (series: typeof recorded) => areaPath(frame, series);

  const recordedVisible = visible(recorded);
  const projectedVisible = visible(projected);
  const shownOverlay = rateMode ? null : overlay;
  const overlayRecorded = shownOverlay ? visible(shownOverlay.model.recorded) : [];
  const overlayProjected = shownOverlay ? visible(shownOverlay.model.projected) : [];

  const bands = useMemo(
    () => (!showAccounts || rateMode ? [] : accountBands(model)),
    [showAccounts, rateMode, model],
  );

  const resetLabels = useMemo(
    () => (rateMode ? [] : placeResetLabels(model, frame, { now, minResetLabel, locale })),
    [rateMode, model, frame, now, minResetLabel, locale],
  );

  const markers = useMemo(
    () => placeMarkers(model, frame, { now, eventKinds, rows: EVENT_ROWS }),
    [model, frame, now, eventKinds],
  );

  const hourColumns = usesHourColumns(hourly, span);
  const days = useMemo(
    () => timeColumns({ startMs, endMs, now, locale, hourColumns, zoomed: zoom.zoomed, plotW }),
    [startMs, endMs, now, locale, hourColumns, plotW, zoom.zoomed],
  );
  const dayLabels = useMemo(() => columnLabels(days, frame, hourColumns), [days, frame, hourColumns]);

  const yTicks = [0, yMax / 2, yMax];
  const tickLabel = (v: number) =>
    rateMode ? (Number.isInteger(v) ? `${v}%/h` : formatRate(v)) : formatPercent(v);

  const nowVisible = now >= startMs && now <= endMs;
  const nowValue = rateMode ? (model.burnPerHour ?? 0) : (model.current ?? 0);

  /* ---------- hover / keyboard crosshair ---------- */

  const hover = useMemo(
    () =>
      hoverReading({
        model,
        frame,
        hoverT,
        now,
        rateMode,
        showAccounts,
        markers,
        overlay: shownOverlay?.model ?? null,
      }),
    [model, frame, hoverT, now, rateMode, showAccounts, markers, shownOverlay],
  );

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
                <path className={styles.band} d={bandPath(frame, band.recorded)} />
                <path
                  className={`${styles.band} ${styles.bandProjected}`}
                  d={bandPath(frame, band.projected)}
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

        {dayLabels.map(({ column: day, x: labelX }) => (
          <text
            key={`x${day.t}`}
            className={`${styles.xLabel} ${day.today ? styles.xLabelToday : ''}`}
            x={labelX}
            y={M.top + plotH + 20}
            textAnchor="middle"
          >
            <tspan x={labelX}>{day.weekday}</tspan>
            <tspan x={labelX} dy={17}>
              {day.day}
            </tspan>
          </text>
        ))}

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
