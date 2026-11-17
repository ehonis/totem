import React from 'react'
import { Alert, StyleSheet, View } from 'react-native'
import { contextLabel, contextTooltip, contextValue, formatContextTokens, type ContextSnapshot } from '../../lib/chat/context'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { TI, vc } from './ui'
import { IconArrowsDiagonal, IconArrowsDiagonalMinimize2 } from './icons'

// How full the chat's context window is (web chat/ContextMeter.tsx, after T3
// Code's context row): a thin bar in the composer's footer, amber from 80% and
// red from 90%, with a tick where Claude compacts when that is set below the
// window. A tap shows the numbers; with no window known, the tokens stand alone.
export default function ContextMeter({ s }: { s: ContextSnapshot }) {
  const tick = s.max && s.autoCompactAt ? (s.autoCompactAt / s.max) * 100 : null
  const fill = s.tone === 'error' ? colors.red : s.tone === 'warning' ? colors.amber : vc.soft
  return (
    <Press
      style={st.chip}
      onPress={() => { tap(); const [head, ...rest] = contextTooltip(s); Alert.alert(head, rest.join('\n'), undefined, { userInterfaceStyle: 'dark' }) }}
      accessibilityRole="button"
      accessibilityLabel={`Context: ${contextLabel(s)}`}
      hitSlop={4}
    >
      {s.percent != null ? (
        <View style={st.track}>
          <View style={[st.fill, { width: `${Math.max(s.percent, 4)}%`, backgroundColor: fill }]} />
          {tick != null ? <View style={[st.tick, { left: `${tick}%` }]} /> : null}
        </View>
      ) : null}
      {/* The phone's footer already holds the model, effort and access: the numbers are a tap away. */}
      {s.percent == null ? <T size={11.5} color={vc.faint} style={st.value}>{contextValue(s)}</T> : null}
    </Press>
  )
}

/**
 * T3's Compact chip by Send: the next send compacts the idle chat first
 * (pressed), or keeps the full history. A phone shows the glyph and the tokens.
 */
export function CompactChip({ tokens, keep, onToggle }: { tokens: number; keep: boolean; onToggle: () => void }) {
  const n = formatContextTokens(tokens)
  return (
    <Press
      style={[st.compact, !keep && { backgroundColor: vc.raise }]}
      onPress={() => { tap(); onToggle() }}
      accessibilityRole="button"
      accessibilityState={{ selected: !keep }}
      accessibilityLabel={`Compact ${n} tokens of history before sending`}
      accessibilityHint={keep ? `Next send keeps all ${n} tokens. Tap to compact first.` : `Next send compacts ${n} tokens first. Tap to keep full history.`}
    >
      <TI icon={keep ? IconArrowsDiagonal : IconArrowsDiagonalMinimize2} size={15} color={keep ? vc.faint : colors.text} />
      <T size={12.5} color={keep ? vc.soft : colors.text} style={st.value}>{keep ? `Keep ${n}` : n}</T>
    </Press>
  )
}

const st = StyleSheet.create({
  chip: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 8 },
  track: { width: 32, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2 },
  tick: { position: 'absolute', top: -3, width: StyleSheet.hairlineWidth * 2, height: 9, backgroundColor: vc.soft },
  value: { fontVariant: ['tabular-nums'] },
  compact: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 3, height: 32, paddingHorizontal: 6, borderRadius: 9 },
})
