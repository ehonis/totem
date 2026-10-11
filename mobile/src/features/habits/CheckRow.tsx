// One habit in the nightly check-in list (HabitsView.tsx CheckRow and the pieces it
// is built from: HabitCheckButton, the − n/target + stepper, HabitMetricInput and
// QuotaDots). Phone sizes from the web's max-width: 720px rules. No drag handle:
// the web hides it on a phone too.
import React, { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'
import { colors, alpha, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { Hi, ChatBubbleLeftEllipsisIcon, CheckIcon, MinusIcon, PlusIcon } from '../../lib/icons'
import { mixHex, periodGauge, periodLabel, type Entry, type Habit } from './logic'
import { LinkedAppButton, LinkedMetricValue } from './LinkedApp'

const CHECK = 46

/** A clockwise wedge from 12 o'clock — the conic-gradient pie, as a path. */
function wedge(r: number, cx: number, cy: number, ratio: number): string {
  const a = ratio * 2 * Math.PI
  const x = cx + r * Math.sin(a)
  const y = cy - r * Math.cos(a)
  return `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${ratio > 0.5 ? 1 : 0} 1 ${x} ${y} Z`
}

// Daily habits fill solid the moment they're logged. Capped weekly/monthly ones fill
// as a pie — one slice per completion in the period — so the button only goes solid
// once the quota is met. The check mark is about the day being checked in.
export function HabitCheckButton({ habit, count, periodCount, busy, onLog }: {
  habit: Habit
  count: number
  periodCount: number
  busy: boolean
  onLog: (habit: Habit, delta: number) => void
}) {
  const capped = habit.cadence !== 'daily'
  const target = Math.max(1, habit.target)
  const ratio = capped ? Math.min(1, periodCount / target) : count > 0 ? 1 : 0
  const full = ratio >= 1
  const done = count > 0
  const progress = capped ? `, ${periodCount} of ${target} ${periodLabel(habit.cadence)}` : ''
  const label = done ? `${habit.name}: done — tap to undo${progress}` : `Mark ${habit.name} done${progress}`
  const border = capped
    ? (full ? habit.color : mixHex(habit.color, colors.line, 40))
    : done ? habit.color : colors.line
  const r = CHECK / 2
  const circle = (
    <>
      <Svg width={CHECK} height={CHECK} style={StyleSheet.absoluteFill}>
        <Circle cx={r} cy={r} r={r - 0.75} fill={!capped && done ? habit.color : colors.bg} />
        {capped && ratio > 0 && (ratio >= 1
          ? <Circle cx={r} cy={r} r={r - 0.75} fill={habit.color} />
          : <Path d={wedge(r - 0.75, r, r, ratio)} fill={habit.color} />)}
        <Circle cx={r} cy={r} r={r - 0.75} fill="none" stroke={border} strokeWidth={1.5} />
      </Svg>
      {done ? (
        <View style={st.checkMark}>
          <Hi icon={CheckIcon} size={20} color={colors.white} strokeWidth={2} />
        </View>
      ) : null}
    </>
  )
  // An app fills this one in: the same circle, filling as it does, but not a
  // button; the link beside it goes to the app.
  if (habit.linkedApp) {
    return (
      <View style={st.linkedPair}>
        <LinkedAppButton habit={habit} compact />
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={`${habit.name}: ${done ? 'done' : 'not yet'}${progress}, filled in by its app`}
          style={{ width: CHECK, height: CHECK }}
        >
          {circle}
        </View>
      </View>
    )
  }
  return (
    <Press
      onPress={() => onLog(habit, done ? -1 : +1)}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ width: CHECK, height: CHECK }}
    >
      {circle}
    </Press>
  )
}

/** The − count/target + stepper for multi-per-day habits (and the day sheets). */
export function Stepper({ count, target, color, busy, onStep, size = 42, big, labelLess, labelMore }: {
  count: number
  target?: number
  color: string
  busy?: boolean
  onStep: (delta: number) => void
  size?: number
  big?: boolean
  labelLess: string
  labelMore: string
}) {
  const step = (delta: number, disabled: boolean, icon: any, label: string) => (
    <Press
      haptic
      onPress={() => onStep(delta)}
      disabled={disabled}
      accessibilityLabel={label}
      style={[st.step, { width: size, height: size, borderRadius: size <= 28 ? 8 : 10 }]}
    >
      <Hi icon={icon} size={size <= 28 ? 15 : 16} color={colors.text} />
    </Press>
  )
  return (
    <View style={[st.stepper, big && { justifyContent: 'center', paddingVertical: 4 }, size <= 28 && { gap: 4 }]}>
      {step(-1, Boolean(busy) || count <= 0, MinusIcon, labelLess)}
      <T
        size={big ? 22 : size <= 28 ? 14 : 15}
        weight={600}
        color={count > 0 ? color : colors.muted}
        align="center"
        style={{ minWidth: big ? 56 : size <= 28 ? 20 : 40, fontVariant: ['tabular-nums'] }}
      >
        {count}
        {target ? <T size={11} color={colors.muted}>/{target}</T> : null}
      </T>
      {step(+1, Boolean(busy), PlusIcon, labelMore)}
    </View>
  )
}

