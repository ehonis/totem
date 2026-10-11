// Settings → Tasks (web TaskSettings.tsx): the venture tags this install uses.
// Renaming a tag renames it on every task; a tag still on a task cannot be removed
// until those tasks move. The web's free colour picker becomes a menu of swatches.
import React, { useEffect, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { MenuView } from '@react-native-menu/menu'
import { ApiError, AuthError } from '../../../lib/api'
import { loadVentureTags, saveVentureTags } from '../../../lib/todos/ventureTags'
import { colors, fonts } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn } from '../../../ui/kit'
import { success, tap } from '../../../ui/haptics'
import { Note, PaneHead, SectionTitle } from '../ui'

type Row = { key: string; name: string; color: string; previousName?: string }

const SWATCHES = [
  { hex: '#5b8cff', name: 'Blue' }, { hex: '#7c5cff', name: 'Violet' }, { hex: '#3fb950', name: 'Green' },
  { hex: '#e3b341', name: 'Amber' }, { hex: '#f0506e', name: 'Red' }, { hex: '#f78166', name: 'Orange' },
  { hex: '#39c5cf', name: 'Teal' }, { hex: '#db61a2', name: 'Pink' }, { hex: '#8b8b8b', name: 'Grey' },
]

let nextKey = 0
const keyed = (name: string, color: string | null): Row => ({ key: `t${nextKey++}`, name, color: color || '', previousName: name })

export default function TasksPane() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  function fail(e: unknown) {
    if (e instanceof AuthError) return
    setError(e instanceof ApiError ? e.message : String(e))
  }

  useEffect(() => {
    loadVentureTags(true).then((tags) => setRows(tags.map((t) => keyed(t.name, t.color)))).catch(fail)
  }, [])

  const update = (key: string, patch: Partial<Row>) =>
    setRows((list) => list && list.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  async function save() {
    if (!rows) return
    setSaving(true)
    setError('')
    setNote('')
    try {
      const saved = await saveVentureTags(rows.map((r) => ({
        name: r.name.trim(),
        color: r.color || null,
        ...(r.previousName ? { previousName: r.previousName } : {}),
      })))
      setRows(saved.map((t) => keyed(t.name, t.color)))
      success()
      setNote('Saved.')
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PaneHead desc="Every task is Personal, or Ventures with one venture tag from this list. Add a tag for each project, client or side business you want to file tasks under. With no tags, the board only uses Personal." />

      <SectionTitle title="Venture tags" />
      {rows === null ? <Note text={error || 'Loading…'} /> : null}
      {rows?.length === 0 ? <Note text="No venture tags yet." /> : null}
      {rows?.map((r) => (
        <View key={r.key} style={st.row}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <MenuView
              shouldOpenOnLongPress={false}
              themeVariant="dark"
              title="Colour"
              onPressAction={({ nativeEvent }) => { tap(); update(r.key, { color: nativeEvent.event === 'none' ? '' : nativeEvent.event }) }}
              actions={[
                ...SWATCHES.map((c) => ({ id: c.hex, title: c.name, state: (r.color.toLowerCase() === c.hex ? 'on' : 'off') as 'on' | 'off' })),
                { id: 'none', title: 'No colour', state: (r.color ? 'off' : 'on') as 'on' | 'off' },
              ]}
            >
              <View accessibilityLabel={`Colour for ${r.name || 'tag'}`} style={[st.swatch, { backgroundColor: r.color || 'transparent', borderStyle: r.color ? 'solid' : 'dashed' }]} />
            </MenuView>
            <TextInput
              value={r.name}
              maxLength={40}
              onChangeText={(name) => update(r.key, { name })}
              placeholder="Tag name"
              accessibilityLabel="Tag name"
              placeholderTextColor={colors.muted}
              selectionColor={colors.accent}
              keyboardAppearance="dark"
              style={st.field}
            />
            <Btn kind="danger" compact title="Remove" onPress={() => setRows((list) => list && list.filter((x) => x.key !== r.key))} />
          </View>
          {r.previousName && r.name.trim() !== r.previousName ? <T size={12} muted>renames "{r.previousName}"</T> : null}
        </View>
      ))}
      {rows ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Btn title="Add tag" onPress={() => setRows((list) => [...(list || []), { key: `t${nextKey++}`, name: '', color: '' }])} />
          <Btn kind="primary" title="Save" disabled={saving} loading={saving} onPress={save} />
        </View>
      ) : null}
      {error && rows ? <Note text={error} error /> : null}
      <Note text={note} />
    </>
  )
}

const st = StyleSheet.create({
  row: { gap: 4, paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: colors.line },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.muted },
  field: {
    flex: 1, minHeight: 36, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.bg2, color: colors.text, fontFamily: fonts[400], fontSize: 15,
  },
})
