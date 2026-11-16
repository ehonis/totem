import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AuthError, getSheetFeed, getTodoPreferences, purgeDeletedTodos, updateTodoPreferences, type IntegrationField } from '../api'
import type { SheetFeed, TodoPreferences } from '../todos/types'
import { folderLabel, useFolders } from '../todos/folders'
import { folderOrder } from '../work/groups'
import { IntegrationSection } from './IntegrationsSettings'
import { sheetFeedLine } from './sheetFeedLine'
import { SettingsPage, SettingsRow, SettingsSection } from './settings/ui'

/*
 * Settings -> Tasks: the shared task sheet, read-only through the Drive sign-in
 * (IntegrationsSettings.tsx, docs/task-sheet.md), with the folder its rows land
 * in, and retention. Tasks are organised by chat folder, so there is nothing to
 * configure for that here (venture tags were retired).
 */

/**
 * Settings -> Tasks › Task sheet › File rows in: the chat project or folder the
 * sheet's rows land in until one is filed by hand. Automatic picks the project the
 * sheet's name starts with ("Gizmo Labs" for "Gizmo Labs HQ"); Personal leaves them unfiled.
 */
function SheetFolderRow({ field, save, saving, onAuthError }: {
  field?: IntegrationField
  save: (patch: Record<string, string | null>) => Promise<boolean>
  saving: boolean
  onAuthError: () => void
}) {
  const { projects } = useFolders()
  const [auto, setAuto] = useState<string | null>(null)
  const authError = useRef(onAuthError)
  authError.current = onAuthError
  const value = field?.masked || ''
  // What Automatic picks now, from the feed (which applies the setting).
  useEffect(() => {
    getSheetFeed().then((feed) => setAuto(feed.configured && !value ? feed.defaultFolderId ?? null : null))
      .catch((e) => { if (e instanceof AuthError) authError.current() })
  }, [value])
  if (!field) return null
  const fromEnv = field.source === 'env'
  return (
    <SettingsRow
      id="sheet-task_sheet_folder"
      title="File rows in"
      description={fromEnv ? <>Set by <code>TASK_SHEET_FOLDER</code> in the environment.</> : 'Where the sheet’s rows land until you file one yourself.'}
      control={(
        <select className="s-input" aria-label="Folder for the sheet's rows" disabled={fromEnv || saving} value={value}
          onChange={(e) => void save({ TASK_SHEET_FOLDER: e.target.value || null })}>
          <option value="">Automatic{auto ? ` (${folderLabel(auto, projects)})` : value ? '' : ' (none matches)'}</option>
          <option value="none">Personal (unfiled)</option>
          {folderOrder(projects).map((p) => <option key={p.id} value={p.id}>{p.parentId ? `— ${p.name}` : p.name}</option>)}
          {value && value !== 'none' && !projects.some((p) => p.id === value) && <option value={value}>A removed folder</option>}
        </select>
      )}
    />
  )
}

