// The card's check target: a 44 pt press around a 24 pt ring. Ticking it fills the
// ring green from the middle and springs the check in; a finished one sits filled,
// and "not doing" is a grey dash. Under Reduce Motion the fill and check simply appear.
import React, { useEffect } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { colors } from '../../theme'
import { Hi, CheckIcon, MinusIcon } from '../../lib/icons'

const RING = 24

export type CheckLook = 'todo' | 'done' | 'notDoing'

export default function CheckCircle({ look, checked, onPress, label, hint, disabled }: {
  look: CheckLook
  /** Drawn ticked: finished, or ticked and waiting out its beat. */
  checked: boolean
  onPress: () => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  const reduced = useReducedMotion()
  const fill = useSharedValue(checked ? 1 : 0)
  const mark = useSharedValue(checked ? 1 : 0)

  useEffect(() => {
    if (reduced) { fill.value = checked ? 1 : 0; mark.value = checked ? 1 : 0; return }
    fill.value = withTiming(checked ? 1 : 0, { duration: checked ? 200 : 140 })
    mark.value = checked ? withSpring(1, { damping: 11, stiffness: 260, mass: 0.6 }) : withTiming(0, { duration: 120 })
  }, [checked, reduced, fill, mark])

  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scale: fill.value }], opacity: fill.value > 0.02 ? 1 : 0 }))
  const markStyle = useAnimatedStyle(() => ({ transform: [{ scale: 0.4 + mark.value * 0.6 }], opacity: mark.value }))

  const notDoing = look === 'notDoing'
  const ring = notDoing ? '#4a5162' : checked ? colors.green : '#596074'
  const fillColor = notDoing ? '#3a4050' : colors.green

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      style={({ pressed }) => [st.target, pressed && { transform: [{ scale: 0.9 }] }]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      accessibilityHint={hint}
    >
      <View style={[st.ring, { borderColor: ring }]}>
        <Animated.View style={[st.fill, { backgroundColor: fillColor }, fillStyle]} />
        <Animated.View style={markStyle}>
          <Hi icon={notDoing ? MinusIcon : CheckIcon} size={14} strokeWidth={3} color={notDoing ? colors.muted : '#06210d'} />
        </Animated.View>
      </View>
    </Pressable>
  )
}

const st = StyleSheet.create({
  target: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  ring: { width: RING, height: RING, borderRadius: RING / 2, borderWidth: 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  fill: { position: 'absolute', top: -2, left: -2, right: -2, bottom: -2, borderRadius: RING / 2 },
})
