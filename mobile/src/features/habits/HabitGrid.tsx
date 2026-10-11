// A habit's year of history (HabitsView.tsx HabitDayGrid / HabitWeekGrid /
// HabitMonthGrid): GitHub-style day dots for daily habits, one thermometer per week
// or month for the others. Scrolls sideways, anchored to the newest week, at the
// phone's 13px cells. One Pressable per column (not per cell) keeps 52×7 dots cheap;
// the tap's height picks the day.
import React, { useMemo, useRef } from 'react'
import { ScrollView, StyleSheet, View, type GestureResponderEvent } from 'react-native'
import { colors, alpha, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import {
  GRID_WEEKS, LEVEL_MIX, addDays, dayOfWeek, levelOf, mixHex, monthColumns, monthLabelsForWeeks,
  periodGauge, weekColumns, weekStartsOf, type Entries, type Habit, type PeriodColumn,
} from './logic'

const CELL = 13
const GAP = 3
const HEIGHT = 7 * CELL + 6 * GAP

export interface HabitGridProps {
  habit: Habit
  entries: Entries
  today: string
  onPick: (date: string) => void
  onPickPeriod: (period: { start: string; end: string; title: string }) => void
}

function Scroller({ children }: { children: React.ReactNode }) {
  const ref = useRef<ScrollView>(null)
  return (
    <ScrollView
      ref={ref}
      horizontal
      showsHorizontalScrollIndicator={false}
      // No bounce at the ends, so a swipe past the newest week goes on to the next
      // Productivity page instead of rubber-banding the grid.
      bounces={false}
      onContentSizeChange={() => ref.current?.scrollToEnd({ animated: false })}
      contentContainerStyle={{ paddingBottom: 2 }}
    >
      <View>{children}</View>
    </ScrollView>
  )
}

function MonthLabels({ labels, pitch, width }: { labels: { col: number; label: string }[]; pitch: number; width: number }) {
  return (
    <View style={{ height: 14, marginBottom: 4, width }}>
      {labels.map((m) => (
        <T key={`${m.label}-${m.col}`} size={10} muted lineHeight={13} style={{ position: 'absolute', left: m.col * pitch }}>{m.label}</T>
      ))}
    </View>
  )
}

/**
 * How far down the pressed column the touch landed. Native gives locationY; the
 * react-native-web preview leaves it undefined, so measure there from the DOM.
 */
function offsetY(e: GestureResponderEvent): number {
  const ne = e.nativeEvent as GestureResponderEvent['nativeEvent'] & { clientY?: number }
  if (Number.isFinite(ne.locationY)) return ne.locationY
  const rect = (e.currentTarget as unknown as { getBoundingClientRect?: () => { top: number } }).getBoundingClientRect?.()
  return rect ? (ne.clientY ?? ne.pageY) - rect.top : 0
}

function DayGrid({ habit, entries, today, onPick }: HabitGridProps) {
  const { weeks, labels } = useMemo(() => {
    const todayDow = dayOfWeek(today)
    const weeks: { date: string; future: boolean }[][] = []
    for (let w = 0; w < GRID_WEEKS; w++) {
      const col: { date: string; future: boolean }[] = []
      for (let d = 0; d < 7; d++) {
        const offset = -((GRID_WEEKS - 1 - w) * 7 + todayDow - d)
        col.push({ date: addDays(today, offset), future: offset > 0 })
      }
      weeks.push(col)
    }
    return { weeks, labels: monthLabelsForWeeks(weekStartsOf(today)) }
  }, [today])

  return (
    <Scroller>
      <MonthLabels labels={labels} pitch={CELL + GAP} width={GRID_WEEKS * (CELL + GAP)} />
      <View style={{ flexDirection: 'row', gap: GAP }}>
        {weeks.map((col) => (
          <Press
            key={col[0].date}
            accessibilityLabel={`${habit.name}, week of ${col[0].date}`}
            onPress={(e) => {
              const row = Math.min(6, Math.max(0, Math.floor(offsetY(e) / (CELL + GAP))))
              const cell = col[row]
              if (!cell || cell.future) return
              tap()
              onPick(cell.date)
            }}
            style={{ gap: GAP }}
          >
            {col.map(({ date, future }) => {
              // Cells take no touches, so the column is the touch target and
              // locationY is measured from its top (on iOS it is relative to
              // whichever view was hit, which would make every tap row 0).
              if (future) return <View key={date} pointerEvents="none" style={{ width: CELL, height: CELL }} />
              const e = entries[date]?.[habit.id]
              const level = levelOf(e?.count || 0, habit.target)
              return (
                <View
                  key={date}
                  pointerEvents="none"
                  style={[
                    s.cell,
                    level ? { backgroundColor: mixHex(habit.color, colors.bg3, LEVEL_MIX[level]) } : null,
                    date === today && { borderColor: colors.text },
                  ]}
                >
                  {e?.note ? <View style={[s.noteDot, { backgroundColor: level ? colors.bg : colors.muted }]} /> : null}
                </View>
              )
            })}
          </Press>
        ))}
      </View>
    </Scroller>
  )
}

function PeriodGrid({ habit, onPickPeriod, columns, labels, columnGap }: HabitGridProps & {
  columns: PeriodColumn[]
  labels: { col: number; label: string }[]
  columnGap: number
}) {
  return (
    <Scroller>
      <MonthLabels labels={labels} pitch={CELL + columnGap} width={columns.length * (CELL + columnGap)} />
      <View style={{ flexDirection: 'row', gap: columnGap }}>
        {columns.map((col) => {
          if (col.future) return <View key={col.key} style={{ width: CELL, height: HEIGHT }} />
          const gauge = periodGauge(habit.target, col.count)
          return (
            <Press
              key={col.key}
              haptic
              accessibilityLabel={`${col.label}: ${col.count}/${habit.target}${gauge.met ? ' ✓' : ''}`}
              onPress={() => onPickPeriod({ start: col.start, end: col.end, title: col.label })}
              style={[s.col, col.inCurrent && { borderColor: textAlpha(45) }]}
            >
              {gauge.ratio > 0 && (
                <View style={[
                  s.fill,
                  { height: `${gauge.ratio * 100}%`, backgroundColor: habit.color },
                  gauge.met && { borderWidth: 1, borderColor: alpha('#ffffff', 0.18) },
                ]} />
              )}
              {col.noted ? <View style={[s.noteDot, { top: 3, right: 3, backgroundColor: gauge.met ? colors.bg : colors.muted }]} /> : null}
            </Press>
          )
        })}
      </View>
    </Scroller>
  )
}

export default function HabitGrid(props: HabitGridProps) {
  const { habit, entries, today } = props
  const weekly = useMemo(() => (habit.cadence === 'weekly' ? weekColumns(habit, entries, today) : null), [habit, entries, today])
  const monthly = useMemo(() => (habit.cadence === 'monthly' ? monthColumns(habit, entries, today) : null), [habit, entries, today])
  if (weekly) return <PeriodGrid {...props} columns={weekly.columns} labels={weekly.labels} columnGap={GAP} />
  if (monthly) return <PeriodGrid {...props} columns={monthly.columns} labels={monthly.labels} columnGap={16} />
  return <DayGrid {...props} />
}

const s = StyleSheet.create({
  cell: {
    width: CELL, height: CELL, borderRadius: 3,
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: alpha('#ffffff', 0.04),
  },
  noteDot: { position: 'absolute', top: 2, right: 2, width: 3, height: 3, borderRadius: 2, opacity: 0.9 },
  col: {
    width: CELL, height: HEIGHT, borderRadius: 4, overflow: 'hidden',
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: alpha('#ffffff', 0.04),
  },
  fill: { position: 'absolute', left: 0, right: 0, bottom: 0 },
})
