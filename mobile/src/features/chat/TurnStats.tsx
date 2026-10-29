// The line under a reply (web chat/TurnStats.tsx). It stays short (account ·
// model · time); tapping it, or "Reply details" in the reply's long-press menu,
// unfolds what the reply ran on and how it went beneath it: the setting and
// effort, speed, time to first token, tokens and cost — whatever the CLI
// reported (chat/stats.mjs); a number it did not report is left out. The web
// slides this out on hover; a phone has no hover, so it opens in place.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import type { ChatMessage } from '../../lib/chat/types'
import { EFFORT_LABELS, LEVEL_NAMES, POWER_NAMES, parseModelSpec } from '../../lib/chat/models'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { TI, formatDuration, vc } from './ui'
import { IconChevronDown } from './icons'

const tokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms))

/** What the turn was set to: the retired Auto's power, the Thinking level, Instant, or a hand-picked model. */
function setting(m: ChatMessage) {
  if (m.power) return `Auto · ${POWER_NAMES[String(m.power)] || m.power}`
  if (m.route === 'thinking') return `Thinking${m.level ? ` · ${LEVEL_NAMES[String(m.level)] || m.level}` : ''}`
  if (m.route === 'instant') return 'Instant'
  return 'Manual'
}

export function turnRows(m: ChatMessage, modelName?: string, account?: string): [string, string][] {
  const s = m.stats || {}
  // Cursor carries effort and speed inside the model id ("composer-2.5[fast=true,effort=high]").
  const spec = m.model?.includes('[') ? parseModelSpec(m.model) : null
  const effort = m.effort || (spec && spec.effort !== 'default' ? spec.effort : '')
  const rows: [string, string][] = [['Setting', setting(m)]]
  if (effort) rows.push(['Effort', EFFORT_LABELS[effort] || effort])
  if (account) rows.push(['Account', account])
  if (spec && spec.speed !== 'default') rows.push(['Mode', spec.speed === 'fast' ? 'Fast' : 'Quality'])
  if (m.model) rows.push(['Model', modelName && modelName !== m.model.split('[')[0] ? `${modelName} (${m.model.split('[')[0]})` : m.model.split('[')[0]])
  if (s.tps) rows.push(['Speed', `${s.tps >= 100 ? Math.round(s.tps) : s.tps} tok/s`])
  if (s.ttftMs) rows.push(['First token', seconds(s.ttftMs)])
  if (m.durationMs) rows.push(['Total', seconds(m.durationMs)])
  if (s.input != null) rows.push(['Input', `${tokens(s.input)}${s.cached ? ` · ${tokens(s.cached)} cached` : ''}`])
  if (s.output != null) rows.push(['Output', `${tokens(s.output)}${s.reasoning ? ` · ${tokens(s.reasoning)} thinking` : ''}`])
  if (s.tools) rows.push(['Tools', String(s.tools)])
  if (s.costUsd) rows.push(['Cost', s.costUsd < 0.01 ? `$${s.costUsd.toFixed(4)}` : `$${s.costUsd.toFixed(2)}`])
  return rows
}

/** The meta line as a button: tapping it opens or folds the details. */
export function TurnChip({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <Press
      onPress={() => { tap(); onToggle() }}
      style={[st.chip, open && { backgroundColor: vc.raise }]}
      accessibilityRole="button"
      accessibilityLabel="Reply details"
      accessibilityState={{ expanded: open }}
      hitSlop={4}
    >
      {children}
      <TI icon={IconChevronDown} size={12} color={vc.faint} style={open ? { transform: [{ rotate: '180deg' }] } : undefined} />
    </Press>
  )
}

/** The details themselves: a two-column table, keys faint, values in tabular figures. */
export default function TurnStats({ m, modelName, account }: { m: ChatMessage; modelName?: string; account?: string }) {
  const rows = turnRows(m, modelName, account)
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={st.panel} accessibilityLabel="Reply details">
      {rows.map(([k, v]) => (
        <View key={k} style={st.row}>
          <T size={12.5} color={vc.faint} style={st.k}>{k}</T>
          <T size={12.5} color={vc.text} style={st.v} selectable>{v}</T>
        </View>
      ))}
    </Animated.View>
  )
}

const st = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 8, marginLeft: 4, borderRadius: 8, flexShrink: 1, minWidth: 0 },
  panel: {
    alignSelf: 'flex-start', marginTop: 4, paddingVertical: 10, paddingHorizontal: 14, gap: 5, borderRadius: 12,
    backgroundColor: vc.menu, borderWidth: 1, borderColor: vc.line, maxWidth: '100%',
  },
  row: { flexDirection: 'row', gap: 16 },
  k: { width: 78 },
  v: { flexShrink: 1, fontVariant: ['tabular-nums'] },
})
