/**
 * What the quota graphs show, apart from drawing it: one card per pooled
 * provider (or one for every provider added together) with its model, the
 * range line above the charts, and each card's figures and legend text.
 * QuotaGraphs.tsx and QuotaPoolPanel.tsx draw it on the dashboard; the iPhone
 * app draws the same cards from a byte-for-byte copy
 * (mobile/src/lib/cliproxy/pool/).
 */

import type { ProxyAccount, ProxyHistorySample } from '../api';
import { poolInputsFor, POOL_PROVIDERS, type PooledLimit, type PoolProvider } from './poolInputs';
import { buildLinkedPoolModels, fiveHourWindowsLeft, type WindowRatio } from './poolLinked';
import { mergePoolModels } from './poolMerge';
import { buildPoolModel, DAY_MS, type PoolLimitEventKind, type PoolModel } from './poolModel';
import { FUTURE_FACTOR, quietHoursOf, type PoolSettings, type PoolWindow } from './poolSettings';
import type { TimeView } from './poolZoom';
import { formatClock, formatMonthDay, formatPercent, formatRate, formatWhen } from './poolFormat';
import { poolText } from './poolText';

export interface PoolCardData {
  /** A provider, or 'all' for every provider added into one pool. */
  type: PoolProvider | 'all';
  /** The model for the selected view. */
  model: PoolModel;
  /** The weekly model, for the combined view's "weekly runs out" figure. */
  weekly: PoolModel;
  /** Full 5-hour windows the remaining weekly limit still buys. */
  windowsLeft: number | null;
  /** Weekly-to-5-hour exchange rate per provider. */
  ratios: { type: PoolProvider; ratio: WindowRatio }[];
  /** Claude's weekly Fable cap as its own pool, when any seat reports one. */
  fable?: PoolModel | null;
}

/** Limit markers per view: 5-hour run-outs repeat too often for the two-week chart. */
export const EVENT_KINDS: Record<PoolWindow, readonly PoolLimitEventKind[]> = {
  weekly: ['weekly-out', 'weekly-reset'],
  'five-hour': ['five-out', 'weekly-out', 'weekly-reset'],
  combined: ['five-out', 'weekly-out', 'weekly-reset'],
};

export const ACCENTS: Record<PoolProvider | 'all', { dark: string; light: string }> = {
  claude: { dark: '#ef7f63', light: '#d4593b' },
  codex: { dark: '#9b95ff', light: '#5b54e0' },
  all: { dark: '#5cc8b2', light: '#1d8572' },
};
/** The Fable line: blue, which no other line or marker on the chart uses. */
export const FABLE_ACCENT = { dark: '#6cb4ff', light: '#1f6fd1' };

export const providerLabel = (type: string) =>
  type === 'claude' ? 'Claude' : type === 'codex' ? 'Codex' : type;

export function withoutRecordedHistory(model: PoolModel): PoolModel {
  return {
    ...model,
    recorded: [],
    recordedByAccount: {},
    recordedRate: [],
    burnPerHour: null,
    resets: model.resets.filter((r) => r.projected),
    limitEvents: model.limitEvents.filter((e) => !e.recorded),
    windowsByAccount: model.windowsByAccount && { ...model.windowsByAccount, recorded: {} },
  };
}

type ForecastInputs = Pick<
  PoolSettings,
  'window' | 'burnWindow' | 'future' | 'quiet' | 'offDays' | 'strategy'
>;

