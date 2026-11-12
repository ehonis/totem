// Small pieces the Lists screens share: the inline error with Retry, and the
// check box that fills with a spring when an item is checked off.
import React, { useEffect, useRef } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import Animated, {
  interpolateColor, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withSpring, withTiming,
} from 'react-native-reanimated'
import { alpha, colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { CheckIcon, ExclamationTriangleIcon, Hi } from '../../lib/icons'

export function ErrorLine({ text, onRetry, style }: { text: string; onRetry?: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[st.error, style]} accessibilityRole="alert">
      <Hi icon={ExclamationTriangleIcon} size={15} color={colors.red} />
      <T size={14} color={colors.red} lineHeight={19} style={{ flex: 1 }}>{text}</T>
      {onRetry ? (
        <Press onPress={onRetry} hitSlop={10} accessibilityRole="button">
          <T size={14} weight={600}>Retry</T>
        </Press>
      ) : null}
    </View>
  )
}

/**
 * A round check box (Reminders' circle). Checking fills it and gives it a small
 * pop; unchecking empties it without the pop. Reduce Motion keeps the fill and
 * drops the pop.
 */
export function CheckCircle({ checked, size = 24 }: { checked: boolean; size?: number }) {
  const reduced = useReducedMotion()
  const on = useSharedValue(checked ? 1 : 0)
  const scale = useSharedValue(1)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    on.value = withTiming(checked ? 1 : 0, { duration: reduced ? 0 : 160 })
    if (checked && !reduced) scale.value = withSequence(withTiming(0.82, { duration: 70 }), withSpring(1, { damping: 9, stiffness: 320 }))
  }, [checked, reduced, on, scale])
  const ring = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(on.value, [0, 1], ['rgba(255,255,255,0.03)', colors.accent]),
    borderColor: interpolateColor(on.value, [0, 1], ['#5b6273', colors.accent]),
    transform: [{ scale: scale.value }],
  }))
  const mark = useAnimatedStyle(() => ({ opacity: on.value, transform: [{ scale: 0.6 + on.value * 0.4 }] }))
  return (
    <Animated.View style={[st.circle, { width: size, height: size, borderRadius: size / 2 }, ring]}>
      <Animated.View style={mark}><Hi icon={CheckIcon} size={size * 0.58} color={colors.white} strokeWidth={3} /></Animated.View>
    </Animated.View>
  )
}

const st = StyleSheet.create({
  error: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: 10, borderWidth: 1, borderColor: alpha(colors.red, 0.3), backgroundColor: alpha(colors.red, 0.08),
  },
  circle: { borderWidth: 1.75, alignItems: 'center', justifyContent: 'center' },
})
