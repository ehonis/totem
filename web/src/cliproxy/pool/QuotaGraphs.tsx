import { useMemo, useState, useEffect } from 'react'
import type { ProxyAccount } from '../api'
import { poolInputsFor, POOL_PROVIDERS, type PooledLimit } from './poolInputs'
import { buildLinkedPoolModels, fiveHourWindowsLeft } from './poolLinked'
import { mergePoolModels } from './poolMerge'
import { buildPoolModel, DAY_MS, poolViewRange, type PoolModel } from './poolModel'
import {
  FORECAST_DEFAULTS,
  FUTURE_FACTOR,
  quietHoursOf,
  readQuietHours,
  readOffDays,
  writeOffDays,
  writeQuietHours,
  type PoolSettings,
} from './poolSettings'
import { QuotaPoolPanel, type PoolCardData } from './QuotaPoolPanel'
import { useQuotaHistory } from './useQuotaHistory'
import { clampView } from './poolZoom'

function withoutRecordedHistory(model: PoolModel): PoolModel {
  return {
    ...model,
    recorded: [],
    recordedByAccount: {},
    recordedRate: [],
    burnPerHour: null,
    resets: model.resets.filter((r) => r.projected),
    limitEvents: model.limitEvents.filter((e) => !e.recorded),
    windowsByAccount: model.windowsByAccount && { ...model.windowsByAccount, recorded: {} },
  }
}

export function QuotaGraphs({
  accounts,
  onAuthError,
}: {
  accounts: ProxyAccount[]
  onAuthError: () => void
}) {
  const history = useQuotaHistory(true, onAuthError)
  const [now, setNow] = useState(Date.now)
  const [settings, setSettings] = useState<PoolSettings>(() => ({
    ...FORECAST_DEFAULTS,
    mode: 'remaining',
    window: 'five-hour',
    quiet: readQuietHours(),
    offDays: readOffDays(),
    providers: 'separate',
    offset: 0,
    zoom: null,
  }))
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    writeQuietHours(settings.quiet)
    writeOffDays(settings.offDays)
  }, [settings.quiet, settings.offDays])
  const range = useMemo(
    () => poolViewRange(now, settings.offset, settings.window),
    [now, settings.offset, settings.window],
  )
  // Clamped on every render: the page's range moves with the clock and the pages.
  const zoomed = useMemo(
    () => (settings.zoom ? clampView(settings.zoom, range) : null),
    [settings.zoom, range],
  )
  const view = zoomed ?? range
  const providerCards = useMemo<PoolCardData[]>(
    () =>
      POOL_PROVIDERS.map((type) => {
        const inputs = (limit: PooledLimit) => poolInputsFor(type, accounts, history.samples, limit)
        const options = {
          now,
          burnWindowHours: settings.burnWindow,
          futureFactor: FUTURE_FACTOR[settings.future],
          quietHours: quietHoursOf(settings.quiet),
          offDays: settings.offDays,
          strategy: settings.strategy,
          recordedFromMs: Math.min(range.startMs, now),
          projectToMs: Math.min(range.endMs, now + 21 * DAY_MS),
        }
        const linked = buildLinkedPoolModels(inputs('weekly'), inputs('five-hour'), options)
        // Fable's own weekly cap, projected at its own burn rate.
        const fableInputs = type === 'claude' ? inputs('fable') : []
        const fable = fableInputs.some((a) => a.remaining !== null || a.samples.length > 0)
          ? buildPoolModel(fableInputs, options)
          : null
        const display = (model: PoolModel): PoolModel =>
          history.samples.some((s) => s.provider === type)
            ? model
            : withoutRecordedHistory(model)
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
        }
      }).filter((card) => card.model.accountCount > 0),
    [
      accounts,
      history.samples,
      now,
      settings.burnWindow,
      settings.future,
      settings.quiet,
      settings.offDays,
      settings.window,
      range,
      settings.strategy,
    ],
  )
  const cards = useMemo<PoolCardData[]>(() => {
    if (settings.providers !== 'combined' || providerCards.length < 2) return providerCards
    const combine = (pick: (c: PoolCardData) => PoolModel) => {
      const parts = providerCards.map((c) => ({
        key: c.type,
        label: c.type === 'claude' ? 'Claude' : 'Codex',
        model: pick(c),
      }))
      const combined = mergePoolModels(parts, now)
      return parts.some((p) => !p.model.recorded.length)
        ? withoutRecordedHistory(combined)
        : combined
    }
    const windows = providerCards.map((c) => c.windowsLeft)
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
    ]
  }, [providerCards, settings.providers, now])
  return (
    <div className="cp-graphs">
      <h2 className="cp-graph-title">Quota history and forecast</h2>
      {history.status === 'unsupported' && (
        <p className="cp-note">
          This proxy has no quota history endpoint. Showing current readings and forecast.
        </p>
      )}
      {history.status === 'ready' && !history.samples.length && (
        <p className="cp-note">
          No recorded quota history yet. The forecast gains a burn rate as readings accumulate.
        </p>
      )}
      {settings.providers === 'combined' &&
        providerCards.some((c) => c.model.recorded.length > 0) &&
        providerCards.some((c) => c.model.recorded.length === 0) && (
          <p className="cp-note">
            Combined history needs recorded readings for every provider. Showing current readings and forecast.
          </p>
        )}
      {history.status === 'error' && (
        <div className="cp-banner bad" role="status">
          History unavailable: {history.error}
          <button type="button" className="btn compact" onClick={history.reload}>
            Retry history
          </button>
        </div>
      )}
      <QuotaPoolPanel
        settings={settings}
        onSettingsChange={(patch) =>
          setSettings((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }))
        }
        cards={cards}
        range={range}
        view={view}
        zoomed={zoomed !== null}
        now={now}
        resolvedTheme="dark"
        historyLoading={history.status === 'loading'}
        providerCount={providerCards.length}
      />
      <p className="cp-note">
        Forecasts use the selected routing and recent burn rate. Weekly-exhausted accounts add no usable
        5-hour capacity until their weekly reset. Drag across a chart to zoom in, or pinch on a phone;
        double-click zooms back out.
      </p>
    </div>
  )
}
