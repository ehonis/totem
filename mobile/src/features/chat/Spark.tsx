// Totem's "working" mark (web chat/Spark.tsx): a four-point star that turns,
// with a soft glow breathing behind it, beside status text that shimmers. The
// web draws the star in CSS; here it is Tabler's sparkle, filled, so nothing is
// hand-drawn. Runs on the UI thread (Reanimated).
import React, { useEffect } from 'react'
import { View } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming, ReduceMotion } from 'react-native-reanimated'
import IconSparkle from '@tabler/icons-react-native/dist/esm/icons/IconSparkle.mjs'
import { colors } from '../../theme'
import { T } from '../../ui/Text'

export default function Spark({ size = 16 }: { size?: number }) {
  const turn = useSharedValue(0)
  const glow = useSharedValue(0)
  useEffect(() => {
    turn.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.linear, reduceMotion: ReduceMotion.System }), -1)
    glow.value = withRepeat(withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease), reduceMotion: ReduceMotion.System }), -1, true)
  }, [turn, glow])
  const star = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }, { scale: 0.85 + 0.15 * Math.sin(turn.value * Math.PI * 2) }] }))
  const halo = useAnimatedStyle(() => ({ opacity: 0.35 + 0.4 * glow.value, transform: [{ scale: 0.75 + 0.4 * glow.value }] }))
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: colors.accent, opacity: 0.4 }, halo]} />
      <Animated.View style={star}>
        <IconSparkle size={size} color={colors.text} fill={colors.text} strokeWidth={1} />
      </Animated.View>
    </View>
  )
}

/** Text that breathes between faint and full, the native stand-in for the web's shimmer. */
export function Shimmer({ text, size = 15, numberOfLines = 1 }: { text: string; size?: number; numberOfLines?: number }) {
  const v = useSharedValue(0)
  useEffect(() => {
    v.value = withRepeat(withSequence(withTiming(1, { duration: 1100 }), withTiming(0, { duration: 1100 })), -1)
  }, [v])
  const style = useAnimatedStyle(() => ({ opacity: 0.45 + 0.55 * v.value }))
  return (
    <Animated.View style={[{ flexShrink: 1 }, style]}>
      <T size={size} color={colors.text} numberOfLines={numberOfLines}>{text}</T>
    </Animated.View>
  )
}

/** Spark + shimmering text: "Thinking", "Working", or the current step. */
export function WorkingLine({ text }: { text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 26 }} accessibilityLiveRegion="polite">
      <Spark size={16} />
      <Shimmer text={text} />
    </View>
  )
}

