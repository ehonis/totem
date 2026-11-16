// Settings → Tasks (web TaskSettings.tsx): the shared task sheet, read-only through
// the Drive sign-in (docs/task-sheet.md), with the folder its rows land in, and
// retention (when finished tasks are archived and the recycle bin empties). Tasks are
// organised by chat folder, so there is nothing to configure for that here (venture
// tags were retired).
import React, { useCallback, useEffect, useState } from 'react'
import { StyleSheet } from 'react-native'
import { ApiError, AuthError, getSheetFeed, getTodoPreferences, updateTodoPreferences, type IntegrationField } from '../../../lib/api'
import type { SheetFeed, TodoPreferences } from '../../../lib/todos/types'
import { sheetFeedLine } from '../../../lib/components/sheetFeedLine'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn } from '../../../ui/kit'
import { success, tap } from '../../../ui/haptics'
import { folderLabel } from '../../todos/folders'
import { useFolders } from '../../todos/useFolders'
import { IntegrationSection } from '../integrations'
import { Code, Field, Loading, Picker, Row, Section } from '../ui'

/**
 * Settings → Tasks › Task sheet › File rows in: the chat project or folder the sheet's
 * rows land in until one is filed by hand. Automatic picks the project the sheet's name
 * starts with; Personal leaves them unfiled (TASK_SHEET_FOLDER: '', 'none' or an id).
 */
function SheetFolderRow({ field, save, saving }: {
  field?: IntegrationField
  save: (values: Record<string, string | null>) => Promise<boolean>
  saving: boolean
}) {
  const { projects } = useFolders()
  const [auto, setAuto] = useState<string | null>(null)
  const value = field?.masked || ''
  // What Automatic picks now, from the feed (which applies the setting).
  useEffect(() => {
    let live = true
    getSheetFeed().then((feed) => { if (live) setAuto(feed.configured && !value ? feed.defaultFolderId ?? null : null) }).catch(() => {})
    return () => { live = false }
  }, [value])
  if (!field) return null
  const fromEnv = field.source === 'env'
  const roots = projects.filter((p) => !p.parentId)
  const groups = [
    { options: [
      { value: '', label: `Automatic${auto ? ` (${folderLabel(auto, projects)})` : value ? '' : ' (none matches)'}` },
      { value: 'none', label: 'Personal (unfiled)' },
    ] },
    ...roots.map((p) => ({ options: [p, ...projects.filter((f) => f.parentId === p.id)].map((f) => ({ value: f.id, label: f.parentId ? `${p.name} / ${f.name}` : f.name })) })),
    ...(value && value !== 'none' && !projects.some((p) => p.id === value) ? [{ options: [{ value, label: 'A removed folder' }] }] : []),
  ]
  return (
    <Row
      id="sheet-task_sheet_folder"
      title="File rows in"
      description={fromEnv ? 'Set in the server environment; change it there.' : 'Where the sheet’s rows land until you file one yourself.'}
      control={fromEnv ? <Code>{field.name}</Code> : (
        <Picker label="File rows in" value={value} groups={groups} disabled={saving}
          onChange={(next) => { if (next !== value) void save({ TASK_SHEET_FOLDER: next || null }).then((ok) => { if (ok) success() }) }} />
      )}
    />
  )
}

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
  return (
    <>
      <IntegrationSection
        id="task-sheet"
        which="sheet"
        title="Task sheet"
        description="Show the open rows assigned to you from a shared spreadsheet of action items. Read-only: Totem never writes to it."
        custom={['TASK_SHEET_FOLDER']}
      >
        {(info, edit) => <>
          <SheetFolderRow field={info.fields.find((f) => f.name === 'TASK_SHEET_FOLDER')} {...edit} />
          <SheetFeedStatus fields={info.fields} />
        </>}
      </IntegrationSection>

      <RetentionSection />
    </>
  )
}

const st = StyleSheet.create({
  small: { width: 76, textAlign: 'center' },
})
