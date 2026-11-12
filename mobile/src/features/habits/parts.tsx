// The small pieces a habit row is built from (HabitsView.tsx: the − n/target +
// stepper, HabitMetricInput and QuotaDots), shared with the day, period and
// check-in sheets. The row itself is HabitRow.tsx and its check Check.tsx.
import React, { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { colors, alpha, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { Hi, MinusIcon, PlusIcon } from '../../lib/icons'
import { periodGauge, periodLabel, type Entry, type Habit } from './logic'
import { LinkedMetricValue } from './LinkedApp'

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

const st = StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  step: { backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  quota: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  quotaBar: {
    width: 44, height: 6, borderRadius: 3, overflow: 'hidden',
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: alpha('#ffffff', 0.06),
  },
  metricInput: {
    width: 50, minHeight: 40, paddingVertical: 7, paddingHorizontal: 6, textAlign: 'right',
    fontSize: 16, fontFamily: fonts[600], color: colors.text,
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, borderRadius: 8,
  },
})
