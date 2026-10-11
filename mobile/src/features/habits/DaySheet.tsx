// One habit-day (HabitsView.tsx DayModal): completions, the habit's number and its
// breakdown, and a note. Opened from a grid dot or a check-in row's note button.
import React, { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { T } from '../../ui/Text'
import { Btn, Empty } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { logHabit } from '../../lib/api'
import { pushToast } from '../../lib/toast'
import { Field, FieldInput, Sheet, closeSheet } from './form'
import { Stepper } from './CheckRow'
import { CADENCE_NOUN, dayLabel, type Entry, type Habit } from './logic'
import { mutate, useHabits } from './store'

export default function DaySheet() {
  const { id, date } = useLocalSearchParams<{ id: string; date: string }>()
  const { data } = useHabits()
  const habit = data?.habits.find((h) => h.id === id)
  if (!habit || !date) return <Sheet title="Habit"><Empty title="That habit is gone." /></Sheet>
  return <DayForm habit={habit} date={date} entry={data?.entries[date]?.[habit.id]} />
}

export function HabitKicker({ habit }: { habit: Habit }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
      <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: habit.color }} />
      <T size={12} muted>{habit.name}</T>
    </View>
  )
}

function DayForm({ habit, date, entry }: { habit: Habit; date: string; entry: Entry | undefined }) {
  const [count, setCount] = useState(entry?.count || 0)
  const [note, setNote] = useState(entry?.note || '')
  // Metric fields stay strings while typed; '' means "cleared".
  const [value, setValue] = useState(entry?.value != null ? String(entry.value) : '')
  const [parts, setParts] = useState<Record<string, string>>(() =>
    Object.fromEntries((habit.metric?.parts || []).map((p) => [p.key, entry?.parts?.[p.key] != null ? String(entry.parts[p.key]) : ''])))
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const fields: any = { id: habit.id, date, count, note: note.trim() }
    if (habit.metric) {
      const trimmed = value.trim()
      if (trimmed && !Number.isFinite(Number(trimmed))) { pushToast(`${habit.metric.label} must be a number.`); return }
      fields.value = trimmed ? Number(trimmed) : null
      fields.parts = Object.fromEntries(habit.metric.parts.map((p) => {
        const raw = (parts[p.key] || '').trim()
        return [p.key, raw ? Number(raw) : null]
      }))
      if (Object.values(fields.parts as Record<string, number | null>).some((n) => n != null && !Number.isFinite(n))) {
        pushToast('Breakdown values must be numbers.'); return
      }
    }
    setBusy(true)
    try {
      await mutate(() => logHabit(fields))
      if (count > (entry?.count || 0)) success()
      closeSheet()
    } catch (e: any) { pushToast(e.message); setBusy(false) }
  }

  const unit = habit.metric?.unit ? ` (${habit.metric.unit})` : ''
  return (
    <Sheet
      kicker={<HabitKicker habit={habit} />}
      title={dayLabel(date)}
      footer={
        <>
          <Btn title="Cancel" onPress={closeSheet} disabled={busy} />
          <Btn kind="primary" title={busy ? 'Saving…' : 'Save day'} onPress={save} disabled={busy} />
        </>
      }
    >
      <Field label={`Completions ${habit.target > 1 || habit.cadence !== 'daily' ? `(target ${habit.target}/${CADENCE_NOUN[habit.cadence]})` : ''}`}>
        <Stepper
          big size={44} count={count} color={habit.color} busy={busy}
          onStep={(d) => setCount((c) => Math.min(999, Math.max(0, c + d)))}
          labelLess="One less" labelMore="One more"
        />
      </Field>
      {habit.metric && (
        <>
          <Field label={`${habit.metric.label}${unit}`}>
            <FieldInput value={value} onChangeText={setValue} keyboardType="numbers-and-punctuation" returnKeyType="done" placeholder="Leave empty for none" />
          </Field>
          {habit.metric.parts.length > 0 && (
            <Field label={`Breakdown${unit}`}>
              <View style={s.parts}>
                {habit.metric.parts.map((p) => (
                  <View key={p.key} style={s.part}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.color }} />
                      <T size={11.5} muted>{p.label}</T>
                    </View>
                    <FieldInput
                      value={parts[p.key] || ''}
                      onChangeText={(v) => setParts((cur) => ({ ...cur, [p.key]: v }))}
                      keyboardType="numbers-and-punctuation" returnKeyType="done"
                    />
                  </View>
                ))}
              </View>
            </Field>
          )}
        </>
      )}
      <Field label="Note">
        <FieldInput value={note} onChangeText={setNote} placeholder="How did it go?" multiline />
      </Field>
    </Sheet>
  )
}

const s = StyleSheet.create({
  parts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  part: { width: '48%', gap: 4 },
})
