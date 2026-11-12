import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, AuthError, getSheetFeed, getTodoPreferences, purgeDeletedTodos, updateTodoPreferences, type IntegrationField } from '../api'
import type { SheetFeed, TodoPreferences } from '../todos/types'
import { loadVentureTags, saveVentureTags } from '../todos/ventureTags'
import { IntegrationSection } from './IntegrationsSettings'
import { sheetFeedLine } from './sheetFeedLine'
import { SettingsPage, SettingsRow, SettingsSection } from './settings/ui'

/*
 * Settings -> Tasks: the venture tags this install uses, and the shared task
 * sheet, read-only through the Drive sign-in (IntegrationsSettings.tsx,
 * docs/task-sheet.md). Tasks are Personal, or
 * Ventures with exactly one of these tags. With no tags, Ventures does not appear
 * anywhere on the board. Renaming a tag renames it on every task; a tag still on a
 * task cannot be removed until those tasks move.
 */

type Row = { key: string; name: string; color: string; previousName?: string }

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

let nextKey = 0
const keyed = (name: string, color: string | null): Row => ({ key: `t${nextKey++}`, name, color: color || '', previousName: name })

export default function TaskSettings({ onAuthError }: { onAuthError: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState('')
  const snapshot = (list: Row[]) => JSON.stringify(list.map((r) => [r.name.trim(), r.color, r.previousName]))

  function fail(e: unknown) {
    if (e instanceof AuthError) return onAuthError()
    setError(e instanceof ApiError ? e.message : String(e))
  }

  useEffect(() => {
    loadVentureTags(true).then((tags) => { const list = tags.map((t) => keyed(t.name, t.color)); setRows(list); setSaved(snapshot(list)) }).catch(fail)
  }, [])

  const update = (key: string, patch: Partial<Row>) =>
    setRows((list) => list && list.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  async function save() {
    if (!rows) return
    setSaving(true)
    setError('')
    setNote('')
    try {
      const savedTags = await saveVentureTags(rows.map((r) => ({
        name: r.name.trim(),
        color: r.color || null,
        ...(r.previousName ? { previousName: r.previousName } : {}),
      })))
      const list = savedTags.map((t) => keyed(t.name, t.color))
      setRows(list)
      setSaved(snapshot(list))
      setNote('Saved.')
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  const dirty = rows !== null && snapshot(rows) !== saved
  return (
    <SettingsPage>
      <SettingsSection
        id="venture-tags"
        title="Venture tags"
        description="Every task is Personal, or Ventures with one of these tags: a tag per project, client or side business. With none, the board only uses Personal."
        action={rows && <button className="btn compact" type="button" onClick={() => setRows((list) => [...(list || []), { key: `t${nextKey++}`, name: '', color: '' }])}>Add tag</button>}
      >
        {rows === null && <p className={error ? 's-error' : 'muted'}>{error || 'Loading…'}</p>}
        {rows?.length === 0 && <p className="muted">No venture tags yet.</p>}
        {rows?.map((r) => (
          <div className="tag-row" key={r.key}>
            <input type="color" className="tag-color" aria-label={`Colour for ${r.name || 'tag'}`} value={r.color || '#8b8b8b'}
              onChange={(e) => update(r.key, { color: e.target.value })} />
            <input className="s-input" aria-label="Tag name" value={r.name} maxLength={40}
              onChange={(e) => update(r.key, { name: e.target.value })} placeholder="Tag name" />
            {r.previousName && r.name.trim() !== r.previousName && <span className="muted tag-renames">Renames “{r.previousName}” on its tasks</span>}
            <span className="tag-row-actions">
              {r.color && <button className="btn compact" type="button" onClick={() => update(r.key, { color: '' })}>No colour</button>}
              <button className="btn compact danger" type="button" onClick={() => setRows((list) => list && list.filter((x) => x.key !== r.key))}>Remove</button>
            </span>
          </div>
        ))}
        {rows && (dirty || note || error) && (
          <div className="tag-save">
            {error ? <span className="s-error">{error}</span> : note && !dirty ? <span className="muted">{note}</span> : <span className="muted">Unsaved changes. A tag still on a task cannot be removed until those tasks move.</span>}
            {dirty && <button className="btn primary" type="button" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save tags'}</button>}
          </div>
        )}
      </SettingsSection>

      <IntegrationSection
        id="task-sheet"
        which="sheet"
        title="Task sheet"
        description="Show the open rows assigned to you from a shared spreadsheet of action items. Read-only: Totem never writes to it."
        onAuthError={onAuthError}
      >
        {(info) => <SheetFeedStatus fields={info.fields} onAuthError={onAuthError} />}
      </IntegrationSection>

      <RetentionSection onAuthError={onAuthError} />
    </SettingsPage>
  )
}
