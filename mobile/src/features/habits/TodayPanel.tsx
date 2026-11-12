// The head of the Habits page (#180): which day you are answering for, with ‹ ›
// to step back through past days, and a bar of one segment per habit in its own
// colour that fills as each is done. The morning check-in and a new habit sit
// beside the count.
import React, { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { ZoomIn, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn, Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { Hi, CheckBadgeSolidIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, SunIcon } from '../../lib/icons'
import { dayLabel, toDate, type DayProgress } from './logic'
import { useCalm } from './motion'

const shortDay = (iso: string) => toDate(iso).toLocaleDateString([], { weekday: 'long' })

function Segment({ color, done }: { color: string; done: boolean }) {
  const fill = useSharedValue(done ? 1 : 0)
  const calm = useCalm()
  useEffect(() => { fill.value = calm ? (done ? 1 : 0) : withTiming(done ? 1 : 0, { duration: 260 }) }, [done, fill, calm])
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }))
  return (
    <View style={st.seg}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color, transformOrigin: 'left' }, style]} />
    </View>
  )
}

export default function TodayPanel({ date, daysBack, maxBack, progress, onStep, onToday, onCheckin, onNew }: {
  date: string
  daysBack: number
  maxBack: number
  progress: DayProgress
  onStep: (delta: 1 | -1) => void
  onToday: () => void
  onCheckin: () => void
  onNew: () => void
}) {
  const { done, total, segments } = progress
  const calm = useCalm()
  const all = total > 0 && done === total
  const title = daysBack === 0 ? 'Today' : daysBack === 1 ? 'Yesterday' : shortDay(date)
  return (
    <View style={st.panel}>
      <View style={st.dayLine}>
        <View style={{ flex: 1, minWidth: 0 }} accessible accessibilityRole="header" accessibilityLabel={`${title}, ${dayLabel(date)}`}>
          <T size={22} weight={700}>{title}</T>
          <T size={13} muted numberOfLines={1}>{dayLabel(date)}</T>
        </View>
        {daysBack > 0 && (
          <Press onPress={() => { tap(); onToday() }} style={st.todayBtn} accessibilityRole="button" accessibilityLabel="Back to today">
            <T size={13} weight={600} color={colors.accent}>Today</T>
          </Press>
        )}
        <IconBtn icon={ChevronLeftIcon} size={18} box={44} bordered label="Previous day" disabled={daysBack >= maxBack} onPress={() => { tap(); onStep(1) }} />
        <IconBtn icon={ChevronRightIcon} size={18} box={44} bordered label="Next day" disabled={daysBack === 0} onPress={() => { tap(); onStep(-1) }} />
      </View>

      {total > 0 && (
        <View
          style={st.bar}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`${done} of ${total} habits done`}
          accessibilityValue={{ min: 0, max: total, now: done }}
        >
          {segments.map((seg) => <Segment key={seg.id} color={seg.color} done={seg.done} />)}
        </View>
      )}

      <View style={st.foot}>
        <View style={st.count} accessibilityLiveRegion="polite">
          {all ? (
            <>
              <Animated.View entering={calm ? undefined : ZoomIn.springify().damping(12)}>
                <Hi icon={CheckBadgeSolidIcon} size={18} color={colors.green} />
              </Animated.View>
              <T size={14} weight={600} color={colors.green}>All done</T>
            </>
          ) : total > 0 ? (
            <T size={14} weight={600}>
              {done}<T size={14} muted> of {total} done</T>
            </T>
          ) : null}
        </View>
        <Btn compact icon={SunIcon} title="Check in" onPress={onCheckin} style={st.btn} />
        <Btn compact kind="primary" icon={PlusIcon} title="New" onPress={onNew} style={st.btn} />
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  panel: { gap: 12, marginBottom: 14 },
  dayLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  todayBtn: { height: 44, paddingHorizontal: 8, justifyContent: 'center' },
  bar: { flexDirection: 'row', gap: 3, height: 8 },
  seg: { flex: 1, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.bg3 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  count: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  btn: { minHeight: 44, paddingHorizontal: 12 },
})
