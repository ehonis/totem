// The task page's complete control: an open ring that fills green and draws its
// check when tapped, with a success buzz. Tapping a finished task reopens it.
// Reduce Motion swaps the spring for a plain cut.
import React, { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  Easing, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withSpring, withTiming,
} from 'react-native-reanimated'
import { colors } from '../../../theme'
import { Press } from '../../../ui/kit'
import { Hi, CheckIcon, MinusIcon } from '../../../lib/icons'
import type { TodoStatus } from '../../../lib/todos/types'

const SIZE = 30

export function CompleteCircle({ done, notDoing, onPress, disabled, label }: {
  done: boolean
  /** Finished as "not doing": a dash rather than a check, in grey. */
  notDoing?: boolean
  onPress: () => void
  disabled?: boolean
  label: string
}) {
  const reduced = useReducedMotion()
  const fill = useSharedValue(done ? 1 : 0)
  const pop = useSharedValue(1)
  const tone = notDoing ? colors.muted : colors.green

  useEffect(() => {
    if (reduced) { fill.value = done ? 1 : 0; return }
    fill.value = done ? withSpring(1, { damping: 14, stiffness: 220 }) : withTiming(0, { duration: 160, easing: Easing.out(Easing.quad) })
    if (done) pop.value = withSequence(withTiming(1.18, { duration: 110 }), withSpring(1, { damping: 9, stiffness: 260 }))
  }, [done, reduced, fill, pop])

  const ring = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }))
  const disc = useAnimatedStyle(() => ({ opacity: fill.value, transform: [{ scale: interpolate(fill.value, [0, 1], [0.4, 1]) }] }))
  const mark = useAnimatedStyle(() => ({ opacity: fill.value, transform: [{ scale: interpolate(fill.value, [0, 1], [0.2, 1]) }, { rotate: `${interpolate(fill.value, [0, 1], [-30, 0])}deg` }] }))

  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={st.hit}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done, disabled }}
      accessibilityLabel={label}
      accessibilityHint={done ? 'Reopens the task' : 'Marks the task done'}
    >
      <Animated.View style={[st.ring, { borderColor: done ? tone : '#4a5162' }, ring]}>
        <Animated.View style={[StyleSheet.absoluteFill, st.disc, { backgroundColor: tone }, disc]} />
        <Animated.View style={mark}>
          <Hi icon={notDoing ? MinusIcon : CheckIcon} size={17} color={colors.white} strokeWidth={3} />
        </Animated.View>
      </Animated.View>
    </Press>
  )
}

/** A static ring for places that only show the state (related tasks): open, or done. */
export function StatusDot({ status }: { status: TodoStatus }) {
  return (
    <View style={[st.dot, status === 'done' ? { backgroundColor: colors.green, borderColor: colors.green } : null]}>
      {status === 'done' ? <Hi icon={CheckIcon} size={10} color={colors.white} strokeWidth={3} /> : null}
    </View>
  )
}

const st = StyleSheet.create({
  hit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -7 },
  ring: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  disc: { borderRadius: SIZE / 2 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: '#4a5162', alignItems: 'center', justifyContent: 'center' },
})
