// Pieces the CLIProxy page's graphs share between the page and the sideways
// view: a card's head and figures, its legend, and the range row's buttons.
// The words and numbers all come from lib/cliproxy/pool/poolCards.ts, the web's.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import IconChevronLeft from '@tabler/icons-react-native/dist/esm/icons/IconChevronLeft.mjs'
import IconChevronRight from '@tabler/icons-react-native/dist/esm/icons/IconChevronRight.mjs'
import IconZoomIn from '@tabler/icons-react-native/dist/esm/icons/IconZoomIn.mjs'
import IconZoomOut from '@tabler/icons-react-native/dist/esm/icons/IconZoomOut.mjs'
import IconZoomReset from '@tabler/icons-react-native/dist/esm/icons/IconZoomReset.mjs'
import IconDeviceMobileRotated from '@tabler/icons-react-native/dist/esm/icons/IconDeviceMobileRotated.mjs'
import { ACCENTS, FABLE_ACCENT, poolHeadline, poolLegendText, shownEventKinds, shownFable, type PoolCardData } from '../../lib/cliproxy/pool/poolCards'
import { bandOpacity, EVENT_LONG_KEY, formatPercent } from '../../lib/cliproxy/pool/poolFormat'
import { OFFSET_LIMITS, type PoolSettings } from '../../lib/cliproxy/pool/poolSettings'
import { poolText } from '../../lib/cliproxy/pool/poolText'
import { MIN_ZOOM_SPAN_MS, stepZoomedView, zoomView, ZOOM_STEP, type TimeView } from '../../lib/cliproxy/pool/poolZoom'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { IconBtn, Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { ProviderLogo } from '../chat/ui'
import { CHART_COLORS, EVENT_COLOR } from './PoolChart'
import type { PoolLimitEventKind } from '../../lib/cliproxy/pool/poolModel'

export const accentOf = (card: PoolCardData) => ACCENTS[card.type].dark
export const FABLE_COLOR = FABLE_ACCENT.dark

/** One logo, or each provider's for the card that adds them together. */
export function CardLogo({ card, size = 18 }: { card: PoolCardData; size?: number }) {
  if (card.type !== 'all') return <ProviderLogo driver={card.type} size={size} />
  return (
    <View style={{ flexDirection: 'row' }}>
      {card.ratios.map(({ type }, i) => (
        <View key={type} style={i ? { marginLeft: -size / 3 } : undefined}><ProviderLogo driver={type} size={size} /></View>
      ))}
    </View>
  )
}

/** "Claude · 2 accounts" over "40% of 150%". */
export function CardHead({ card, name, right }: { card: PoolCardData; name: string; right?: React.ReactNode }) {
  const headline = poolHeadline(card.model)
  return (
    <View style={st.head}>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <View style={st.titleRow}>
          <CardLogo card={card} />
          <T size={16} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>{name}</T>
          <T size={12.5} muted numberOfLines={1}>{poolText.t('quota_management.pool_accounts', { count: card.model.accountCount })}</T>
        </View>
        <View style={st.bigRow}>
          <T size={30} weight={600} lineHeight={34} style={st.num}>{headline.current}</T>
          <T size={13} muted>{headline.of}</T>
        </View>
      </View>
      {right}
    </View>
  )
}

/** The card's four figures, two to a row. */
export function Stats({ stats }: { stats: { label: string; value: string; lead?: string; warn?: boolean }[] }) {
  return (
    <View style={st.stats}>
      {stats.map((s) => (
        <View key={s.label} style={st.stat}>
          <T size={11.5} muted numberOfLines={1}>{s.label}</T>
          <T size={13.5} numberOfLines={2} style={st.num}>
            {s.lead ? <T size={13.5} weight={700}>{`${s.lead} `}</T> : null}
            <T size={13.5} color={s.warn ? colors.amber : colors.text}>{s.value}</T>
          </T>
        </View>
      ))}
    </View>
  )
}

function Swatch({ kind, color, opacity = 1 }: { kind: 'solid' | 'dashed' | 'band' | 'quiet' | 'event'; color: string; opacity?: number }) {
  if (kind === 'dashed') {
    return (
      <View style={st.swatchDashed}>
        {[0, 1, 2].map((i) => <View key={i} style={{ width: 4, height: 2, backgroundColor: color }} />)}
      </View>
    )
  }
  if (kind === 'event') return <View style={{ width: 2, height: 11, backgroundColor: color }} />
  if (kind === 'band' || kind === 'quiet') return <View style={{ width: 12, height: 10, borderRadius: 2, backgroundColor: color, opacity }} />
  return <View style={{ width: 14, height: 2, borderRadius: 1, backgroundColor: color }} />
}

function Key({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <View style={st.key}>
      {swatch}
      <T size={11.5} color={CHART_COLORS.secondary} numberOfLines={1}>{label}</T>
    </View>
  )
}

/** What the lines, bands and markers mean, and how the projection counts. */
export function Legend({ card, settings, view, now, eventKinds }: {
  card: PoolCardData
  settings: PoolSettings
  view: TimeView
  now: number
  /** The marker kinds its chart draws. */
  eventKinds: readonly PoolLimitEventKind[]
}) {
  const { t } = poolText
  const accent = accentOf(card)
  const legend = poolLegendText(card, settings)
  const fable = shownFable(card, settings)
  const events = shownEventKinds(card.model, settings.window, view, now).filter((kind) => eventKinds.includes(kind))
  return (
    <View style={{ gap: 6 }}>
      <View style={st.keys}>
        <T size={11.5} weight={600} color={CHART_COLORS.secondary}>{legend.title}</T>
        <Key swatch={<Swatch kind="solid" color={accent} />} label={t('quota_management.pool_legend_recorded')} />
        <Key swatch={<Swatch kind="dashed" color={accent} />} label={t('quota_management.pool_legend_projected')} />
        {fable ? <Key swatch={<Swatch kind="solid" color={FABLE_COLOR} />} label={`Fable ${formatPercent(fable.current)}`} /> : null}
        {settings.quiet !== 'off' || settings.offDays.length > 0 ? (
          <Key swatch={<Swatch kind="quiet" color={colors.text} opacity={0.12} />} label={t('quota_management.pool_legend_quiet')} />
        ) : null}
        {events.map((kind) => <Key key={kind} swatch={<Swatch kind="event" color={EVENT_COLOR[kind]} />} label={t(EVENT_LONG_KEY[kind])} />)}
        {settings.showAccounts && settings.mode === 'remaining'
          ? card.model.accounts.map((a, i) => (
            <Key key={a.key} swatch={<Swatch kind="band" color={accent} opacity={bandOpacity(i, card.model.accounts.length)} />} label={a.label} />
          ))
          : null}
      </View>
      <T size={11} color={CHART_COLORS.tertiary} lineHeight={15}>{legend.note}</T>
    </View>
  )
}

/** Unzoomed, the arrows page; zoomed, they slide a whole view and page on past the edge (the web's rule). */
export function rangeSteps(settings: PoolSettings, range: TimeView, view: TimeView, zoomed: boolean) {
  const limits = OFFSET_LIMITS[settings.window]
  const can = (direction: -1 | 1) =>
    zoomed
      ? stepZoomedView(view, range, direction, settings.offset, limits) !== null
      : direction < 0 ? settings.offset > limits.min : settings.offset < limits.max
  const patch = (direction: -1 | 1): Partial<PoolSettings> | null => {
    if (!zoomed) return { offset: settings.offset + direction }
    return stepZoomedView(view, range, direction, settings.offset, limits)
  }
  return { can, patch }
}

/** Zoom out, in and back; previous, Today, next. */
export function RangeButtons({ settings, range, view, zoomed, onChange, compact }: {
  settings: PoolSettings
  range: TimeView
  view: TimeView
  zoomed: boolean
  onChange: (patch: Partial<PoolSettings>) => void
  compact?: boolean
}) {
  const { t } = poolText
  const steps = rangeSteps(settings, range, view, zoomed)
  const center = view.startMs + (view.endMs - view.startMs) / 2
  const atMinZoom = view.endMs - view.startMs <= MIN_ZOOM_SPAN_MS + 1
  // A finger's size on the page (44 pt); a little less in the sideways bar, which is short.
  const box = compact ? 40 : 44
  const btn = (icon: any, label: string, enabled: boolean, run: () => void) => (
    <IconBtn icon={icon} label={label} size={18} box={box} bordered disabled={!enabled} color={enabled ? colors.text : colors.muted} onPress={enabled ? run : undefined} />
  )
  const today = settings.offset === 0 && !zoomed
  return (
    <View style={st.rangeButtons}>
      {btn(IconZoomOut, t('quota_management.pool_zoom_out'), zoomed, () => onChange({ zoom: zoomView(view, range, 1 / ZOOM_STEP, center) }))}
      {btn(IconZoomIn, t('quota_management.pool_zoom_in'), !atMinZoom, () => onChange({ zoom: zoomView(view, range, ZOOM_STEP, center) }))}
      {zoomed ? btn(IconZoomReset, t('quota_management.pool_zoom_reset'), true, () => onChange({ zoom: null })) : null}
      <View style={{ width: 4 }} />
      {btn(IconChevronLeft, t('quota_management.windows_prev'), steps.can(-1), () => { const p = steps.patch(-1); if (p) onChange(p) })}
      <Press
        haptic
        onPress={() => onChange({ offset: 0, zoom: null })}
        accessibilityRole="button"
        accessibilityState={{ selected: today }}
        style={[st.today, { height: box }, today && st.todayOn]}
      >
        <T size={13} weight={500} color={today ? colors.text : CHART_COLORS.secondary}>{t('quota_management.windows_today')}</T>
      </Press>
      {btn(IconChevronRight, t('quota_management.windows_next'), steps.can(1), () => { const p = steps.patch(1); if (p) onChange(p) })}
    </View>
  )
}

/**
 * A row of small mutually exclusive buttons. The kit's Segmented is sized for a
 * row to itself; two of these share one ("Separate | Together", "Remaining | Drain
 * rate") without cutting a word, and the sideways bar fits three.
 */
export function Choice<V extends string>({ value, options, onChange, label, fill, style }: {
  value: V
  options: { value: V; label: string }[]
  onChange: (v: V) => void
  label: string
  /** Share the row's width evenly, instead of sizing to the words. */
  fill?: boolean
  style?: any
}) {
  return (
    <View style={[st.choice, fill && { flex: 1 }, style]} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <Press
            key={o.value}
            haptic
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on, checked: on }}
            style={[st.choiceItem, fill && { flex: 1 }, on && st.choiceOn]}
          >
            <T size={13} weight={on ? 600 : 400} color={on ? colors.text : colors.muted} numberOfLines={1}>{o.label}</T>
          </Press>
        )
      })}
    </View>
  )
}

