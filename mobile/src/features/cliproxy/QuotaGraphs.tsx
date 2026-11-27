// The CLIProxy page's quota history and forecast: the web's QuotaGraphs and
// QuotaPoolPanel (web/src/cliproxy/pool/) for a phone. The same switches (limit,
// providers, remaining or drain rate), the same forecast settings, the same
// range row and one card per pool, each with its figures, chart and legend; the
// numbers are the web's to the digit (lib/cliproxy/pool/, the web's files).
//
// What a phone adds: each card opens sideways, full screen (LandscapeGraphs.tsx),
// where the chart has the room to read and to scrub.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import IconAdjustmentsHorizontal from '@tabler/icons-react-native/dist/esm/icons/IconAdjustmentsHorizontal.mjs'
import IconChevronDown from '@tabler/icons-react-native/dist/esm/icons/IconChevronDown.mjs'
import type { ProxyAccount } from '../../lib/cliproxy/api'
import { poolViewRange } from '../../lib/cliproxy/pool/poolModel'
import { poolCards, poolCardStats, poolRangeText, providerPoolCards, shownFable, EVENT_KINDS, type PoolCardData } from '../../lib/cliproxy/pool/poolCards'
import {
  BURN_WINDOWS, changedForecastSettings, FORECAST_DEFAULTS, FUTURE_USAGE, POOL_PROVIDER_MODES, POOL_WINDOWS, QUIET_HOURS,
  normalizeOffDays, quietHoursOf, readOffDays, readQuietHours, writeOffDays, writeQuietHours,
  type FutureUsage, type PoolSettings, type PoolWindow, type QuietHoursId,
} from '../../lib/cliproxy/pool/poolSettings'
import { formatHourOfDay } from '../../lib/cliproxy/pool/poolFormat'
import { poolText } from '../../lib/cliproxy/pool/poolText'
import { clampView, type TimeView } from '../../lib/cliproxy/pool/poolZoom'
import type { PoolLimitEventKind, RoutingStrategy } from '../../lib/cliproxy/pool/poolModel'
import type { PoolChartMode } from '../../lib/cliproxy/pool/poolChartLayout'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press, Segmented } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { Group, Notice, Picker, Row, Switch } from '../settings/ui'
import { PoolChart } from './PoolChart'
import { accentOf, CardHead, Choice, FABLE_COLOR, Legend, RangeButtons, SidewaysButton, Stats } from './parts'
import { LandscapeGraphs } from './LandscapeGraphs'
import { useQuotaHistory } from './useQuotaHistory'

const { t } = poolText
const ROUTING: readonly RoutingStrategy[] = ['soonest-reset', 'fill-first', 'round-robin']
/** Sunday first, as the chart's day columns are. */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const
const weekday = (day: number, width: 'narrow' | 'long') => new Date(2000, 0, 2 + day).toLocaleDateString(undefined, { weekday: width })
const CHART_HEIGHT = 250
/**
 * The markers each view draws on the page: the web's, less Combined's 5-hour
 * run-outs, which come every few hours and across a phone's width make a comb
 * of lines. The sideways view draws them all.
 */
const PAGE_EVENT_KINDS: Record<PoolWindow, readonly PoolLimitEventKind[]> = {
  ...EVENT_KINDS,
  combined: EVENT_KINDS.combined.filter((kind) => kind !== 'five-out'),
}
const PAGE_GUTTER = 16
const CARD_PAD = 12

export type PatchSettings = (patch: Partial<PoolSettings> | ((prev: PoolSettings) => Partial<PoolSettings>)) => void