/** QuotaDots: "1/4 wk", with the sideways tube unless `compact`. */
export function QuotaDots({ habit, count, compact }: { habit: Habit; count: number; compact?: boolean }) {
  const gauge = periodGauge(habit.target, count)
  return (
    <View style={st.quota} accessibilityLabel={`${count} of ${habit.target} ${periodLabel(habit.cadence)}`}>
      {!compact && (
        <View style={st.quotaBar}>
          {gauge.ratio > 0 && <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${gauge.ratio * 100}%`, backgroundColor: habit.color }} />}
        </View>
      )}
      <T size={11} weight={gauge.met ? 600 : 400} color={gauge.met ? habit.color : colors.muted} style={{ fontVariant: ['tabular-nums'] }}>
        {count}/{habit.target} {habit.cadence === 'weekly' ? 'wk' : 'mo'}
      </T>
    </View>
  )
}

// Inline number entry. Typing is local until blur/submit so a refreshed payload
// can't clobber a half-typed number, and only a real change is sent.
export function HabitMetricInput({ habit, entry, busy, onValue }: {
  habit: Habit
  entry: Entry | undefined
  busy: boolean
  onValue: (habit: Habit, value: number | null) => void
}) {
  const metric = habit.metric!
  const [draft, setDraft] = useState<string | null>(null)
  if (habit.linkedApp) return <LinkedMetricValue habit={habit} value={entry?.value} />
  const saved = entry?.value != null ? String(entry.value) : ''
  const shown = draft ?? saved

  const commit = () => {
    if (draft === null) return
    const text = draft.trim()
    setDraft(null)
    if (text && !Number.isFinite(Number(text))) return
    const next = text ? Number(text) : null
    if (next === (entry?.value ?? null)) return
    onValue(habit, next)
  }

  return (
    <TextInput
      value={shown}
      placeholder="—"
      placeholderTextColor={colors.muted}
      editable={!busy}
      keyboardType="numbers-and-punctuation"
      keyboardAppearance="dark"
      returnKeyType="done"
      selectTextOnFocus
      accessibilityLabel={`${metric.label} for ${habit.name}`}
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={commit}
      style={[st.metricInput, shown ? { color: habit.color } : null, busy && { opacity: 0.5 }]}
    />
  )
}

export function CheckRow({ habit, entry, periodCount, busy, onLog, onValue, onNote, onEdit, onMore, first }: {
  habit: Habit
  entry: Entry | undefined
  periodCount: number
  busy: boolean
  onLog: (habit: Habit, delta: number) => void
  onValue: (habit: Habit, value: number | null) => void
  onNote: (habit: Habit) => void
  /** Tapping the name: the phone's way in to editing a habit (the web's pencil sits far below, on its history card). */
  onEdit?: (habit: Habit) => void
  /** Long-press: the row's actions as a native sheet. */
  onMore?: (habit: Habit) => void
  first?: boolean
}) {
  const count = entry?.count || 0
  const done = periodCount >= habit.target
  const sub = entry?.note || habit.description
  return (
    <View style={[st.row, !first && st.rowRule]}>
      <Press
        onPress={onEdit ? () => onEdit(habit) : undefined}
        onLongPress={onMore ? () => onMore(habit) : undefined}
        disabled={!onEdit && !onMore}
        accessibilityRole="button"
        accessibilityLabel={`${habit.name}, edit habit`}
        style={st.main}
      >
        <View style={[st.dot, { backgroundColor: habit.color }]} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={15} weight={500} numberOfLines={1} color={done ? colors.muted : colors.text}>{habit.name}</T>
          {sub ? <T size={12} muted numberOfLines={1} style={{ marginTop: 1 }}>{sub}</T> : null}
        </View>
      </Press>
      {habit.cadence !== 'daily' && <QuotaDots habit={habit} count={periodCount} compact />}
      {habit.metric && <HabitMetricInput habit={habit} entry={entry} busy={busy} onValue={onValue} />}
      {!habit.linkedApp && (
        <Press
          haptic
          onPress={() => onNote(habit)}
          accessibilityLabel={entry?.note ? `Note: ${entry.note}` : 'Add a note'}
          style={st.noteBtn}
        >
          <Hi icon={ChatBubbleLeftEllipsisIcon} size={17} color={entry?.note ? colors.accent : colors.muted} />
        </Press>
      )}
      {habit.cadence === 'daily' && habit.target > 1 && !habit.linkedApp ? (
        <Stepper
          count={count} target={habit.target} color={habit.color} busy={busy}
          onStep={(d) => onLog(habit, d)}
          labelLess={`Undo one ${habit.name}`} labelMore={`Log one ${habit.name}`}
        />
      ) : (
        <HabitCheckButton habit={habit} count={count} periodCount={periodCount} busy={busy} onLog={onLog} />
      )}
    </View>
  )
}

export const st = StyleSheet.create({
  linkedPair: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingLeft: 14, paddingRight: 12 },
  main: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch' },
  rowRule: { borderTopWidth: 1, borderTopColor: colors.line },
  dot: { width: 10, height: 10, borderRadius: 3 },
  checkMark: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  noteBtn: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  step: { backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  quota: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  quotaBar: {
    width: 44, height: 6, borderRadius: 3, overflow: 'hidden',
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: alpha('#ffffff', 0.06),
  },
  metricInput: {
    width: 46, paddingVertical: 7, paddingHorizontal: 5, textAlign: 'right',
    fontSize: 14, fontFamily: fonts[600], color: colors.text,
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, borderRadius: 8,
  },
})
