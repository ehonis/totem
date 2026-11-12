// Settings → Tasks (web TaskSettings.tsx): the venture tags this install uses,
// the shared task sheet, read-only through the Drive sign-in
// (docs/task-sheet.md), and retention (when finished tasks are archived and the
// recycle bin empties). Every task is Personal, or Ventures with one of
// these tags. Renaming a tag renames it on every task; a tag still on a task
// cannot be removed until those tasks move. The web's free colour picker becomes
// a menu of swatches.
import React, { useCallback, useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { MenuView } from '@react-native-menu/menu'
import { ApiError, AuthError, getSheetFeed, getTodoPreferences, updateTodoPreferences, type IntegrationField } from '../../../lib/api'
import type { SheetFeed, TodoPreferences } from '../../../lib/todos/types'
import { sheetFeedLine } from '../../../lib/components/sheetFeedLine'
import { loadVentureTags, saveVentureTags } from '../../../lib/todos/ventureTags'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Press } from '../../../ui/kit'
import { success, tap } from '../../../ui/haptics'
import { Hi, PlusIcon, TrashIcon } from '../../../lib/icons'
import { IntegrationSection } from '../integrations'
import { Field, Loading, Row, Section, useDiscardGuard } from '../ui'

type TagRow = { key: string; name: string; color: string; previousName?: string }

const SWATCHES = [
  { hex: '#5b8cff', name: 'Blue' }, { hex: '#7c5cff', name: 'Violet' }, { hex: '#3fb950', name: 'Green' },
  { hex: '#e3b341', name: 'Amber' }, { hex: '#f0506e', name: 'Red' }, { hex: '#f78166', name: 'Orange' },
  { hex: '#39c5cf', name: 'Teal' }, { hex: '#db61a2', name: 'Pink' }, { hex: '#8b8b8b', name: 'Grey' },
]

let nextKey = 0
const keyed = (name: string, color: string | null): TagRow => ({ key: `t${nextKey++}`, name, color: color || '', previousName: name })
const snapshot = (list: TagRow[]) => JSON.stringify(list.map((r) => [r.name.trim(), r.color, r.previousName]))

