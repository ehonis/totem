// Sheet detents: [0.6, 1] (formSheet, grabber, corner radius 22; registered in src/app/_layout.tsx).
//
// The chat header's quota glance (web chat/UsageChips.tsx): on a phone, one
// pill for the account with the least headroom, as what's left of its 5-hour
// window (or its tightest limit). Amber under 25%, red under 10%. Tapping it
// opens every account's limits in a sheet, where the web grows a panel.
import React, { useEffect, useState } from 'react'
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAiUsageLive } from '../../lib/useAiUsageLive'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { ProviderLogo, TI, vc } from './ui'
import { IconRefresh } from './icons'

function pick(meters: any[]) {
  const usable = (meters || []).filter((m) => typeof m.remainingPct === 'number')
  if (!usable.length) return null
  return usable.find((m) => m.windowMinutes === 300) || usable.reduce((a, b) => (b.remainingPct < a.remainingPct ? b : a))
}

function resetLabel(ts?: number) {
  if (!ts) return ''
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60000))
  if (mins < 60) return `Resets in ${mins}m`
  const h = Math.floor(mins / 60)
  return h < 48 ? `Resets in ${h}h ${mins % 60}m` : `Resets ${new Date(ts).toLocaleDateString([], { weekday: 'short' })}`
}

function agoLabel(ts?: number) {
  if (!ts) return 'Not updated yet'
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'Updated just now'
  if (mins < 60) return `Updated ${mins}m ago`
  return `Updated ${Math.floor(mins / 60)}h ${mins % 60}m ago`
}

const tone = (left: number) => (left < 10 ? { color: '#ff8fa3', border: '#f0506e66', bar: colors.red } : left < 25 ? { color: '#f0cd72', border: '#e3b34155', bar: colors.amber } : { color: vc.soft, border: vc.line, bar: colors.text })

function useAccounts(): any[] {
  const live = useAiUsageLive() as any
  return (live?.data?.accounts || []).filter((a: any) => a.status === 'ok' && a.meters?.length)
}

export default function UsageChips() {
  const accounts = useAccounts()
  if (!accounts.length) return null
  const tightest = accounts.reduce((a, b) => ((pick(b.meters)?.remainingPct ?? 100) < (pick(a.meters)?.remainingPct ?? 100) ? b : a))
  const m = pick(tightest.meters)
  if (!m) return null
  const left = Math.round(m.remainingPct)
  const t = tone(left)
  return (
    <Press
      onPress={() => { tap(); router.push('/chat/usage') }}
      accessibilityLabel={`AI usage left: ${left}% on ${tightest.displayName || tightest.backend}`}
      hitSlop={6}
      style={[st.chip, { borderColor: t.border }]}
    >
      <ProviderLogo driver={tightest.backend} name={tightest.displayName} size={13} />
      <T size={12} color={t.color} style={{ fontVariant: ['tabular-nums'] }}>{left}%</T>
    </Press>
  )
}

/**
 * Every account, one card each: each limit's bar, what's left and when it
 * resets. Refreshing (the button, or a pull) keeps the numbers on screen and
 * updates them in place: only the small mark in the header turns while it runs.
 */
export function UsageSheet() {
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const live = useAiUsageLive() as any
  const accounts: any[] = (live?.data?.accounts || []).filter((a: any) => a.status === 'ok' && a.meters?.length)
  const busy: boolean = live.busy
  const [, tick] = useState(0)
  // "Updated 3m ago" and "Resets in 2h" stay true while the sheet is open.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 20_000)
    return () => clearInterval(id)
  }, [])
  const refresh = () => { if (!busy) { tap(); void live.forceRefresh() } }
  const newest = Math.max(0, ...accounts.map((a) => a.fetchedAt || 0))

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg2 }}
      contentContainerStyle={[st.sheet, { paddingBottom: insets.bottom + 28 }]}
      // A pull refreshes too, but the control springs straight back: the header's mark shows the work, so nothing jumps.
      refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.muted} />}
    >
      <View style={[st.column, { width: Math.min(width - 32, 520) }]}>
        <View style={st.head}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={17} weight={600}>AI usage left</T>
            <T size={12.5} color={vc.faint} style={{ marginTop: 2 }}>{busy ? 'Refreshing…' : newest ? agoLabel(newest) : ' '}</T>
          </View>
          <Press onPress={refresh} disabled={busy} style={st.refresh} accessibilityLabel="Refresh usage" accessibilityState={{ busy }} hitSlop={6}>
            {/* Same box either way, so the header never shifts. */}
            {busy ? <ActivityIndicator size="small" color={vc.soft} /> : <TI icon={IconRefresh} size={18} color={vc.soft} />}
          </Press>
        </View>
        {!accounts.length ? (
          <View style={st.card}>
            <T size={14} lineHeight={20} color={vc.soft}>{live?.data ? 'No usage yet. Turn polling on in Settings → Usage.' : 'Loading usage…'}</T>
          </View>
        ) : null}
        {accounts.map((a) => (
          <View key={a.id} style={st.card}>
            <View style={st.cardHead}>
              <ProviderLogo driver={a.backend} name={a.displayName} size={20} />
              <T size={15.5} weight={600} style={{ flexShrink: 1 }} numberOfLines={1}>{a.displayName || a.backend}</T>
              {a.plan ? <View style={st.plan}><T size={11.5} color={vc.soft}>{a.plan}</T></View> : null}
            </View>
            {a.meters.filter((m: any) => typeof m.remainingPct === 'number').map((m: any) => {
              const left = Math.round(m.remainingPct)
              const t = tone(left)
              return (
                <View key={m.key || m.label} style={st.meter} accessibilityLabel={`${m.label}, ${left}% left${m.resetsAt ? `. ${resetLabel(m.resetsAt)}` : ''}`}>
                  <View style={st.meterTop}>
                    <T size={14} color={vc.text} numberOfLines={1} style={{ flexShrink: 1 }}>{m.label}</T>
                    <T size={14} weight={500} color={t.color} style={{ fontVariant: ['tabular-nums'] }}>{left}% left</T>
                  </View>
                  <View style={st.bar}><View style={[st.fill, { width: `${Math.max(0, Math.min(100, m.remainingPct))}%`, backgroundColor: t.bar }]} /></View>
                  <T size={12} color={vc.faint} style={{ fontVariant: ['tabular-nums'] }}>{m.resetsAt ? resetLabel(m.resetsAt) : ' '}</T>
                </View>
              )
            })}
            <T size={12} color={vc.faint}>{agoLabel(a.fetchedAt)}</T>
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

const st = StyleSheet.create({
  sheet: { alignItems: 'center', paddingTop: 22 },
  column: { gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4, marginBottom: 4 },
  refresh: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: vc.line, alignItems: 'center', justifyContent: 'center' },
  card: { gap: 14, padding: 16, borderRadius: 16, backgroundColor: '#1a1d26', borderWidth: 1, borderColor: vc.line },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  plan: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: vc.raise },
  meter: { gap: 7 },
  meterTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 9, borderRadius: 999, borderWidth: 1, marginRight: 4 },
  bar: { height: 8, borderRadius: 4, backgroundColor: '#2a2f3c', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
})