/** Everything the graphs read: the history, the settings, the range and the cards built from them. */
export function usePoolGraphs(accounts: ProxyAccount[], active: boolean, held = false) {
  const history = useQuotaHistory(active)
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
  // The clock moves the range and rebuilds the forecast: not while a finger is on a chart.
  const heldRef = useRef(held)
  heldRef.current = held
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => { if (!heldRef.current) setNow(Date.now()) }, 60_000)
    return () => clearInterval(timer)
  }, [active])
  useEffect(() => {
    writeQuietHours(settings.quiet)
    writeOffDays(settings.offDays)
  }, [settings.quiet, settings.offDays])
  const patch: PatchSettings = useCallback(
    (p) => setSettings((prev) => ({ ...prev, ...(typeof p === 'function' ? p(prev) : p) })),
    [],
  )
  const range = useMemo(() => poolViewRange(now, settings.offset, settings.window), [now, settings.offset, settings.window])
  // Clamped on every render: the page's range moves with the clock and the pages.
  const zoomed = useMemo(() => (settings.zoom ? clampView(settings.zoom, range) : null), [settings.zoom, range])
  const view = zoomed ?? range
  const providerCards = useMemo(
    () => providerPoolCards({ accounts, samples: history.samples, now, settings, range }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, history.samples, now, settings.burnWindow, settings.future, settings.quiet, settings.offDays, settings.window, range, settings.strategy],
  )
  const cards = useMemo(() => poolCards(providerCards, settings.providers === 'combined', now), [providerCards, settings.providers, now])
  // One object while the schedule holds, so the charts' memo holds too.
  const idle = useMemo(() => ({ quietHours: quietHoursOf(settings.quiet), offDays: settings.offDays }), [settings.quiet, settings.offDays])
  return { history, now, settings, patch, range, zoomed: zoomed !== null, view, providerCards, cards, idle }
}

export type PoolGraphs = ReturnType<typeof usePoolGraphs>

/** One pool's card on the page: its head, figures, chart and legend. */
function PoolCard({ card, graphs, width, onTouching, onOpen, covered }: {
  card: PoolCardData
  graphs: PoolGraphs
  width: number
  onTouching: (on: boolean) => void
  onOpen: () => void
  /** Under the sideways view: hold a place instead of redrawing on every pinch there. */
  covered: boolean
}) {
  const { settings, now, range, view, history } = graphs
  const { name, stats } = poolCardStats(card, { window: settings.window, now, historyLoading: history.status === 'loading', locale: undefined })
  const fable = shownFable(card, settings)
  const setZoom = useCallback((zoom: TimeView | null) => graphs.patch({ zoom }), [graphs.patch])
  return (
    <View style={st.card} accessibilityLabel={t('quota_management.pool_card_label', { name })}>
      <CardHead card={card} name={name} right={<SidewaysButton name={name} onPress={onOpen} />} />
      <Stats stats={stats} />
      <View style={{ marginHorizontal: -CARD_PAD + 2, height: CHART_HEIGHT }}>
        {covered ? null : <PoolChart
          model={card.model}
          mode={settings.mode}
          hourly={settings.window === 'five-hour'}
          startMs={view.startMs}
          endMs={view.endMs}
          bounds={range}
          onViewChange={setZoom}
          now={now}
          showAccounts={settings.showAccounts}
          idle={graphs.idle}
          // Across a phone's width refill labels crowd: the page names the biggest refill in
          // each sixth of the view, and none in the combined view, where every 5-hour
          // window refills. The sideways view keeps the web's rule.
          minResetLabel={settings.window === 'combined' ? Infinity : 0}
          resetSlots={6}
          eventKinds={PAGE_EVENT_KINDS[settings.window]}
          overlay={fable ? { label: 'Fable', model: fable } : null}
          accent={accentOf(card)}
          overlayAccent={FABLE_COLOR}
          width={width + 2 * (CARD_PAD - 2)}
          height={CHART_HEIGHT}
          scrub="hold"
          onTouching={onTouching}
          label={name}
        />}
      </View>
      <Legend card={card} settings={settings} view={view} now={now} eventKinds={PAGE_EVENT_KINDS[settings.window]} />
    </View>
  )
}