/** Settings → Tasks › Task sheet: the feed's state in one line, and a button that reads it again. */
function SheetFeedStatus({ fields }: { fields: IntegrationField[] }) {
  const [feed, setFeed] = useState<SheetFeed | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback((refresh = false) => {
    setBusy(true)
    getSheetFeed({ refresh })
      .then((next) => { setFeed(next); setError('') })
      .catch((e) => { if (!(e instanceof AuthError)) setError(e instanceof ApiError ? e.message : String(e)) })
      .finally(() => setBusy(false))
  }, [])
  // Read again only when one of the sheet's own settings changes, not on every save.
  const settings = JSON.stringify(fields.map((f) => [f.name, f.source, f.masked]))
  useEffect(() => { load() }, [load, settings])
  const failed = Boolean(error || (feed?.configured && feed.error))
  const line = error || (feed ? sheetFeedLine(feed) : 'Checking…')
  return (
    <Row
      id="task-sheet-status"
      title="Status"
      stacked
      description={<T size={12.5} lineHeight={17} muted={!failed} color={failed ? colors.red : undefined}>{line}</T>}
      control={feed?.configured ? <Btn title={busy ? 'Reading…' : 'Read now'} disabled={busy} onPress={() => { tap(); load(true) }} /> : undefined}
    />
  )
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** Settings → Tasks › Retention: each field saves when you leave it. */
function RetentionSection() {
  const [prefs, setPrefs] = useState<TodoPreferences | null>(null)
  const [draft, setDraft] = useState({ at: '', days: '', purge: '' })
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const show = (p: TodoPreferences) => {
    setPrefs(p)
    setDraft({ at: p.autoArchiveAt ?? '', days: p.autoArchiveDays == null ? '' : String(p.autoArchiveDays), purge: p.recyclePurgeDays == null ? '' : String(p.recyclePurgeDays) })
  }
  useEffect(() => {
    getTodoPreferences().then((r) => show(r.preferences)).catch((e) => { if (!(e instanceof AuthError)) setError(e instanceof ApiError ? e.message : String(e)) })
  }, [])
  async function save(patch: Partial<TodoPreferences>) {
    setError(''); setNote('')
    try { show((await updateTodoPreferences(patch)).preferences); success(); setNote('Saved.') } catch (e) {
      if (!(e instanceof AuthError)) setError(e instanceof ApiError ? e.message : String(e))
      if (prefs) show(prefs)
    }
  }
  const days = (value: string) => (value.trim() ? Math.max(1, Math.round(Number(value)) || 1) : null)
  const footer = error || note ? <T size={12.5} lineHeight={17} muted={!error} color={error ? colors.red : undefined}>{error || note}</T> : undefined
  return (
    <Section
      id="task-retention"
      title="Retention"
      description="Finished tasks move to the archive; binned ones wait in the recycle bin."
      footer={footer}
    >
      {!prefs ? <Loading error={error} /> : <>
        <Row
          title="Archive daily at"
          description="24-hour time, e.g. 18:00. Blank keeps them under Completed."
          control={<Field value={draft.at} placeholder="18:00" keyboardType="numbers-and-punctuation" maxLength={5} accessibilityLabel="Archive time" style={st.small}
            onChangeText={(at) => setDraft((d) => ({ ...d, at }))}
            onEndEditing={() => { const at = draft.at.trim() || null; if (at && !HHMM.test(at)) { setError('Use a time like 18:00.'); return } if (at !== prefs.autoArchiveAt) void save({ autoArchiveAt: at }) }} />}
        />
        <Row
          title="Or once finished for"
          description="Days; whichever comes later wins."
          control={<Field value={draft.days} placeholder="Off" keyboardType="number-pad" maxLength={4} accessibilityLabel="Archive after days" style={st.small}
            onChangeText={(v) => setDraft((d) => ({ ...d, days: v }))}
            onEndEditing={() => { const v = days(draft.days); if (v !== prefs.autoArchiveDays) void save({ autoArchiveDays: v }) }} />}
        />
        <Row
          title="Empty the recycle bin after"
          description="Days, after a backup. Blank keeps them."
          control={<Field value={draft.purge} placeholder="Off" keyboardType="number-pad" maxLength={4} accessibilityLabel="Recycle bin days" style={st.small}
            onChangeText={(v) => setDraft((d) => ({ ...d, purge: v }))}
            onEndEditing={() => { const v = days(draft.purge); if (v !== prefs.recyclePurgeDays) void save({ recyclePurgeDays: v }) }} />}
        />
      </>}
    </Section>
  )
}

export default function TasksPane() {
  const [rows, setRows] = useState<TagRow[] | null>(null)
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  function fail(e: unknown) {
    if (e instanceof AuthError) return
    setError(e instanceof ApiError ? e.message : String(e))
  }

  useEffect(() => {
    loadVentureTags(true).then((tags) => { const list = tags.map((t) => keyed(t.name, t.color)); setRows(list); setSaved(snapshot(list)) }).catch(fail)
  }, [])

  const update = (key: string, patch: Partial<TagRow>) => {
    setNote('')
    setRows((list) => list && list.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  async function save() {
    if (!rows) return
    setSaving(true)
    setError('')
    setNote('')
    try {
      const out = await saveVentureTags(rows.map((r) => ({
        name: r.name.trim(),
        color: r.color || null,
        ...(r.previousName ? { previousName: r.previousName } : {}),
      })))
      const list = out.map((t) => keyed(t.name, t.color))
      setRows(list)
      setSaved(snapshot(list))
      success()
      setNote('Saved.')
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  const dirty = rows !== null && snapshot(rows) !== saved
  useDiscardGuard(dirty)
  const footer = rows && (dirty || note || error) ? (
    <View style={{ gap: 8 }}>
      {error ? <T size={12.5} color={colors.red} lineHeight={17}>{error}</T>
        : note && !dirty ? <T size={12.5} muted>{note}</T>
          : <T size={12.5} muted lineHeight={17}>Unsaved changes. A tag still on a task cannot be removed until those tasks move.</T>}
      {dirty ? <Btn kind="primary" title={saving ? 'Saving…' : 'Save tags'} disabled={saving} loading={saving} onPress={save} style={{ alignSelf: 'flex-start' }} /> : null}
    </View>
  ) : undefined

  return (
    <>
      <Section
        id="venture-tags"
        title="Venture tags"
        description="Every task is Personal, or Ventures with one of these tags: a tag per project, client or side business. With none, the board only uses Personal."
        footer={footer}
      >
        {rows === null ? <Loading error={error} /> : null}
        {rows?.length === 0 ? <Row title="No venture tags yet" /> : null}
        {rows?.map((r) => (
          <View key={r.key} style={st.tag}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
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
                <View accessibilityRole="button" accessibilityLabel={`Colour for ${r.name || 'tag'}`} style={[st.swatch, { backgroundColor: r.color || 'transparent', borderStyle: r.color ? 'solid' : 'dashed' }]} />
              </MenuView>
              <Field
                value={r.name}
                maxLength={40}
                onChangeText={(name) => update(r.key, { name })}
                placeholder="Tag name"
                accessibilityLabel="Tag name"
                autoCapitalize="words"
                style={{ flex: 1 }}
              />
              <Press
                haptic
                hitSlop={8}
                onPress={() => { setNote(''); setRows((list) => list && list.filter((x) => x.key !== r.key)) }}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${r.name || 'tag'}`}
              >
                <Hi icon={TrashIcon} size={18} color={colors.red} />
              </Press>
            </View>
            {r.previousName && r.name.trim() !== r.previousName ? <T size={12} muted style={{ marginLeft: 38 }}>Renames “{r.previousName}” on its tasks</T> : null}
          </View>
        ))}
        {rows ? (
          <Row
            title="Add tag"
            tone="accent"
            icon={<Hi icon={PlusIcon} size={15} color={colors.accent} />}
            onPress={() => { setNote(''); setRows((list) => [...(list || []), { key: `t${nextKey++}`, name: '', color: '' }]) }}
          />
        ) : null}
      </Section>

      <IntegrationSection
        id="task-sheet"
        which="sheet"
        title="Task sheet"
        description="Show the open rows assigned to you from a shared spreadsheet of action items. Read-only: Totem never writes to it."
      >
        {(info) => <SheetFeedStatus fields={info.fields} />}
      </IntegrationSection>

      <RetentionSection />
    </>
  )
}

const st = StyleSheet.create({
  tag: { gap: 4, paddingVertical: 9, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.muted },
  small: { width: 76, textAlign: 'center' },
})
