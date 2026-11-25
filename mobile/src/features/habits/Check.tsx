// The big check on a habit row (#180): the web's HabitCheckButton at thumb size,
// with a press that gives. Daily habits fill solid when logged; weekly and monthly
// ones fill as a pie, one slice per completion in the period, so the circle only
// goes solid once the quota is met. Ticking it springs and throws a ring outward
// in the habit's colour; Reduce Motion keeps the fill and drops the movement.
import React, { useEffect, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'
import Animated, {
  Easing, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming,
} from 'react-native-reanimated'
import { colors } from '../../theme'
import { Press } from '../../ui/kit'
import { Hi, CheckIcon } from '../../lib/icons'
import { mixHex, periodLabel, type Habit } from './logic'
import { useCalm } from './motion'

export const CHECK = 52

/** A clockwise wedge from 12 o'clock: the conic-gradient pie, as a path. */
function wedge(r: number, cx: number, cy: number, ratio: number): string {
  const a = ratio * 2 * Math.PI
  const x = cx + r * Math.sin(a)
  const y = cy - r * Math.cos(a)
  return `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${ratio > 0.5 ? 1 : 0} 1 ${x} ${y} Z`
}

export function CheckFace({ habit, count, periodCount, size = CHECK }: { habit: Habit; count: number; periodCount: number; size?: number }) {
  const capped = habit.cadence !== 'daily'
  const target = Math.max(1, habit.target)
  const ratio = capped ? Math.min(1, periodCount / target) : count > 0 ? 1 : 0
  const done = count > 0
  const border = capped
    ? (ratio >= 1 ? habit.color : mixHex(habit.color, colors.line, 40))
    : done ? habit.color : mixHex(habit.color, colors.line, 30)
  const r = size / 2
  return (
    <>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={r} cy={r} r={r - 1} fill={!capped && done ? habit.color : colors.bg} />
        {capped && ratio > 0 && (ratio >= 1
          ? <Circle cx={r} cy={r} r={r - 1} fill={habit.color} />
          : <Path d={wedge(r - 1, r, r, ratio)} fill={habit.color} />)}
        <Circle cx={r} cy={r} r={r - 1} fill="none" stroke={border} strokeWidth={2} />
      </Svg>
      {done ? (
        <View style={st.mark} pointerEvents="none">
          <Hi icon={CheckIcon} size={Math.round(size * 0.44)} color={colors.white} strokeWidth={2.5} />
        </View>
      ) : null}
    </>
  )
}

/** The press that gives, and a ring thrown outward when it turns done. */
function useCheckMotion(done: boolean, size: number) {
  const reduced = useCalm()
  const scale = useSharedValue(1)
  const burst = useSharedValue(0)
  // The flourish follows the transition into done (a tap here, or the check-in
  // sheet), never a payload that loads already done.
  const was = useRef(done)
  useEffect(() => {
    const before = was.current
    was.current = done
    if (reduced || before === done) return
    if (done) {
      scale.value = withSequence(withTiming(0.84, { duration: 80 }), withSpring(1, { damping: 8, stiffness: 320, mass: 0.6 }))
      burst.value = 0
      burst.value = withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) })
    } else {
      scale.value = withSequence(withTiming(0.92, { duration: 70 }), withSpring(1, { damping: 14, stiffness: 300 }))
    }
  }, [done, reduced, scale, burst])

  const faceStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))
  const ringStyle = useAnimatedStyle(() => ({
    opacity: burst.value > 0 && burst.value < 1 ? 0.6 * (1 - burst.value) : 0,
    transform: [{ scale: 1 + burst.value * 0.4 }],
  }))
  const box = { width: size, height: size }
  return { faceStyle, ringStyle, box, ring: { ...box, borderRadius: size / 2 } }
}

export function HabitCheck({ habit, count, periodCount, onLog, disabled, size = CHECK }: {
  habit: Habit
  count: number
  periodCount: number
  onLog: (habit: Habit, delta: number) => void
  disabled?: boolean
  /** A sub-habit's row inside its group draws it a little smaller. */
  size?: number
}) {
  const done = count > 0
  const { faceStyle, ringStyle, box, ring } = useCheckMotion(done, size)
  const capped = habit.cadence !== 'daily'
  const target = Math.max(1, habit.target)
  const progress = capped ? `, ${periodCount} of ${target} ${periodLabel(habit.cadence)}` : ''
  return (
    <Press
      onPress={() => onLog(habit, done ? -1 : +1)}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done, disabled }}
      accessibilityLabel={`${habit.name}${progress}`}
      accessibilityHint={done ? 'Double-tap to undo' : 'Double-tap to mark done'}
      hitSlop={6}
      style={box}
    >
      <Animated.View pointerEvents="none" style={[st.burst, ring, { borderColor: habit.color }, ringStyle]} />
      <Animated.View style={[box, faceStyle]}>
        <CheckFace habit={habit} count={count} periodCount={periodCount} size={size} />
      </Animated.View>
    </Press>
  )
}

/**
 * A group's own check (lib/habits/groups.ts): a pie of its sub-habits done today,
 * the mark once all are. A tap marks every hand-logged one done, or clears them
 * once all are; the page owns the write and its undo.
 */
export function GroupCheck({ habit, done, total, action, onLog, disabled, size = CHECK }: {
  habit: Habit
  done: number
  total: number
  /** What a tap does, in words (groups.ts groupWords). */
  action: string
  onLog: () => void
  disabled?: boolean
  size?: number
}) {
  const all = total > 0 && done >= total
  const { faceStyle, ringStyle, box, ring } = useCheckMotion(all, size)
  // The pie is CheckFace's weekly face: one slice per sub-habit done.
  const face = { ...habit, cadence: 'weekly' as const, target: Math.max(1, total) }
  return (
    <Press
      onPress={onLog}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      // The words say the group, its progress and what a tap does, in one sentence.
      accessibilityLabel={action}
      hitSlop={6}
      style={box}
    >
      <Animated.View pointerEvents="none" style={[st.burst, ring, { borderColor: habit.color }, ringStyle]} />
      <Animated.View style={[box, faceStyle]}>
        <CheckFace habit={face} count={all ? 1 : 0} periodCount={done} size={size} />
      </Animated.View>
    </Press>
  )
}

const st = StyleSheet.create({
  mark: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  burst: { position: 'absolute', top: 0, left: 0, borderWidth: 3 },
})