/** The forecast tuning, folded away until asked for, as on the web. */
function ForecastSettings({ graphs, bandsLabel }: { graphs: PoolGraphs; bandsLabel: string }) {
  const { settings, patch } = graphs
  const [open, setOpen] = useState(false)
  const changed = changedForecastSettings(settings)
  return (
    <Group>
      <Row
        title={t('quota_management.pool_settings')}
        icon={<IconAdjustmentsHorizontal size={18} color={colors.muted} strokeWidth={1.8} />}
        value={changed ? t('quota_management.pool_settings_changed', { count: changed }) : undefined}
        accessory={<IconChevronDown size={16} color={colors.muted} style={open ? { transform: [{ rotate: '180deg' }] } : undefined} />}
        onPress={() => setOpen((o) => !o)}
        accessibilityLabel={`${t('quota_management.pool_settings')}${changed ? `, ${t('quota_management.pool_settings_changed', { count: changed })}` : ''}, ${open ? 'open' : 'closed'}`}
      />
      {open ? (
        <>
          <Row
            title={t('quota_management.pool_routing')}
            control={<Picker label={t('quota_management.pool_routing')} value={settings.strategy} onChange={(v) => patch({ strategy: v as RoutingStrategy })}
              options={ROUTING.map((value) => ({ value, label: t(`quota_management.pool_routing_${value}`) }))} />}
          />
          <Row title={t('quota_management.pool_burn_rate')} stacked>
            <Segmented
              value={String(settings.burnWindow)}
              onChange={(v) => patch({ burnWindow: Number(v) as PoolSettings['burnWindow'] })}
              options={BURN_WINDOWS.map((hours) => ({ value: String(hours), label: `${hours}h` }))}
            />
          </Row>
          <Row
            title={t('quota_management.pool_future')}
            control={<Picker label={t('quota_management.pool_future')} value={settings.future} onChange={(v) => patch({ future: v as FutureUsage })}
              options={FUTURE_USAGE.map((value) => ({ value, label: t(`quota_management.pool_future_${value}`) }))} />}
          />
          <Row
            title={t('quota_management.pool_quiet')}
            control={<Picker label={t('quota_management.pool_quiet')} value={settings.quiet} onChange={(v) => patch({ quiet: v as QuietHoursId })}
              options={QUIET_HOURS.map((value) => {
                const hours = quietHoursOf(value)
                return {
                  value,
                  label: hours
                    ? t('quota_management.pool_quiet_range', { from: formatHourOfDay(hours.startHour), to: formatHourOfDay(hours.endHour) })
                    : t('quota_management.pool_quiet_off'),
                }
              })} />}
          />
          <Row title={t('quota_management.pool_off_days')} stacked>
            <View style={st.days} accessibilityRole="none">
              {WEEKDAYS.map((day) => {
                const on = settings.offDays.includes(day)
                return (
                  <Press
                    key={day}
                    haptic
                    onPress={() => patch((prev) => ({ offDays: normalizeOffDays(on ? prev.offDays.filter((d) => d !== day) : [...prev.offDays, day]) }))}
                    accessibilityRole="switch"
                    accessibilityLabel={weekday(day, 'long')}
                    accessibilityState={{ checked: on }}
                    style={[st.day, on && st.dayOn]}
                  >
                    <T size={13.5} weight={on ? 600 : 400} color={on ? colors.text : colors.muted}>{weekday(day, 'narrow')}</T>
                  </Press>
                )
              })}
            </View>
          </Row>
          <Row
            title={bandsLabel}
            description={settings.mode !== 'remaining' ? t('quota_management.pool_bands_remaining_only') : undefined}
            disabled={settings.mode !== 'remaining'}
            control={<Switch label={bandsLabel} value={settings.showAccounts} disabled={settings.mode !== 'remaining'} onChange={(showAccounts) => patch({ showAccounts })} />}
          />
          <Row
            title={t('quota_management.pool_settings_reset')}
            tone={changed ? 'accent' : undefined}
            disabled={changed === 0}
            onPress={changed ? () => { tap(); patch(FORECAST_DEFAULTS) } : undefined}
          />
        </>
      ) : null}
    </Group>
  )
}

