// The event detail sheet: the web's EventModal (CalendarView.tsx) in its phone
// layout, as a form sheet. Same fields and the same payload to updateCalendarEvent;
// the dates are native pickers instead of <input type="datetime-local">.
import React, { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Empty, Toggle } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { ArrowTopRightOnSquareIcon } from '../../lib/icons'
import { AuthError, updateCalendarEvent } from '../../lib/api'
import { clearSecretStored } from '../../lib/connection'
import { pushError } from '../../lib/toast'
import { Field, FieldInput, SheetFrame, actionStyle } from '../productivity/SheetFrame'
import DateField from './DateField'
import { emitEventSaved, getSelectedEvent } from './eventStore'
import {
  allDayEndForApi, allDayEndForInput, fromInput, parseDate, toDateInput, toDateTimeInput, type CalEvent,
} from './dates'

export default function EventSheet() {
  const event = getSelectedEvent()
  if (!event) {
    return <View style={{ flex: 1, backgroundColor: colors.bg2 }}><Empty title="That event is no longer open." /></View>
  }
  return <EventForm event={event} />
}

function EventForm({ event }: { event: CalEvent }) {
  const [form, setForm] = useState(() => ({
    title: event.title === '(no title)' ? '' : event.title,
    location: event.location || '',
    description: event.description || '',
    allDay: Boolean(event.allDay),
    start: event.allDay ? event.start : toDateTimeInput(parseDate(event.start)),
    end: event.allDay ? allDayEndForInput(event.end || event.start) : toDateTimeInput(parseDate(event.end || event.start)),
  }))
  const [saving, setSaving] = useState(false)

  const set = (key: keyof typeof form, value: any) => setForm((f) => ({ ...f, [key]: value }))
  const fmt = (allDay: boolean, d: Date) => (allDay ? toDateInput(d) : toDateTimeInput(d))
  // Moving the start carries the end with it, keeping the length (as iOS Calendar
  // does), so a moved event never ends before it starts and Google never refuses it.
  const setStart = (d: Date) => setForm((f) => {
    const length = Math.max(0, +fromInput(f.end) - +fromInput(f.start))
    return { ...f, start: fmt(f.allDay, d), end: fmt(f.allDay, new Date(+d + length)) }
  })
  const setEnd = (d: Date) => setForm((f) => ({ ...f, end: fmt(f.allDay, d) }))

  const submit = async () => {
    setSaving(true)
    try {
      const payload = {
        id: event.id,
        title: form.title.trim() || '(no title)',
        location: form.location,
        description: form.description,
        allDay: form.allDay,
        start: form.start,
        end: form.allDay ? allDayEndForApi(form.end || form.start) : form.end,
      }
      const { event: saved } = await updateCalendarEvent(payload)
      emitEventSaved(saved)
      success()
      router.back()
    } catch (e: any) {
      if (e instanceof AuthError) { void clearSecretStored(); return }
      pushError(e?.message || 'The event could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const close = () => router.back()
  return (
    <SheetFrame
      kicker={`${event.account} calendar`}
      title="Event details"
      onClose={close}
      actions={(
        <>
          {event.htmlLink ? (
            <Btn
              title="Open in Google"
              icon={ArrowTopRightOnSquareIcon}
              style={[actionStyle, { flexBasis: '100%' }]}
              onPress={() => { void WebBrowser.openBrowserAsync(event.htmlLink) }}
            />
          ) : null}
          <Btn title="Cancel" onPress={close} style={actionStyle} />
          <Btn title={saving ? 'Saving…' : 'Save changes'} kind="primary" disabled={saving} onPress={submit} style={actionStyle} />
        </>
      )}
    >
      <Field label="Title">
        <FieldInput value={form.title} onChangeText={(v) => set('title', v)} placeholder="(no title)" returnKeyType="done" />
      </Field>

      <View style={st.checkRow}>
        <T style={{ flex: 1 }}>All day</T>
        <Toggle
          value={form.allDay}
          onChange={(checked) => setForm((f) => (checked
            ? { ...f, allDay: true, start: f.start.slice(0, 10), end: f.end.slice(0, 10) }
            : { ...f, allDay: false, start: `${f.start.slice(0, 10)}T09:00`, end: `${f.end.slice(0, 10)}T10:00` }))}
        />
      </View>

      {/* One per row, as .field-row is on a phone: two date-and-time pickers side
          by side don't fit 390pt. */}
      <Field label="Starts">
        <DateField value={fromInput(form.start)} mode={form.allDay ? 'date' : 'datetime'} onChange={setStart} />
      </Field>
      <Field label={form.allDay ? 'Ends on' : 'Ends'}>
        <DateField value={fromInput(form.end)} mode={form.allDay ? 'date' : 'datetime'} onChange={setEnd} />
      </Field>

      <Field label="Location">
        <FieldInput value={form.location} onChangeText={(v) => set('location', v)} />
      </Field>

      <Field label="Description">
        <FieldInput value={form.description} onChangeText={(v) => set('description', v)} multiline scrollEnabled={false} style={{ minHeight: 104 }} />
      </Field>
    </SheetFrame>
  )
}

const st = StyleSheet.create({
  checkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48,
    paddingHorizontal: 12, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: 8,
  },
})
