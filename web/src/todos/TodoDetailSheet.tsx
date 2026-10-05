import React, { useEffect, useRef, useState } from 'react'
import {
  addTodoNote, detachTodoExternalLink, linkRelatedTodo, publishTodoFirstNote,
  refreshBoardTodo, unlinkRelatedTodo, updateBoardTodo,
  shareBoardTodo,
} from '../api'
import { Hi, ArrowPathIcon, ArrowTopRightOnSquareIcon, XMarkIcon } from '../icons'
import { priorityLabel, priorityMarks, todoSource, type Todo, type TodoArea, type VentureTag } from './types'
import { useVentureTags } from './ventureTags'

interface TodoDetailSheetProps {
  todo: Todo
  allTodos?: Todo[]
  onClose: () => void
  onSaved?: (todo: Todo) => void
  onUnshare?: (connector: 'github' | 'sheet') => Promise<void>
  onShare?: (target: 'github' | 'sheet', options: Record<string, unknown>) => Promise<Todo | void>
  initialFocus?: 'details' | 'notes'
}

export default function TodoDetailSheet({ todo: original, allTodos = [], onClose, onSaved, onUnshare, onShare, initialFocus = 'details' }: TodoDetailSheetProps) {
  const [todo, setTodo] = useState(original)
  const [form, setForm] = useState(() => ({ title: original.title, description: original.description, area: original.area, ventureTag: original.ventureTag || '', priority: original.priority, dueDate: original.dueDate || '', recurrence: original.recurrence || '', snoozedUntil: original.snoozedUntil?.slice(0, 16) || '' }))
  const ventureTags = useVentureTags()
  // A task may carry a tag that has since left the list; keep it selectable.
  const ventureTagOptions = [...ventureTags.map(tag => tag.name), ...(original.ventureTag && !ventureTags.some(tag => tag.name === original.ventureTag) ? [original.ventureTag] : [])]
  const [note, setNote] = useState('')
  const [relatedId, setRelatedId] = useState('')
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const noteInput = useRef<HTMLInputElement>(null)
  const source = todoSource(todo)
  const link = todo.externalLinks.find(item => item.connector === source)
  const set = (field: string, value: unknown) => setForm(current => ({ ...current, [field]: value }))

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [onClose])

  useEffect(() => {
    if (initialFocus === 'notes') noteInput.current?.focus()
  }, [initialFocus])

  function accept(next: Todo) { setTodo(next); onSaved?.(next) }
  async function run(name: string, action: () => Promise<void>) {
    setBusy(name); setError(''); setNotice('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : 'The task could not be updated.') }
    finally { setBusy('') }
  }

  const save = (event: React.FormEvent) => {
    event.preventDefault()
    void run('save', async () => {
      const { todo: next } = await updateBoardTodo(todo.id, {
        title: form.title, description: form.description, area: form.area as TodoArea,
        ventureTag: form.area === 'Ventures' ? form.ventureTag as VentureTag : null,
        priority: Number(form.priority) as Todo['priority'], dueDate: form.dueDate || null,
        recurrence: form.recurrence || null,
        snoozedUntil: form.snoozedUntil ? new Date(form.snoozedUntil).toISOString() : null,
      })
      accept(next); setNotice('Saved.')
    })
  }

  async function stopSync() {
    if (source === 'local') return
    await run('unshare', async () => {
      if (onUnshare) await onUnshare(source)
      else accept((await detachTodoExternalLink(todo.id, source)).todo)
      setNotice(source === 'sheet' ? 'Sync stopped. The row stays in Action Items.' : 'Sync stopped. The GitHub issue remains open.')
    })
  }

  async function share(target: 'github' | 'sheet', options: Record<string, unknown> = {}) {
    await run(`share-${target}`, async () => {
      const next = onShare ? await onShare(target, options) : (await shareBoardTodo(todo.id, target, options)).todo
      if (next) accept(next)
      setNotice(target === 'sheet' ? 'Syncing with Action Items.' : 'GitHub issue queued for creation.')
    })
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="event-modal todo-detail-sheet" style={{ overflowX: 'hidden' }} role="dialog" aria-modal="true" aria-labelledby="todo-detail-title" onMouseDown={event => event.stopPropagation()}>
        <div className="modal-head"><div><div className="modal-kicker">{source === 'local' ? 'Private task' : `${source} task`}</div><h2 id="todo-detail-title">Task details</h2></div><button className="icon-btn" onClick={onClose} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button></div>
        {error && <div className="todo-inline-error" role="alert">{error}</div>}
        {notice && <div className="todo-inline-notice" role="status">{notice}</div>}
        <form className="todo-composer" onSubmit={save}>
          <label className="field"><span>Task</span><input value={form.title} onChange={event => set('title', event.target.value)} /></label>
          <label className="field"><span>Description</span><textarea value={form.description} onChange={event => set('description', event.target.value)} /></label>
          <div className="field-row"><label className="field"><span>Area</span><select value={form.area} onChange={event => { set('area', event.target.value); if (event.target.value === 'Personal') set('ventureTag', '') }}><option>Personal</option>{(ventureTags.length > 0 || form.area === 'Ventures') && <option>Ventures</option>}</select></label>{(ventureTags.length > 0 || form.area === 'Ventures') && <label className="field"><span>Venture tag</span><select disabled={form.area !== 'Ventures'} value={form.ventureTag} onChange={event => set('ventureTag', event.target.value)}><option value="">Choose tag</option>{ventureTagOptions.map(name => <option key={name}>{name}</option>)}</select></label>}</div>
          <div className="field-row"><label className="field"><span>Priority</span><select value={form.priority} onChange={event => set('priority', Number(event.target.value))}>{([4, 3, 2, 1] as Todo['priority'][]).map(value => <option key={value} value={value}>{`${priorityLabel(value)} ${priorityMarks(value)}`.trim()}</option>)}</select></label><label className="field"><span>Due date</span><input type="date" value={form.dueDate} onChange={event => set('dueDate', event.target.value)} /></label></div>
          <div className="field-row"><label className="field"><span>Repeat</span><select value={form.recurrence} onChange={event => set('recurrence', event.target.value)}><option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label><label className="field"><span>Snooze until</span><input type="datetime-local" value={form.snoozedUntil} onChange={event => set('snoozedUntil', event.target.value)} /></label></div>
          <div className="modal-actions"><button className="btn primary" disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button></div>
        </form>

        <section className="todo-detail-section"><div className="todo-detail-heading"><h3>Notes</h3><span>Append-only</span></div>{todo.notes.length ? <ol className="todo-note-log">{todo.notes.map(item => <li key={item.id}><p>{item.body}</p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></li>)}</ol> : <p className="muted">No notes yet.</p>}<form className="todo-inline-form" onSubmit={event => { event.preventDefault(); if (!note.trim()) return; void run('note', async () => { const { note: saved } = await addTodoNote(todo.id, note.trim()); accept({ ...todo, notes: [...todo.notes, saved] }); setNote('') }) }}><input ref={noteInput} aria-label="New note" value={note} onChange={event => setNote(event.target.value)} placeholder="Add context without rewriting history" /><button className="btn" disabled={busy === 'note'}>Append note</button></form></section>

        <section className="todo-detail-section"><div className="todo-detail-heading"><h3>Related tasks</h3><span>{todo.relations.length}</span></div>{todo.relations.map(relation => <div className="todo-relation" key={relation.id}><span>{relation.title}</span><button className="link-btn" onClick={() => void run('relation', async () => accept((await unlinkRelatedTodo(todo.id, relation.id)).todo))}>Remove relation</button></div>)}<form className="todo-inline-form" onSubmit={event => { event.preventDefault(); if (!relatedId) return; void run('relation', async () => { accept((await linkRelatedTodo(todo.id, relatedId)).todo); setRelatedId('') }) }}><select aria-label="Related task" value={relatedId} onChange={event => setRelatedId(event.target.value)}><option value="">Choose task</option>{allTodos.filter(item => item.id !== todo.id && !todo.relations.some(relation => relation.id === item.id)).map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select><button className="btn">Relate</button></form></section>

        {source === 'local' && <section className="todo-detail-section"><div className="todo-detail-heading"><h3>Share</h3><span>Optional</span></div><p className="muted">This task stays private until you choose one destination.</p><div className="todo-source-actions"><button className="btn" disabled={todo.area !== 'Ventures' || !todo.ventureTag || Boolean(busy)} onClick={() => void share('sheet')}>Sync with Action Items</button><input aria-label="GitHub repository for sharing" value={repo} onChange={event => setRepo(event.target.value)} placeholder="owner/repository" /><button className="btn" disabled={!/^[^/\s]+\/[^/\s]+$/.test(repo.trim()) || Boolean(busy)} onClick={() => void share('github', { repo: repo.trim() })}>Create GitHub issue</button></div>{todo.area !== 'Ventures' && <p className="muted">Action Items sharing requires a Ventures task with a venture tag.</p>}</section>}

        {source !== 'local' && <section className="todo-detail-section"><div className="todo-detail-heading"><h3>Source</h3><span>{todo.syncState.status}</span></div>{link?.externalUrl && <a href={link.externalUrl} target="_blank" rel="noreferrer">Open {source === 'sheet' ? 'Action Items row' : 'GitHub issue'} <Hi icon={ArrowTopRightOnSquareIcon} size={13} /></a>}<div className="todo-source-actions"><button className="btn" onClick={() => void run('refresh', async () => accept((await refreshBoardTodo(todo.id)).todo))}><Hi icon={ArrowPathIcon} size={14} /> Refresh</button>{source === 'github' && todo.notes.length > 0 && <button className="btn" onClick={() => void run('publish', async () => accept((await publishTodoFirstNote(todo.id)).todo))}>Publish first note as issue description</button>}<button className="btn danger" onClick={() => void stopSync()} disabled={busy === 'unshare'}>Stop syncing</button></div></section>}
      </div>
    </div>
  )
}
