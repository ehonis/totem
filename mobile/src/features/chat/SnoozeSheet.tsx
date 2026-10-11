// Sheet detents: [0.5] (formSheet, grabber, corner radius 22; registered in src/app/_layout.tsx).
//
// "Custom…" in a chat's Snooze menu (web chat/SnoozeMenu.tsx's form, as T3's
// custom snooze sheet): a date and time, or a duration. The presets live in the
// chat's native menu; this is only the custom form.
import React, { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { customSnooze, HOUR_MS, wakeDescription } from '../../lib/chat/settle'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Segmented } from '../../ui/kit'
import { snoozeThread } from './threadOps'
import { vc } from './ui'

const pad = (n: number) => String(n).padStart(2, '0')
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

function Field(props: React.ComponentProps<typeof TextInput>) {
  return <TextInput placeholderTextColor={colors.muted} keyboardAppearance="dark" selectionColor={colors.accent} {...props} style={[st.field, props.style]} />
}

export default function SnoozeSheet() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const insets = useSafeAreaInsets()
  const start = useMemo(() => new Date(Date.now() + HOUR_MS), [])
  const [mode, setMode] = useState<'date' | 'duration'>('date')
  const [date, setDate] = useState(dateValue(start))
  const [time, setTime] = useState(timeValue(start))
  const [amount, setAmount] = useState('2')
  const [unit, setUnit] = useState<'minutes' | 'hours' | 'days'>('hours')
  const out = customSnooze(mode === 'date' ? { mode, date, time } : { mode, amount: Number(amount), unit }, Date.now())
  const [shownError, setShownError] = useState('')
  function submit() {
    if ('error' in out) { setShownError(out.error); return }
    snoozeThread(id, out.until)
    router.back()
  }
  return (
    <ScrollView style={{ backgroundColor: colors.bg2 }} contentContainerStyle={{ padding: 18, paddingTop: 24, paddingBottom: insets.bottom + 18, gap: 14 }} keyboardShouldPersistTaps="handled">
      <T size={17} weight={600}>Snooze until…</T>
      <Segmented
        value={mode}
        onChange={(v) => { setMode(v); setShownError('') }}
        options={[{ value: 'date', label: 'Date and time' }, { value: 'duration', label: 'Duration' }]}
      />
      {mode === 'date' ? (
        <View style={st.row}>
          <Field value={date} onChangeText={setDate} placeholder="2026-10-08" accessibilityLabel="Date (year-month-day)" autoCorrect={false} />
          <Field value={time} onChangeText={setTime} placeholder="09:00" accessibilityLabel="Time (24-hour)" keyboardType="numbers-and-punctuation" style={{ flex: 0.6 }} />
        </View>
      ) : (
        <View style={st.row}>
          <Field value={amount} onChangeText={setAmount} keyboardType="number-pad" accessibilityLabel="Snooze for" autoFocus style={{ flex: 0.5 }} />
          <Segmented
            style={{ flex: 1 }}
            value={unit}
            onChange={setUnit}
            options={[{ value: 'minutes', label: 'Min' }, { value: 'hours', label: 'Hours' }, { value: 'days', label: 'Days' }]}
          />
        </View>
      )}
      <T size={13} color={shownError ? '#ff7a8f' : vc.soft}>
        {shownError || ('until' in out ? `Wakes ${wakeDescription(out.until, Date.now())}` : ' ')}
      </T>
      <View style={[st.row, { justifyContent: 'flex-end' }]}>
        <Btn kind="ghost" title="Cancel" onPress={() => router.back()} />
        <Btn kind="primary" title="Snooze" onPress={submit} />
      </View>
    </ScrollView>
  )
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  field: {
    flex: 1, height: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.bg, color: colors.text, fontSize: 16, fontFamily: fonts[400],
  },
})
