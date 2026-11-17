import React, { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { compactionLabel } from '../../lib/chat/context'
import type { CompactionPart } from '../../lib/chat/types'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { TI, vc } from './ui'
import { IconAlertCircle, IconArrowRight, IconArrowsDiagonalMinimize2 } from './icons'

// Where the context was compacted (T3 Code's timeline divider): a rule across the
// log, "Context compacted 412k → 38k tokens", pulsing while it runs and red if it
// failed. The web's web/src/chat/CompactionMark.tsx.
export default function CompactionMark({ p }: { p: CompactionPart }) {
  const l = compactionLabel(p)
  const reduced = useReducedMotion()
  const pulse = useSharedValue(1)
  useEffect(() => {
    if (l.active && !reduced) pulse.value = withRepeat(withTiming(0.45, { duration: 900 }), -1, true)
    else { cancelAnimation(pulse); pulse.value = 1 }
  }, [l.active, reduced, pulse])
  const fade = useAnimatedStyle(() => ({ opacity: pulse.value }))
  const color = l.failed ? colors.red : vc.faint
  const label = l.tokens ? `${l.text} ${l.tokens.before} → ${l.tokens.after} tokens` : l.text
  const mark = (
    <View style={st.row} accessibilityRole="text" accessibilityLabel={p.reason ? `${label}: ${p.reason}` : label}>
      <View style={[st.rule, l.failed && st.ruleFailed]} />
      <Animated.View style={[st.label, fade]}>
        <TI icon={l.failed ? IconAlertCircle : IconArrowsDiagonalMinimize2} size={13} color={color} />
        {l.tokens ? (
          <>
            <T size={12} color={color}>{l.text} {l.tokens.before}</T>
            <TI icon={IconArrowRight} size={12} color={color} />
            <T size={12} color={color}>{l.tokens.after} tokens</T>
          </>
        ) : <T size={12} color={color}>{l.text}</T>}
      </Animated.View>
      <View style={[st.rule, l.failed && st.ruleFailed]} />
    </View>
  )
  // A phone has no room for the reason beside the label: it goes under it.
  return p.reason ? (
    <View>
      {mark}
      {/* Read once, in the divider's own label. */}
      <T size={12} color={color} style={st.reason} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{p.reason}</T>
    </View>
  ) : mark
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: vc.line },
  ruleFailed: { backgroundColor: colors.red, opacity: 0.3 },
  label: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, maxWidth: '85%' },
  reason: { textAlign: 'center', opacity: 0.8, marginTop: -2, marginBottom: 4, paddingHorizontal: 24 },
})
