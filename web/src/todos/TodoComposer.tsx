import React, { useEffect, useState } from 'react'
import { createBoardTodo } from '../api'
import type { SyncTarget, Todo, TodoArea, VentureTag } from './types'
import { useVentureTags } from './ventureTags'

interface TodoComposerProps { onCreated?: (todo: Todo) => void; onCancel?: () => void }

const DRAFT_KEY = 'totem.todo-draft.new'
type TodoDraft = Partial<{ title: string; description: string; area: TodoArea; ventureTag: VentureTag | ''; priority: Todo['priority']; dueDate: string; syncTarget: SyncTarget; repo: string }>
export const todoDraftStore = {
  get(): TodoDraft {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') }
    catch { return {} }
  },
  set(value: TodoDraft) { localStorage.setItem(DRAFT_KEY, JSON.stringify(value)) },
  clear() { localStorage.removeItem(DRAFT_KEY) },
}

export default function TodoComposer({ onCreated, onCancel }: TodoComposerProps) {
  // Ventures appears only once the install has venture tags (Settings -> Tasks).
  const ventureTags = useVentureTags()
  const [draft] = useState(() => todoDraftStore.get())
  const [title, setTitle] = useState(draft.title || '')
  const [description, setDescription] = useState(draft.description || '')
  const [area, setArea] = useState<TodoArea>(draft.area || 'Personal')
  const [ventureTag, setVentureTag] = useState<VentureTag | ''>(draft.ventureTag || '')
  const [priority, setPriority] = useState<Todo['priority']>(draft.priority || 1)
  const [dueDate, setDueDate] = useState(draft.dueDate || '')
  const [syncTarget, setSyncTarget] = useState<SyncTarget>(draft.syncTarget || 'local')
  const [repo, setRepo] = useState(draft.repo || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!title && !description && !dueDate && area === 'Personal' && syncTarget === 'local') todoDraftStore.clear()
    else todoDraftStore.set({ title, description, area, ventureTag, priority, dueDate, syncTarget, repo })
  }, [title, description, area, ventureTag, priority, dueDate, syncTarget, repo])

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('')
    if (!title.trim()) return setError('Enter a task title.')
    if (syncTarget === 'sheet' && (area !== 'Ventures' || !ventureTag)) return setError('Choose Ventures and a venture tag before syncing with Action Items.')
    if (syncTarget === 'github' && !/^[^/\s]+\/[^/\s]+$/.test(repo.trim())) return setError('Choose a GitHub repository as owner/name.')
    if (area === 'Ventures' && !ventureTag) return setError('Choose a venture tag for Ventures.')
    setBusy(true)
    try {
      const { todo } = await createBoardTodo({ title: title.trim(), description, area, ventureTag: area === 'Ventures' ? ventureTag as VentureTag : null, priority, dueDate: dueDate || null, syncTarget, ...(syncTarget === 'github' ? { repo: repo.trim() } : {}) })
      todoDraftStore.clear()
      onCreated?.(todo)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Task could not be created.'); setBusy(false) }
  }

  return (
    <form className="todo-composer" onSubmit={submit}>
      <label className="field"><span>Task</span><input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="What needs doing?" /></label>
      <label className="field"><span>Notes</span><textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder="Optional context" /></label>
      <div className="field-row">
        <label className="field"><span>Area</span><select value={area} onChange={event => { setArea(event.target.value as TodoArea); if (event.target.value === 'Personal') setVentureTag('') }}><option>Personal</option>{(ventureTags.length > 0 || area === 'Ventures') && <option>Ventures</option>}</select></label>
        {(ventureTags.length > 0 || area === 'Ventures') && <label className="field"><span>Venture tag</span><select aria-label="Venture tag" disabled={area !== 'Ventures'} value={ventureTag} onChange={event => setVentureTag(event.target.value as VentureTag)}><option value="">Choose tag</option>{ventureTags.map(tag => <option key={tag.name}>{tag.name}</option>)}</select></label>}
      </div>
      <div className="field-row">
        <label className="field"><span>Priority</span><select value={priority} onChange={event => setPriority(Number(event.target.value) as Todo['priority'])}><option value="4">P1 · Urgent ❗❗❗</option><option value="3">P2 · High ❗❗</option><option value="2">P3 · Medium ❗</option><option value="1">P4 · None</option></select></label>
        <label className="field"><span>Due date</span><input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} /></label>
      </div>
      <fieldset className="todo-share-options"><legend>Sharing</legend><label><input type="checkbox" checked={syncTarget === 'sheet'} onChange={event => setSyncTarget(event.target.checked ? 'sheet' : 'local')} /> Sync with Action Items</label><label><input type="checkbox" checked={syncTarget === 'github'} onChange={event => setSyncTarget(event.target.checked ? 'github' : 'local')} /> Create a GitHub issue</label><p>{syncTarget === 'local' ? 'Private in Totem.' : syncTarget === 'sheet' ? 'Creates and syncs an Action Items row.' : 'Publishing is explicit; Totem will ask for the repository.'}</p></fieldset>
      {syncTarget === 'github' && <label className="field"><span>GitHub repository</span><input value={repo} onChange={event => setRepo(event.target.value)} placeholder="owner/repository" /></label>}
      {error && <div className="todo-inline-error" role="alert">{error}</div>}
      <div className="modal-actions">{onCancel && <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>}<button type="submit" className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create task'}</button></div>
    </form>
  )
}
