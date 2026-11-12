// One habit on the Habits page (#180). The row is today: name, streak, the last
// seven days, and the big check under the thumb. Tapping the row opens its history
// in place (stats, the year grid, the number chart); long-press is the menu. This
// replaces the old page's two lists (a check-in card, then a history card per habit
// further down) with one.
import React, { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import {
  Hi, ChatBubbleLeftEllipsisIcon, ChatBubbleLeftRightIcon, ChevronDownIcon, FireIcon, MoonIcon, PencilSquareIcon, SunIcon,
} from '../../lib/icons'
import {
  CADENCE_NOUN, LEVEL_MIX, bestStreakOf, mixHex, periodLabel, periodTotal, recentDays, streakOf, totalFor,
  type Entries, type Habit,
} from './logic'
import { HabitMetricInput, QuotaDots, Stepper } from './parts'
import { CheckFace, CHECK, HabitCheck } from './Check'
import { useCalm } from './motion'
import { LinkedAppButton } from './LinkedApp'
import HabitGrid from './HabitGrid'
import { HabitMetricSection } from './MetricChart'


export interface HabitRowProps {
  habit: Habit
  /** The entries with in-flight taps folded in. */
  entries: Entries
  /** The check-in day the row is answering for. */
  date: string
  today: string
  expanded: boolean
  /** The number box is waiting on the bridge. */
  busy: boolean
  onToggle: (habit: Habit) => void
  onLog: (habit: Habit, delta: number) => void
  onValue: (habit: Habit, value: number | null) => void
  onNote: (habit: Habit) => void
  onEdit: (habit: Habit) => void
  onMore: (habit: Habit) => void
  onChat: (habit: Habit) => void
  onPickDay: (habit: Habit, date: string) => void
  onPickPeriod: (habit: Habit, period: { start: string; end: string; title: string }) => void
}

function WhenMark({ habit }: { habit: Habit }) {
  if (habit.when !== 'morning' && habit.when !== 'night') return null
  const night = habit.when === 'night'
  return (
    <View>
      <Hi icon={night ? MoonIcon : SunIcon} size={13} color={colors.muted} />
    </View>
  )
}

/** The flame and its count, brighter once it is a week or more. */
export function StreakChip({ habit, streak }: { habit: Habit; streak: number }) {
  if (streak < 2) return null
  const proud = habit.cadence === 'daily' ? streak >= 7 : streak >= 3
  return (
    <View
      style={[s.streak, proud && { backgroundColor: alpha(colors.amber, 0.14), borderColor: alpha(colors.amber, 0.4) }]}
    >
      <Hi icon={FireIcon} size={12} color={colors.amber} />
      <T size={12} weight={700} color={colors.amber} style={{ fontVariant: ['tabular-nums'] }}>
        {streak}{habit.cadence === 'daily' ? '' : habit.cadence === 'weekly' ? ' wk' : ' mo'}
      </T>
    </View>
  )
}

/** The last seven days, ending on the check-in day: a glance, not a control. */
function WeekStrip({ habit, entries, date }: { habit: Habit; entries: Entries; date: string }) {
  const days = useMemo(() => recentDays(habit, entries, date), [habit, entries, date])
  return (
    <View style={s.strip}>
      {days.map((d, i) => {
        const last = i === days.length - 1
        return (
          <View key={d.date} style={s.stripDay}>
            <View
              style={[
                s.stripDot,
                d.level ? { backgroundColor: mixHex(habit.color, colors.bg3, LEVEL_MIX[d.level]), borderColor: 'transparent' } : null,
                d.skipped && s.stripSkipped,
                last && { borderColor: d.level ? colors.text : textOn(habit.color) },
              ]}
            />
            <T size={10} lineHeight={12} maxFontSizeMultiplier={1.2} color={last ? colors.text : colors.muted} weight={last ? 600 : 400}>{d.letter}</T>
          </View>
        )
      })}
    </View>
  )
}
const textOn = (color: string) => mixHex(color, colors.text, 50)

function Stat({ value, label, accent }: { value: string; label: string; accent?: string }) {
  return (
    <View style={s.stat}>
      <T size={22} weight={700} color={accent ?? colors.text} style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
      <T size={12} muted numberOfLines={1}>{label}</T>
    </View>
  )
}

function History({ habit, entries, today, onEdit, onChat, onPickDay, onPickPeriod }: Pick<HabitRowProps,
  'habit' | 'entries' | 'today' | 'onEdit' | 'onChat' | 'onPickDay' | 'onPickPeriod'>) {
  const streak = streakOf(habit, entries, today)
  const best = bestStreakOf(habit, entries, today)
  const unit = CADENCE_NOUN[habit.cadence]
  const calm = useCalm()
  return (
    <Animated.View entering={calm ? undefined : FadeIn.duration(200)} exiting={calm ? undefined : FadeOut.duration(120)} style={s.history}>
      <View style={s.stats}>
        <Stat value={String(streak)} label={`${unit} streak`} accent={streak > 1 ? colors.amber : undefined} />
        <Stat value={String(best)} label="best streak" />
        <Stat value={String(totalFor(habit, entries))} label="past year" />
      </View>
      {habit.cadence !== 'daily' && (
        <View style={{ marginBottom: 10 }}><QuotaDots habit={habit} count={periodTotal(habit, entries, today)} /></View>
      )}
      <HabitGrid
        habit={habit}
        entries={entries}
        today={today}
        onPick={(date) => onPickDay(habit, date)}
        onPickPeriod={(period) => onPickPeriod(habit, period)}
      />
      {habit.metric && <HabitMetricSection habit={habit} entries={entries} today={today} />}
      <View style={s.historyActions}>
        <Btn compact icon={PencilSquareIcon} title="Edit habit" onPress={() => onEdit(habit)} style={s.historyBtn} />
        <Btn compact icon={ChatBubbleLeftRightIcon} title="Chat about it" onPress={() => onChat(habit)} style={s.historyBtn} />
      </View>
    </Animated.View>
  )
}

export default function HabitRow(props: HabitRowProps) {
  const { habit, entries, date, today, expanded, busy, onToggle, onLog, onValue, onNote, onMore } = props
  const entry = entries[date]?.[habit.id]
  const count = entry?.count || 0
  const periodCount = periodTotal(habit, entries, date)
  const streak = streakOf(habit, entries, today)
  const multi = habit.cadence === 'daily' && habit.target > 1
  const sub = entry?.note || habit.description
  const finished = habit.cadence === 'daily' ? count >= Math.max(1, habit.target) : periodCount >= Math.max(1, habit.target)
  const calm = useCalm()
  // A number box beside the row's other controls leaves the name no room on a
  // phone, so a habit with one puts its controls on a line of their own.
  const crowded = Boolean(habit.metric)
  const recent = recentDays(habit, entries, date).filter((d) => d.level > 0).length
  const unit = CADENCE_NOUN[habit.cadence]
  // The row is one VoiceOver element, so it says everything its pieces show.
  const spoken = [
    habit.name,
    habit.when === 'night' ? 'a night habit, logged the next morning' : habit.when === 'morning' ? 'a morning habit' : '',
    sub,
    streak > 1 ? `${streak}-${unit} streak` : '',
    habit.cadence !== 'daily' ? `${periodCount} of ${habit.target} ${periodLabel(habit.cadence)}` : '',
    `done ${recent} of the last 7 days`,
  ].filter(Boolean).join(', ')

  let control: React.ReactNode
  if (habit.linkedApp) {
    // An app fills this one in: the same face, filling as it does, but not a
    // button; the link beside it goes to the app.
    control = (
      <View style={s.linked}>
        <LinkedAppButton habit={habit} compact />
        <View accessible accessibilityRole="image" accessibilityLabel={`${habit.name}: ${count > 0 ? 'done' : 'not yet'}, filled in by its app`} style={{ width: CHECK, height: CHECK }}>
          <CheckFace habit={habit} count={count} periodCount={periodCount} />
        </View>
      </View>
    )
  } else if (multi) {
    control = (
      <Stepper
        size={44} count={count} target={habit.target} color={habit.color}
        onStep={(d) => onLog(habit, d)}
        labelLess={`Undo one ${habit.name}`} labelMore={`Log one ${habit.name}`}
      />
    )
  } else {
    control = <HabitCheck habit={habit} count={count} periodCount={periodCount} onLog={onLog} />
  }

  const controls = (
    <>
      {habit.metric && <HabitMetricInput habit={habit} entry={entry} busy={busy} onValue={onValue} />}
      {!habit.linkedApp && (
        <Press
          haptic
          onPress={() => onNote(habit)}
          hitSlop={6}
          accessibilityLabel={entry?.note ? `Note: ${entry.note}` : `Add a note to ${habit.name}`}
          style={s.noteBtn}
        >
          <Hi icon={ChatBubbleLeftEllipsisIcon} size={18} color={entry?.note ? colors.accent : colors.muted} />
        </Press>
      )}
      {control}
    </>
  )

  return (
    <Animated.View layout={calm ? undefined : LinearTransition.duration(220)} style={[s.card, finished && { borderColor: alpha(habit.color, 0.35) }]}>
      <View style={s.row}>
        <Press
          onPress={() => onToggle(habit)}
          onLongPress={() => onMore(habit)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={spoken}
          accessibilityHint={expanded ? 'Hides its history' : 'Shows its history. Long-press for more.'}
          style={s.main}
        >
          <View style={s.titleLine}>
            <View style={[s.dot, { backgroundColor: habit.color }]} />
            <T size={16} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>{habit.name}</T>
            <WhenMark habit={habit} />
            <StreakChip habit={habit} streak={streak} />
            {habit.cadence !== 'daily' && <QuotaDots habit={habit} count={periodCount} compact />}
            <View style={{ flex: 1 }} />
            <View style={[s.chev, expanded && { transform: [{ rotate: '180deg' }] }]}>
              <Hi icon={ChevronDownIcon} size={14} color={colors.muted} />
            </View>
          </View>
          {sub ? <T size={12.5} muted numberOfLines={1} style={{ marginLeft: 18 }}>{sub}</T> : null}
          <View style={s.stripLine}>
            <WeekStrip habit={habit} entries={entries} date={date} />
          </View>
        </Press>
        {!crowded && controls}
      </View>
      {crowded && (
        <View style={s.controlsLine}>
          {/* Names the number box, which has the line to itself. */}
          <T size={13} muted numberOfLines={1} style={{ flex: 1, marginLeft: 18 }} importantForAccessibility="no" accessibilityElementsHidden>
            {habit.metric!.label}{habit.metric!.unit ? ` (${habit.metric!.unit})` : ''}
          </T>
          {controls}
        </View>
      )}
      {expanded && <History {...props} />}
    </Animated.View>
  )
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 14,
    paddingVertical: 12, paddingLeft: 14, paddingRight: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  main: { flex: 1, minWidth: 0, gap: 4, alignSelf: 'stretch', justifyContent: 'center' },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 3 },
  streak: {
    flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 1,
    borderRadius: 999, borderWidth: 1, borderColor: 'transparent',
  },
  stripLine: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, marginLeft: 18 },
  strip: { flexDirection: 'row', gap: 5 },
  stripDay: { alignItems: 'center', gap: 3 },
  stripDot: { width: 12, height: 12, borderRadius: 3, backgroundColor: colors.bg3, borderWidth: 1, borderColor: alpha('#ffffff', 0.14) },
  stripSkipped: { borderStyle: 'dashed', borderColor: colors.muted },
  chev: { width: 18, alignItems: 'center' },
  controlsLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  noteBtn: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  linked: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  history: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line, marginRight: 2 },
  stats: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  stat: { flex: 1, backgroundColor: colors.bg, borderRadius: 10, borderWidth: 1, borderColor: colors.line, paddingVertical: 10, paddingHorizontal: 10, gap: 2 },
  historyActions: { flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  historyBtn: { minHeight: 44 },
})