/** One card per provider with a pool, for the selected view. */
export function providerPoolCards({
  accounts,
  samples,
  now,
  settings,
  range,
}: {
  accounts: ProxyAccount[];
  samples: ProxyHistorySample[];
  now: number;
  settings: ForecastInputs;
  range: TimeView;
}): PoolCardData[] {
  return POOL_PROVIDERS.map((type): PoolCardData => {
    const inputs = (limit: PooledLimit) => poolInputsFor(type, accounts, samples, limit);
    const options = {
      now,
      burnWindowHours: settings.burnWindow,
      futureFactor: FUTURE_FACTOR[settings.future],
      quietHours: quietHoursOf(settings.quiet),
      offDays: settings.offDays,
      strategy: settings.strategy,
      recordedFromMs: Math.min(range.startMs, now),
      projectToMs: Math.min(range.endMs, now + 21 * DAY_MS),
    };
    const linked = buildLinkedPoolModels(inputs('weekly'), inputs('five-hour'), options);
    // Fable's own weekly cap, projected at its own burn rate.
    const fableInputs = type === 'claude' ? inputs('fable') : [];
    const fable = fableInputs.some((a) => a.remaining !== null || a.samples.length > 0)
      ? buildPoolModel(fableInputs, options)
      : null;
    const display = (model: PoolModel): PoolModel =>
      samples.some((s) => s.provider === type) ? model : withoutRecordedHistory(model);
    return {
      type,
      model: display(
        settings.window === 'weekly'
          ? linked.weekly
          : settings.window === 'five-hour'
            ? linked.fiveHour
            : linked.combined,
      ),
      weekly: display(linked.weekly),
      windowsLeft: fiveHourWindowsLeft(linked),
      ratios: [{ type, ratio: linked.ratio }],
      fable: fable && display(fable),
    };
  }).filter((card) => card.model.accountCount > 0);
}

/** The provider cards, or one card adding them together when `together` and there are two. */
export function poolCards(providerCards: PoolCardData[], together: boolean, now: number): PoolCardData[] {
  if (!together || providerCards.length < 2) return providerCards;
  const combine = (pick: (c: PoolCardData) => PoolModel) => {
    const parts = providerCards.map((c) => ({
      key: c.type,
      label: providerLabel(c.type),
      model: pick(c),
    }));
    const combined = mergePoolModels(parts, now);
    return parts.some((p) => !p.model.recorded.length) ? withoutRecordedHistory(combined) : combined;
  };
  const windows = providerCards.map((c) => c.windowsLeft);
  return [
    {
      type: 'all',
      model: combine((c) => c.model),
      weekly: combine((c) => c.weekly),
      windowsLeft: windows.every((w) => w === null)
        ? null
        : windows.reduce<number>((sum, w) => sum + (w ?? 0), 0),
      ratios: providerCards.flatMap((c) => c.ratios),
    },
  ];
}

/** The range line: the zoomed stretch, the 5-hour page's hours, or the page's days. */
export function poolRangeText({
  window,
  range,
  view,
  zoomed,
  locale,
}: {
  window: PoolWindow;
  range: TimeView;
  view: TimeView;
  zoomed: boolean;
  locale?: string;
}) {
  const { t } = poolText;
  const stamp = (ms: number) => `${formatMonthDay(ms, locale)} ${formatClock(ms, locale)}`;
  if (zoomed) return t('quota_management.pool_range', { from: stamp(view.startMs), to: stamp(view.endMs) });
  if (window === 'five-hour')
    return t('quota_management.pool_range', { from: stamp(range.startMs), to: stamp(range.endMs) });
  return t('quota_management.pool_range', {
    from: formatMonthDay(range.startMs, locale),
    to: formatMonthDay(range.endMs - DAY_MS, locale),
  });
}

export interface PoolStat {
  label: string;
  value: string;
  /** Said first, in bold: what the next reset adds back. */
  lead?: string;
  /** A run-out worth noticing. */
  warn?: boolean;
}

/**
 * A card's name and its four figures: when the pool and the first account run
 * out, the next reset and the burn rate; in the combined view, lockouts, the
 * weekly run-out and the 5-hour windows the weekly limit still buys.
 */