/** A card's way into the sideways view: a glyph and a word, so it says what it does. */
export function SidewaysButton({ name, onPress }: { name: string; onPress: () => void }) {
  return (
    <Press onPress={() => { tap(); onPress() }} accessibilityRole="button" accessibilityLabel={`Open the ${name} chart sideways, full screen`} hitSlop={6} style={st.sideways}>
      <IconDeviceMobileRotated size={16} color={colors.text} strokeWidth={1.8} />
      <T size={13} weight={500}>Sideways</T>
    </Press>
  )
}

/** A square glyph button in the sideways bar (Close, Turn), the size of its range buttons. */
export function CornerButton({ icon: Icon, label, onPress }: { icon: any; label: string; onPress: () => void }) {
  return (
    <Press onPress={() => { tap(); onPress() }} accessibilityRole="button" accessibilityLabel={label} hitSlop={8} style={st.corner}>
      <Icon size={17} color={colors.text} strokeWidth={1.8} />
    </Press>
  )
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bigRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  num: { fontVariant: ['tabular-nums'] },
  stats: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
  stat: { width: '50%', paddingRight: 8, gap: 2 },
  keys: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 6 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' },
  swatchDashed: { width: 14, flexDirection: 'row', justifyContent: 'space-between' },
  rangeButtons: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  today: { paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' },
  todayOn: { borderColor: colors.muted },
  choice: { flexDirection: 'row', gap: 2, padding: 3, borderRadius: 11, backgroundColor: colors.bg2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  choiceItem: { paddingHorizontal: 8, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  choiceOn: { backgroundColor: colors.bg3 },
  sideways: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 11, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg3 },
  corner: { width: 40, height: 40, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' },
})
