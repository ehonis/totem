import React, { useEffect, useState } from 'react'
import { ApiError, AuthError } from '../api'
import { loadVentureTags, saveVentureTags } from '../todos/ventureTags'

/*
 * Settings -> Tasks: the venture tags this install uses. Tasks are Personal, or
 * Ventures with exactly one of these tags. With no tags, Ventures does not appear
 * anywhere on the board. Renaming a tag renames it on every task; a tag still on a
 * task cannot be removed until those tasks move.
 */

type Row = { key: string; name: string; color: string; previousName?: string }

let nextKey = 0
const keyed = (name: string, color: string | null): Row => ({ key: `t${nextKey++}`, name, color: color || '', previousName: name })

export default function TaskSettings({ onAuthError }: { onAuthError: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  function fail(e: unknown) {
    if (e instanceof AuthError) return onAuthError()
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
      setNote('Saved.')
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-pane">
      <header className="settings-pane-head">
        <h2>Tasks</h2>
        <p>
          Every task is Personal, or Ventures with one venture tag from this list. Add a tag for each project, client or
          side business you want to file tasks under. With no tags, the board only uses Personal.
        </p>
      </header>

      <div className="settings-section-title"><span /><strong>Venture tags</strong></div>
      <div className="setting-list">
        {rows === null && <p className="text-muted m-0 px-1">{error || 'Loading…'}</p>}
        {rows?.length === 0 && <p className="text-muted m-0 px-1">No venture tags yet.</p>}
        {rows?.map((r) => (
          <div className="setting-row" key={r.key}>
            <div className="setting-control flex gap-2 items-center w-full">
              <input className="model-select" aria-label="Tag name" value={r.name} maxLength={40}
                onChange={(e) => update(r.key, { name: e.target.value })} placeholder="Tag name" />
              <input type="color" aria-label={`Colour for ${r.name || 'tag'}`} value={r.color || '#8b8b8b'}
                onChange={(e) => update(r.key, { color: e.target.value })} />
              {r.color && <button className="btn ghost" onClick={() => update(r.key, { color: '' })}>No colour</button>}
              {r.previousName && r.name.trim() !== r.previousName && <span className="text-muted">renames "{r.previousName}"</span>}
              <button className="btn danger ml-auto" onClick={() => setRows((list) => list && list.filter((x) => x.key !== r.key))}>Remove</button>
            </div>
          </div>
        ))}
        {rows && (
          <div className="flex gap-2 px-1">
            <button className="btn" onClick={() => setRows((list) => [...(list || []), { key: `t${nextKey++}`, name: '', color: '' }])}>Add tag</button>
            <button className="btn primary" disabled={saving} onClick={save}>Save</button>
          </div>
        )}
        {error && rows && <p className="text-[var(--danger,#e5484d)] m-0 px-1">{error}</p>}
        {note && <p className="text-muted m-0 px-1">{note}</p>}
      </div>
    </div>
  )
}
