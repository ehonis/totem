// The web's DayModal (HabitsView.tsx) as a form sheet: one habit's day — its
// completions, its number and breakdown when it carries a metric, and a note.
// The Overview hands it the habit and a save callback through openHabitDay(),
// since a route can't carry a function or a whole habit in its params.
import React, { useState } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import { Hi, MinusIcon, PlusIcon } from '../../lib/icons'
import { isoToDate } from '../../lib/components/overview/time'
import { success } from '../../ui/haptics'
import { pushError } from '../../lib/toast'

export interface DaySave {
  count: number
  note: string
  value?: number | null
  parts?: Record<string, number | null>
}

interface Pending {
  habit: any
  date: string
  entry: any
  onSave: (fields: DaySave) => Promise<void>
}

let pending: Pending | null = null

/** Open the day sheet for one habit. `onSave` throws to keep the sheet open. */
export function openHabitDay(p: Pending) {
  pending = p
  router.push('/overview/habit-day')
}

const CADENCE_NOUN: Record<string, string> = { daily: 'day', weekly: 'week', monthly: 'month' }
const dayLabel = (iso: string) => isoToDate(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

export default function HabitDaySheet() {
  const [p] = useState(() => pending)
  const insets = useSafeAreaInsets()
  const habit = p?.habit
  const entry = p?.entry
  const [count, setCount] = useState<number>(entry?.count || 0)
  const [note, setNote] = useState<string>(entry?.note || '')
  const [value, setValue] = useState(entry?.value != null ? String(entry.value) : '')
  const [parts, setParts] = useState<Record<string, string>>(() =>
    Object.fromEntries((habit?.metric?.parts || []).map((x: any) => [x.key, entry?.parts?.[x.key] != null ? String(entry.parts[x.key]) : ''])))
  const [busy, setBusy] = useState(false)

  if (!p || !habit) {
    // Reached without a habit (a cold deep link): nothing to edit.
    return <View style={{ flex: 1, backgroundColor: colors.bg2 }} />
  }

  const save = async () => {
    const fields: DaySave = { count, note: note.trim() }
    if (habit.metric) {
      const trimmed = value.trim()
      if (trimmed && !Number.isFinite(Number(trimmed))) { pushError(`${habit.metric.label} must be a number.`); return }
      fields.value = trimmed ? Number(trimmed) : null
      fields.parts = Object.fromEntries(habit.metric.parts.map((x: any) => {
        const raw = (parts[x.key] || '').trim()
        return [x.key, raw ? Number(raw) : null]
      }))
      if (Object.values(fields.parts!).some((n) => n != null && !Number.isFinite(n))) { pushError('Breakdown values must be numbers.'); return }
    }
    setBusy(true)
    try {
      await p.onSave(fields)
      success()
      router.back()
    } catch (e: any) {
      pushError(e?.message || 'Could not save that day')
      setBusy(false)
    }
  }

  const unit = habit.metric?.unit ? ` (${habit.metric.unit})` : ''
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg2 }}>
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 20, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: habit.color }} />
            <T size={12} muted>{habit.name}</T>
          </View>
          <T size={20} weight={600}>{dayLabel(p.date)}</T>
        </View>

        <View style={st.field}>
          <T size={13} muted>
            Completions {habit.target > 1 || habit.cadence !== 'daily' ? `(target ${habit.target}/${CADENCE_NOUN[habit.cadence]})` : ''}
          </T>
          <View style={st.stepper}>
            <Press haptic onPress={() => setCount((c) => Math.max(0, c - 1))} disabled={busy || count <= 0} accessibilityLabel="One less" style={st.step}>
              <Hi icon={MinusIcon} size={18} />
            </Press>
            <T size={22} weight={600} align="center" color={count > 0 ? habit.color : colors.muted} style={{ minWidth: 56 }}>{count}</T>
            <Press haptic onPress={() => setCount((c) => Math.min(999, c + 1))} disabled={busy} accessibilityLabel="One more" style={st.step}>
              <Hi icon={PlusIcon} size={18} />
            </Press>
          </View>
        </View>

        {habit.metric && (
          <>
            <View style={st.field}>
              <T size={13} muted>{habit.metric.label}{unit}</T>
              <TextInput
                value={value}
                onChangeText={setValue}
                placeholder="Leave empty for none"
                keyboardType="decimal-pad"
                {...inputProps}
              />
            </View>
            {habit.metric.parts.length > 0 && (
              <View style={st.field}>
                <T size={13} muted>Breakdown{unit}</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                  {habit.metric.parts.map((x: any) => (
                    <View key={x.key} style={{ width: '47%', gap: 4 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: x.color }} />
                        <T size={12} muted>{x.label}</T>
                      </View>
                      <TextInput
                        value={parts[x.key] || ''}
                        onChangeText={(t) => setParts((s) => ({ ...s, [x.key]: t }))}
                        keyboardType="decimal-pad"
                        {...inputProps}
                      />
                    </View>
                  ))}
                </View>
              </View>
            )}
          </>
        )}

        <View style={st.field}>
          <T size={13} muted>Note</T>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="How did it go?"
            multiline
            {...inputProps}
            style={[st.input, { minHeight: 64, textAlignVertical: 'top' }]}
          />
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
          <Btn title="Cancel" onPress={() => router.back()} disabled={busy} />
          <Btn title={busy ? 'Saving…' : 'Save day'} kind="primary" onPress={save} disabled={busy} />
        </View>
      </ScrollView>
    </View>
  )
}

const st = StyleSheet.create({
  field: { gap: 6 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 4 },
  step: {
    width: 44, height: 44, borderRadius: 10, backgroundColor: colors.bg3,
    borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center',
  },
  input: {
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: 16, fontFamily: fonts[400],
  },
})

const inputProps = {
  placeholderTextColor: colors.muted,
  selectionColor: colors.accent,
  keyboardAppearance: 'dark' as const,
  style: st.input,
}
