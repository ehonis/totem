// The web's AwayEditor (components/AwayEditor.tsx) as a form sheet: the owner's trips
// and days off, each editable, and a form to add one. The Overview hands it the spans
// and a change callback through openAway(), since a route can't carry a function.
import React, { useState } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press, Segmented } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { success } from '../../ui/haptics'
import { pushError } from '../../lib/toast'
import { createAway, deleteAway, updateAway } from '../../lib/api'
import { AWAY_KINDS, awayRange, dayKey, type AwayKind, type AwaySpan } from '../../lib/away'
import { isoToDate } from '../../lib/components/overview/time'
import DateField from '../calendar/DateField'
import { TI } from './parts'
import { IconPencil, IconTrash } from '../../lib/components/overview/icons'

interface Pending {
  spans: AwaySpan[]
  today: string
  onChange: (spans: AwaySpan[]) => void
}

let pending: Pending | null = null

/** Open the time-away sheet. `onChange` gets the whole list after every save. */
export function openAway(p: Pending) {
  pending = p
  router.push('/overview/away')
}

type Draft = { id: string | null; label: string; kind: AwayKind; start: string; end: string; note: string }
const blank = (today: string): Draft => ({ id: null, label: '', kind: 'trip', start: today, end: today, note: '' })
const sortSpans = (list: AwaySpan[]) => [...list].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

export default function AwaySheet() {
  const [p] = useState(() => pending)
  const insets = useSafeAreaInsets()
  const today = p?.today || dayKey(new Date())
  const [spans, setSpans] = useState<AwaySpan[]>(() => p?.spans || [])
  const [draft, setDraft] = useState<Draft>(() => blank(today))
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))

  const changed = (next: AwaySpan[]) => { setSpans(next); p?.onChange(next) }

  const save = async () => {
    if (!draft.label.trim()) { pushError('Give it a name.'); return }
    setBusy(true)
    const fields = { label: draft.label, kind: draft.kind, start: draft.start, end: draft.end < draft.start ? draft.start : draft.end, note: draft.note }
    try {
      const { span } = draft.id ? await updateAway(draft.id, fields) : await createAway(fields)
      changed(sortSpans([...spans.filter((s) => s.id !== span.id), span]))
      setDraft(blank(today))
      success()
    } catch (e: any) {
      pushError(e?.message || 'Could not save that')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (span: AwaySpan) => {
    if (!(await confirm(`Delete "${span.label}"?`))) return
    try {
      await deleteAway(span.id)
      changed(spans.filter((s) => s.id !== span.id))
      if (draft.id === span.id) setDraft(blank(today))
    } catch (e: any) {
      pushError(e?.message || 'Could not delete that')
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg2 }}>
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 20, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View style={{ gap: 4 }}>
          <T size={12} muted>Trips and days off</T>
          <T size={20} weight={600}>Time away</T>
          <T size={12.5} muted>Totem tells every chat and agent about these days, and holds non-urgent notifications while you are away.</T>
        </View>

        {spans.length > 0 && (
          <View style={{ gap: 4 }}>
            {spans.map((s) => (
              <View key={s.id} style={[st.row, draft.id === s.id && { borderColor: colors.accent }]}>
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <T size={14} numberOfLines={1}>{s.label}</T>
                  <T size={12} muted>{awayRange(s, today)} · {AWAY_KINDS.find((k) => k.id === s.kind)?.label || s.kind}</T>
                </View>
                <Press haptic accessibilityLabel={`Edit ${s.label}`} style={st.icon}
                  onPress={() => setDraft({ id: s.id, label: s.label, kind: s.kind, start: s.start, end: s.end, note: s.note || '' })}>
                  <TI icon={IconPencil} size={17} color={colors.muted} />
                </Press>
                <Press haptic accessibilityLabel={`Delete ${s.label}`} style={st.icon} onPress={() => remove(s)}>
                  <TI icon={IconTrash} size={17} color={colors.muted} />
                </Press>
              </View>
            ))}
          </View>
        )}

        <View style={st.field}>
          <T size={13} muted>{draft.id ? 'Name' : 'New: name'}</T>
          <TextInput value={draft.label} onChangeText={(t) => set('label', t)} placeholder="Lisbon, Thanksgiving…" maxLength={120} {...inputProps} />
        </View>
        <View style={st.field}>
          <T size={13} muted>Kind</T>
          <Segmented options={AWAY_KINDS.map((k) => ({ value: k.id, label: k.label }))} value={draft.kind} onChange={(v) => set('kind', v)} />
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={[st.field, { flex: 1 }]}>
            <T size={13} muted>First day</T>
            <DateField value={isoToDate(draft.start)} mode="date"
              onChange={(d) => { const k = dayKey(d); setDraft((x) => ({ ...x, start: k, end: x.end < k ? k : x.end })) }} />
          </View>
          <View style={[st.field, { flex: 1 }]}>
            <T size={13} muted>Last day</T>
            <DateField value={isoToDate(draft.end)} mode="date" onChange={(d) => set('end', dayKey(d))} />
          </View>
        </View>
        <View style={st.field}>
          <T size={13} muted>Note</T>
          <TextInput value={draft.note} onChangeText={(t) => set('note', t)} placeholder="Optional" maxLength={500} {...inputProps} />
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
          {draft.id && <Btn title="New instead" onPress={() => setDraft(blank(today))} disabled={busy} />}
          <Btn title="Done" onPress={() => router.back()} disabled={busy} />
          <Btn title={busy ? 'Saving…' : draft.id ? 'Save changes' : 'Add'} kind="primary" onPress={save} disabled={busy} />
        </View>
      </ScrollView>
    </View>
  )
}

const st = StyleSheet.create({
  field: { gap: 6 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingLeft: 10, paddingRight: 4,
    borderRadius: 8, backgroundColor: colors.bg3, borderWidth: 1, borderColor: 'transparent',
    borderLeftWidth: 3, borderLeftColor: colors.away,
  },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
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
