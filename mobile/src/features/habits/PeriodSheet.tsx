// A whole week or month of a weekly/monthly habit (HabitsView.tsx PeriodModal):
// every day that has happened, each with its own stepper and note. Stays open across
// edits: each change logs immediately and the running total updates above.
import React, { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { colors, alpha, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Empty } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { logHabit } from '../../lib/api'
import { pushToast } from '../../lib/toast'
import { Sheet, closeSheet } from './form'
import { Stepper } from './CheckRow'
import { HabitKicker } from './DaySheet'
import { addDays, dayLabel, periodGauge, periodLabel, toDate } from './logic'
import { mutate, useHabits } from './store'
import { LinkedAppButton } from './LinkedApp'

export default function PeriodSheet() {
  const { id, start, end, title } = useLocalSearchParams<{ id: string; start: string; end: string; title: string }>()
  const { data } = useHabits()
  const habit = data?.habits.find((h) => h.id === id)
  const [busyDate, setBusyDate] = useState<string | null>(null)
  // The note being typed, keyed by date, so a half-typed note isn't clobbered by the
  // refreshed payload a count change swaps in.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  if (!habit || !data) return <Sheet title="Habit"><Empty title="That habit is gone." /></Sheet>

  const { entries, today } = data
  const days: string[] = []
  for (let d = start; d <= end && d <= today; d = addDays(d, 1)) days.push(d)
  const total = days.reduce((sum, d) => sum + (entries[d]?.[habit.id]?.count || 0), 0)
  const gauge = periodGauge(habit.target, total)

  const run = async (date: string, fields: { delta?: number; note?: string }): Promise<boolean> => {
    setBusyDate(date)
    try {
      await mutate(() => logHabit({ id: habit.id, date, ...fields }))
      if ((fields.delta ?? 0) > 0) success()
      return true
    } catch (e: any) {
      pushToast(e.message)
      return false
    } finally { setBusyDate(null) }
  }
  const dropDraft = (date: string) => setDrafts(({ [date]: _drop, ...rest }) => rest)
  // Notes save on blur; skip the round trip when nothing changed, and keep the draft if it fails.
  const commitNote = async (date: string) => {
    const draft = drafts[date]
    if (draft === undefined) return
    if (draft.trim() === (entries[date]?.[habit.id]?.note || '')) return dropDraft(date)
    if (await run(date, { note: draft.trim() })) dropDraft(date)
  }

  return (
    <Sheet
      kicker={<HabitKicker habit={habit} />}
      title={title || ''}
      footer={
        <>
          {habit.linkedApp
            ? <View style={{ flex: 1, alignItems: 'flex-start' }}><LinkedAppButton habit={habit} /></View>
            : <T size={12} muted style={{ flex: 1 }}>Notes save when you tap away.</T>}
          <Btn title="Done" onPress={closeSheet} />
        </>
      }
    >
      <View style={s.summary}>
        <View style={s.bar}>
          {gauge.ratio > 0 && <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${gauge.ratio * 100}%`, backgroundColor: habit.color }} />}
        </View>
        <T size={12} weight={600} color={gauge.met ? habit.color : colors.muted} style={{ fontVariant: ['tabular-nums'] }}>
          {total}/{habit.target} {periodLabel(habit.cadence)}
        </T>
      </View>
      <View style={{ marginHorizontal: -14 }}>
        {days.map((date, i) => {
          const entry = entries[date]?.[habit.id]
          const count = entry?.count || 0
          return (
            <View key={date} style={[s.row, i > 0 && { borderTopWidth: 1, borderTopColor: colors.line }, date === today && { backgroundColor: alpha(colors.accent, 0.07) }]}>
              <View style={s.when}>
                <T size={11} muted style={{ letterSpacing: 0.4 }}>{toDate(date).toLocaleDateString([], { weekday: 'short' }).toUpperCase()}</T>
                <T size={14} weight={600} color={count > 0 ? colors.text : colors.muted}>{toDate(date).getDate()}</T>
              </View>
              <TextInput
                style={s.note}
                value={drafts[date] ?? entry?.note ?? ''}
                placeholder={count > 0 ? 'Add a note…' : 'Not done — note why?'}
                placeholderTextColor={alpha(colors.muted, 0.7)}
                keyboardAppearance="dark"
                returnKeyType="done"
                onChangeText={(v) => setDrafts((d) => ({ ...d, [date]: v }))}
                onBlur={() => { void commitNote(date) }}
              />
              {habit.linkedApp ? (
                <T size={14} weight={600} color={count > 0 ? habit.color : colors.muted} style={{ minWidth: 20, textAlign: 'right' }}>{count}</T>
              ) : (
                <Stepper
                  size={28} count={count} color={habit.color} busy={busyDate === date}
                  onStep={(delta) => { void run(date, { delta }) }}
                  labelLess={`One less on ${dayLabel(date)}`} labelMore={`One more on ${dayLabel(date)}`}
                />
              )}
            </View>
          )
        })}
      </View>
    </Sheet>
  )
}

const s = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.line, marginHorizontal: -14, paddingHorizontal: 20 },
  bar: { flex: 1, height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.bg3, borderWidth: 1, borderColor: alpha('#ffffff', 0.06) },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 20 },
  when: { width: 52, flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  note: { flex: 1, minWidth: 0, fontSize: 15, fontFamily: fonts[400], color: colors.text, paddingVertical: 6, paddingHorizontal: 2 },
})