/** Settings -> Tasks › Task sheet: the feed's state, and a button that reads it again. */
function SheetFeedStatus({ fields, onAuthError }: { fields: IntegrationField[]; onAuthError: () => void }) {
  const [feed, setFeed] = useState<SheetFeed | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // The parent's callback changes identity on every render; reading it through a
  // ref keeps a keystroke elsewhere on the page from reading the sheet again.
  const authError = useRef(onAuthError)
  authError.current = onAuthError
  const load = useCallback((refresh = false) => {
    setBusy(true)
    getSheetFeed({ refresh })
      .then((next) => { setFeed(next); setError('') })
      .catch((e) => { if (e instanceof AuthError) authError.current(); else setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => setBusy(false))
  }, [])
  // Read again only when one of the sheet's own settings changes, not on every save.
  const settings = JSON.stringify(fields.map((f) => [f.name, f.source, f.masked]))
  useEffect(() => { load() }, [load, settings])
  const line = error || (feed ? sheetFeedLine(feed) : 'Checking…')
  return (
    <SettingsRow
      id="task-sheet-status"
      title="Status"
      description={<span className={error || (feed?.configured && feed.error) ? 's-error' : undefined}>{line}</span>}
      control={feed?.configured ? <button className="btn" type="button" disabled={busy} onClick={() => load(true)}>{busy ? 'Reading…' : 'Read now'}</button> : undefined}
    />
  )
}

/**
 * Settings -> Tasks › Retention: when finished tasks leave the list for the archive,
 * and when the recycle bin empties itself. Each field saves when it changes. (It
 * used to sit at the foot of the Tasks page.)
 */
function RetentionSection({ onAuthError }: { onAuthError: () => void }) {
  const [prefs, setPrefs] = useState<TodoPreferences | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const authError = useRef(onAuthError)
  authError.current = onAuthError
  const fail = (e: unknown) => { if (e instanceof AuthError) authError.current(); else setError(e instanceof Error ? e.message : String(e)) }
  useEffect(() => { getTodoPreferences().then((r) => setPrefs(r.preferences)).catch(fail) }, [])

  // Bumped after every save, refused or not, so each field is drawn again from what is
  // stored: a value the bridge refused does not stay in the box looking saved.
  const [rev, setRev] = useState(0)
  async function save(patch: Partial<TodoPreferences>) {
    setError(''); setNote('')
    try { setPrefs((await updateTodoPreferences(patch)).preferences); setNote('Saved.') } catch (e) { fail(e) } finally { setRev((n) => n + 1) }
  }
  async function purge() {
    if (!prefs?.recyclePurgeDays) return
    setError(''); setNote('')
    try {
      const result = await purgeDeletedTodos(new Date(Date.now() - prefs.recyclePurgeDays * 86_400_000).toISOString())
      setNote(`Backed up the task database and removed ${result.purged.toLocaleString()} task${result.purged === 1 ? '' : 's'} for good.`)
    } catch (e) { fail(e) }
  }
  const days = (value: string) => (value.trim() ? Math.max(1, Math.round(Number(value))) : null)
  return (
    <SettingsSection
      id="task-retention"
      title="Retention"
      description={error ? <span className="s-error">{error}</span> : note || 'Finished tasks move to the archive (restorable from the Tasks page’s … menu); binned ones wait in the recycle bin.'}
    >
      {!prefs ? <p className="muted">{error ? '' : 'Loading…'}</p> : <>
        <SettingsRow
          id="task-archive-hour"
          title="Archive finished tasks daily at"
          description="Blank keeps finished tasks under Completed until the age rule below."
          control={<input key={`at-${rev}`} className="s-input" type="time" aria-label="Archive time" defaultValue={prefs.autoArchiveAt ?? ''} onBlur={(e) => { const v = e.target.value || null; if (v !== prefs.autoArchiveAt) void save({ autoArchiveAt: v }) }} />}
        />
        <SettingsRow
          id="task-archive-days"
          title="Or once finished for"
          description="Days; whichever comes later wins. Blank for no age rule."
          control={<input key={`days-${rev}`} className="s-input" type="number" min={1} inputMode="numeric" aria-label="Archive after days" defaultValue={prefs.autoArchiveDays ?? ''} onBlur={(e) => { const v = days(e.target.value); if (v !== prefs.autoArchiveDays) void save({ autoArchiveDays: v }) }} />}
        />
        <SettingsRow
          id="task-recycle-days"
          title="Empty the recycle bin after"
          description="Days in the bin before a task is removed for good, after a backup. Blank keeps them."
          control={<span className="tag-row-actions">
            <input key={`purge-${rev}`} className="s-input" type="number" min={1} inputMode="numeric" aria-label="Recycle bin days" defaultValue={prefs.recyclePurgeDays ?? ''} onBlur={(e) => { const v = days(e.target.value); if (v !== prefs.recyclePurgeDays) void save({ recyclePurgeDays: v }) }} />
            {prefs.recyclePurgeDays ? <button className="btn compact" type="button" onClick={() => void purge()}>Empty now</button> : null}
          </span>}
        />
      </>}
    </SettingsSection>
  )
}

export default function TaskSettings({ onAuthError }: { onAuthError: () => void }) {
  return (
    <SettingsPage>
      <IntegrationSection
        id="task-sheet"
        which="sheet"
        title="Task sheet"
        description="Show the open rows assigned to you from a shared spreadsheet of action items. Read-only: Totem never writes to it."
        onAuthError={onAuthError}
        custom={['TASK_SHEET_FOLDER']}
      >
        {(info, edit) => <>
          <SheetFolderRow field={info.fields.find((f) => f.name === 'TASK_SHEET_FOLDER')} {...edit} onAuthError={onAuthError} />
          <SheetFeedStatus fields={info.fields} onAuthError={onAuthError} />
        </>}
      </IntegrationSection>

      <RetentionSection onAuthError={onAuthError} />
    </SettingsPage>
  )
}
