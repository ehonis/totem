import React, { useEffect, useState } from 'react'
import { createAway, deleteAway, updateAway, AuthError } from '../api'
import { AWAY_KINDS, awayRange, type AwaySpan, type AwayKind } from '../away'
import { Hi, XMarkIcon } from '../icons'
import { TI } from '../chat/ui'
import { IconPencil, IconTrash } from './overview/icons'

interface AwayEditorProps {
  spans: AwaySpan[]
  today: string
  onClose: () => void
  onChange: (spans: AwaySpan[]) => void
  onAuthError: () => void
}

type Draft = { id: string | null; label: string; kind: AwayKind; start: string; end: string; note: string }

const blank = (today: string): Draft => ({ id: null, label: '', kind: 'trip', start: today, end: today, note: '' })
const sortSpans = (list: AwaySpan[]) => [...list].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

// Trips and days off: every prompt's date block and the notification hold read these
// (docs/away.md). Opened from the Overview's schedule card.
export default function AwayEditor({ spans, today, onClose, onChange, onAuthError }: AwayEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => blank(today))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const fail = (e: any) => {
    if (e instanceof AuthError) { onAuthError(); return }
    setError(e?.message || String(e))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const fields = { label: draft.label, kind: draft.kind, start: draft.start, end: draft.end < draft.start ? draft.start : draft.end, note: draft.note }
    try {
      const { span } = draft.id ? await updateAway(draft.id, fields) : await createAway(fields)
      onChange(sortSpans([...spans.filter((s) => s.id !== span.id), span]))
      setDraft(blank(today))
    } catch (err) {
      fail(err)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (span: AwaySpan) => {
    if (!window.confirm(`Delete "${span.label}"?`)) return
    setError(null)
    try {
      await deleteAway(span.id)
      onChange(spans.filter((s) => s.id !== span.id))
      if (draft.id === span.id) setDraft(blank(today))
    } catch (err) {
      fail(err)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="event-modal away-modal" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-kicker">Trips and days off</div>
            <h2>Time away</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>

        <p className="away-help">Totem tells every chat and agent about these days, and holds non-urgent notifications while you are away.</p>

        {spans.length > 0 && (
          <ul className="away-list">
            {spans.map((s) => (
              <li key={s.id} className={draft.id === s.id ? 'editing' : ''}>
                <span className="away-list-main">
                  <span className="away-list-label">{s.label}</span>
                  <span className="away-list-sub">{awayRange(s, today)} · {AWAY_KINDS.find((k) => k.id === s.kind)?.label || s.kind}</span>
                </span>
                <button type="button" className="icon-btn" aria-label={`Edit ${s.label}`} title="Edit"
                  onClick={() => setDraft({ id: s.id, label: s.label, kind: s.kind, start: s.start, end: s.end, note: s.note || '' })}>
                  <TI icon={IconPencil} size={16} />
                </button>
                <button type="button" className="icon-btn" aria-label={`Delete ${s.label}`} title="Delete" onClick={() => remove(s)}>
                  <TI icon={IconTrash} size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="field-row">
          <label className="field">
            <span>{draft.id ? 'Name' : 'New: name'}</span>
            <input value={draft.label} onChange={(e) => set('label', e.target.value)} placeholder="Lisbon, Thanksgiving…" maxLength={120} required />
          </label>
          <label className="field">
            <span>Kind</span>
            <select value={draft.kind} onChange={(e) => set('kind', e.target.value as AwayKind)}>
              {AWAY_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>First day</span>
            <input type="date" value={draft.start} onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value, end: d.end < e.target.value ? e.target.value : d.end }))} required />
          </label>
          <label className="field">
            <span>Last day</span>
            <input type="date" value={draft.end} min={draft.start} onChange={(e) => set('end', e.target.value)} required />
          </label>
        </div>
        <label className="field">
          <span>Note</span>
          <input value={draft.note} onChange={(e) => set('note', e.target.value)} placeholder="Optional" maxLength={500} />
        </label>

        {error && <div className="away-error" role="alert">{error}</div>}

        <div className="modal-actions">
          {draft.id && <button type="button" className="btn" onClick={() => setDraft(blank(today))}>New instead</button>}
          <span className="modal-actions-spacer" />
          <button type="button" className="btn" onClick={onClose}>Done</button>
          <button className="btn primary" disabled={saving || !draft.label.trim()}>{saving ? 'Saving…' : draft.id ? 'Save changes' : 'Add'}</button>
        </div>
      </form>
    </div>
  )
}