/** The three view switches, the providers one only when there are two to add. */
function ViewSwitches({ graphs, providerCount }: { graphs: PoolGraphs; providerCount: number }) {
  const { settings, patch } = graphs
  return (
    <View style={{ gap: 8 }}>
      <Segmented<PoolWindow>
        value={settings.window}
        onChange={(window) => patch({ window, offset: 0, zoom: null })}
        options={POOL_WINDOWS.map((value) => ({
          value,
          label: t(value === 'weekly' ? 'quota_management.pool_window_weekly' : value === 'five-hour' ? 'quota_management.pool_window_five_hour' : 'quota_management.pool_window_combined'),
        }))}
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {providerCount > 1 ? (
          <Choice
            fill
            label={t('quota_management.pool_providers')}
            value={settings.providers}
            onChange={(providers) => patch({ providers })}
            options={POOL_PROVIDER_MODES.map((value) => ({ value, label: t(`quota_management.pool_providers_${value}`) }))}
          />
        ) : null}
        <Choice<PoolChartMode>
          fill
          label={t('quota_management.pool_view')}
          value={settings.mode}
          onChange={(mode) => patch({ mode })}
          options={[
            { value: 'remaining', label: t('quota_management.pool_mode_remaining') },
            { value: 'rate', label: t('quota_management.pool_mode_rate') },
          ]}
        />
      </View>
    </View>
  )
}

export function QuotaGraphs({ graphs, onTouching }: {
  graphs: PoolGraphs
  /** The page stops scrolling while a finger works a chart. */
  onTouching: (on: boolean) => void
}) {
  const { width } = useWindowDimensions()
  const { history, settings, cards, providerCards, range, view, zoomed } = graphs
  const [sideways, setSideways] = useState<PoolCardData['type'] | null>(null)
  const cardWidth = Math.min(width, 720) - PAGE_GUTTER * 2 - CARD_PAD * 2
  const rangeText = poolRangeText({ window: settings.window, range, view, zoomed })
  if (cards.length === 0) return null
  return (
    <View style={{ gap: 12 }}>
      <T size={17} weight={600} style={{ paddingHorizontal: 4 }}>Quota history and forecast</T>
      {history.status === 'unsupported' ? <Notice>This proxy has no quota history endpoint. Showing current readings and forecast.</Notice> : null}
      {history.status === 'ready' && !history.samples.length ? (
        <Notice>No recorded quota history yet. The forecast gains a burn rate as readings accumulate.</Notice>
      ) : null}
      {settings.providers === 'combined' && providerCards.some((c) => c.model.recorded.length > 0) && providerCards.some((c) => c.model.recorded.length === 0) ? (
        <Notice>Combined history needs recorded readings for every provider. Showing current readings and forecast.</Notice>
      ) : null}
      {history.status === 'error' ? (
        <Notice tone="warn">
          {`History unavailable: ${history.error}`}
        </Notice>
      ) : null}
      {history.status === 'error' ? <Btn compact title="Retry history" onPress={() => { void history.reload() }} style={{ alignSelf: 'flex-start' }} /> : null}

      <ViewSwitches graphs={graphs} providerCount={providerCards.length} />
      <ForecastSettings graphs={graphs} bandsLabel={cards.some((c) => c.type === 'all') ? t('quota_management.pool_providers_toggle') : t('quota_management.pool_accounts_toggle')} />

      <View style={st.rangeRow}>
        <T size={12.5} color={colors.muted} numberOfLines={1} accessibilityLiveRegion="polite">{rangeText}</T>
        <RangeButtons settings={settings} range={range} view={view} zoomed={zoomed} onChange={graphs.patch} />
      </View>

      {cards.map((card) => (
        <PoolCard key={card.type} card={card} graphs={graphs} width={cardWidth} onTouching={onTouching} onOpen={() => setSideways(card.type)} covered={sideways !== null} />
      ))}

      <T size={12} color={colors.muted} lineHeight={17} style={{ paddingHorizontal: 4 }}>
        Forecasts use the selected routing and recent burn rate. Weekly-exhausted accounts add no usable 5-hour capacity until their
        weekly reset. Touch and hold a chart, then drag, to read it; pinch to zoom, double tap to zoom back out. Turn a chart sideways
        with its Sideways button.
      </T>

      {sideways ? (
        <LandscapeGraphs graphs={graphs} initial={sideways} onClose={() => { onTouching(false); setSideways(null) }} onTouching={onTouching} />
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  card: { gap: 12, padding: CARD_PAD, paddingTop: 14, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.bg2 },
  rangeRow: { gap: 8, paddingHorizontal: 4 },
  days: { flexDirection: 'row', gap: 6 },
  day: { flex: 1, height: 36, borderRadius: 9, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  dayOn: { backgroundColor: colors.bg3, borderColor: colors.muted },
})