export function poolCardStats(
  card: PoolCardData,
  { window, now, historyLoading, locale }: { window: PoolWindow; now: number; historyLoading: boolean; locale?: string },
): { name: string; stats: PoolStat[] } {
  const { t } = poolText;
  const { model } = card;
  const name = card.type === 'all' ? t('quota_management.pool_all_providers') : providerLabel(card.type);
  const runsOut = (m: PoolModel) =>
    m.poolEmptyAtMs
      ? formatWhen(m.poolEmptyAtMs, now, locale)
      : t('quota_management.pool_not_by', { date: formatMonthDay(m.horizonEndMs, locale) });
  const first = (none: string) =>
    model.firstEmpty ? `${model.firstEmpty.label} · ${formatWhen(model.firstEmpty.t, now, locale)}` : t(none);
  if (window === 'combined') {
    return {
      name,
      stats: [
        { label: t('quota_management.pool_locked_out'), value: runsOut(model), warn: !!model.poolEmptyAtMs },
        {
          label: t('quota_management.pool_first_lockout'),
          value: first('quota_management.pool_no_lockout'),
          warn: !!model.firstEmpty,
        },
        {
          label: t('quota_management.pool_weekly_runs_out'),
          value: runsOut(card.weekly),
          warn: !!card.weekly.poolEmptyAtMs,
        },
        {
          label: t('quota_management.pool_windows_left'),
          value:
            card.windowsLeft === null
              ? '--'
              : t('quota_management.pool_windows_left_value', {
                  value: card.windowsLeft < 10 ? card.windowsLeft.toFixed(1) : Math.round(card.windowsLeft),
                }),
        },
      ],
    };
  }
  return {
    name,
    stats: [
      { label: t('quota_management.pool_empty'), value: runsOut(model), warn: !!model.poolEmptyAtMs },
      {
        label: t('quota_management.pool_first_empty'),
        value: first('quota_management.pool_none_before_reset'),
        warn: !!model.firstEmpty,
      },
      model.nextReset
        ? {
            label: t('quota_management.pool_next_reset'),
            lead: `+${Math.round(model.nextReset.delta)}%`,
            value: formatWhen(model.nextReset.t, now, locale),
          }
        : { label: t('quota_management.pool_next_reset'), value: t('quota_management.pool_no_reset') },
      {
        label: t('quota_management.pool_burn', { hours: model.burnWindowHours }),
        value: historyLoading && model.burnPerHour === null ? '…' : formatRate(model.burnPerHour),
      },
    ],
  };
}

/** The legend's heading, and the note under it: how the projection counts and the weekly/5-hour exchange rate. */
export function poolLegendText(card: PoolCardData, settings: Pick<PoolSettings, 'mode' | 'window'>) {
  const { t } = poolText;
  const { model } = card;
  const combinedView = settings.window === 'combined';
  const title =
    settings.mode === 'rate'
      ? t('quota_management.pool_legend_rate')
      : combinedView
        ? t('quota_management.pool_legend_usable')
        : t('quota_management.pool_legend_pool');
  const ratioNote = card.ratios
    .map(({ type, ratio }) =>
      t(ratio.source === 'history' ? 'quota_management.pool_ratio_history' : 'quota_management.pool_ratio_assumed', {
        name: card.ratios.length > 1 ? `${providerLabel(type)}: ` : '',
        value: ratio.value < 10 ? ratio.value.toFixed(1) : Math.round(ratio.value),
      }),
    )
    .join(' · ');
  const burn =
    !combinedView || settings.mode === 'rate' || !model.burnPerHour
      ? ''
      : ` · ${t('quota_management.pool_burn', { hours: model.burnWindowHours })} ${formatRate(model.burnPerHour)}`;
  return { title, note: `${t('quota_management.pool_linked_note')}${burn} · ${ratioNote}` };
}

/** The Fable cap, when it shares this view: weekly and combined, remaining only. */
export function shownFable(card: PoolCardData, settings: Pick<PoolSettings, 'mode' | 'window'>) {
  return card.fable && settings.window !== 'five-hour' && settings.mode === 'remaining' ? card.fable : null;
}

/** The marker kinds this view draws that have a marker inside `view`, for the legend. */
export function shownEventKinds(model: PoolModel, window: PoolWindow, view: TimeView, now: number) {
  return EVENT_KINDS[window].filter((kind) =>
    model.limitEvents.some(
      (e) =>
        e.kind === kind &&
        (e.recorded ? e.t <= now : e.t > now) &&
        e.t >= view.startMs &&
        e.t <= view.endMs,
    ),
  );
}

/** "Claude 40% of 150%": the card's big number. */
export const poolHeadline = (model: PoolModel) => ({
  current: formatPercent(model.current),
  of: poolText.t('quota_management.pool_of', { total: formatPercent(model.capacity) }),
});
