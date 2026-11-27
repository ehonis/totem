import { useMemo, useState, useEffect } from 'react'
import type { ProxyAccount } from '../api'
import { poolViewRange } from './poolModel'
import {
  FORECAST_DEFAULTS,
  readQuietHours,
  readOffDays,
  writeOffDays,
  writeQuietHours,
  type PoolSettings,
} from './poolSettings'
import { QuotaPoolPanel } from './QuotaPoolPanel'
import { poolCards, providerPoolCards, type PoolCardData } from './poolCards'
import { useQuotaHistory } from './useQuotaHistory'
import { clampView } from './poolZoom'

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
    () => providerPoolCards({ accounts, samples: history.samples, now, settings, range }),
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
  const cards = useMemo<PoolCardData[]>(
    () => poolCards(providerCards, settings.providers === 'combined', now),
    [providerCards, settings.providers, now],
  )
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
