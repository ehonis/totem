import React, { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  AuthError, addListItems, createList, deleteList, deleteListItem, getLists, getTodoBoard,
  linkListTodo, unlinkListTodo, updateList, updateListItem,
} from '../api'
import { CheckIcon, Hi, LinkIcon, PlusIcon, TrashIcon, XMarkIcon } from '../icons'
import type { TotemList } from '../lists/types'
import type { Todo } from '../todos/types'

export default function ListsView({ onAuthError }: { onAuthError: () => void }) {
  const [lists, setLists] = useState<TotemList[]>([])
  const [todos, setTodos] = useState<Todo[]>([])
  const [activeId, setActiveId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [newList, setNewList] = useState('')
  const [newItem, setNewItem] = useState('')
  const [todoId, setTodoId] = useState('')

  const active = useMemo(() => lists.find((list) => list.id === activeId) ?? lists[0] ?? null, [lists, activeId])
  const availableTodos = useMemo(() => {
    const linked = new Set(active?.linkedTodos.map((todo) => todo.id) ?? [])
    return todos.filter((todo) => !linked.has(todo.id) && todo.status !== 'done')
  }, [active, todos])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [payload, board] = await Promise.all([getLists(), getTodoBoard({})])
      setLists(payload.lists)
      setTodos(board.todos)
      setActiveId((current) => payload.lists.some((list) => list.id === current) ? current : payload.lists[0]?.id ?? '')
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setError(cause instanceof Error ? cause.message : 'Lists could not load.')
    } finally { setLoading(false) }
  }, [onAuthError])

  useEffect(() => { void load() }, [load])

  const apply = useCallback(async (run: () => Promise<{ list: TotemList }>) => {
    setBusy(true); setError('')
    try {
      const { list } = await run()
      setLists((current) => current.map((value) => value.id === list.id ? list : value))
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setError(cause instanceof Error ? cause.message : 'That change could not be saved.')
    } finally { setBusy(false) }
  }, [onAuthError])

  async function submitList(event: FormEvent) {
    event.preventDefault()
    if (!newList.trim()) return
    setBusy(true); setError('')
    try {
      const { list } = await createList({ title: newList.trim() })
      setLists((current) => [...current, list]); setActiveId(list.id); setNewList('')
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setError(cause instanceof Error ? cause.message : 'That list could not be created.')
    } finally { setBusy(false) }
  }

  async function removeList() {
    if (!active || !window.confirm(`Delete “${active.title}” and all of its items?`)) return
    setBusy(true); setError('')
    try {
      await deleteList(active.id)
      setLists((current) => current.filter((list) => list.id !== active.id))
      setActiveId('')
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setError(cause instanceof Error ? cause.message : 'That list could not be deleted.')
    } finally { setBusy(false) }
  }

  async function submitItem(event: FormEvent) {
    event.preventDefault()
    if (!active || !newItem.trim()) return
    const value = newItem.trim(); setNewItem('')
    await apply(() => addListItems(active.id, [{ text: value }]))
  }

  if (loading) return (
    <div className="view lists-view" aria-busy="true">
      <div className="lists-skeleton side" /><div className="lists-skeleton body" />
    </div>
  )

  return (
    <div className="view lists-view">
      <aside className="lists-sidebar" aria-label="Your lists">
        <form className="lists-new" onSubmit={submitList}>
          <input value={newList} onChange={(event) => setNewList(event.target.value)} placeholder="New list" aria-label="New list name" />
          <button className="btn compact primary" disabled={busy || !newList.trim()} aria-label="Create list"><Hi icon={PlusIcon} size={15} /></button>
        </form>
        <div className="lists-index">
          {lists.map((list) => (
            <button key={list.id} className={`lists-index-row${active?.id === list.id ? ' active' : ''}`} onClick={() => setActiveId(list.id)}>
              <span>{list.title}</span>
              <span className="tnum">{list.checkedCount}/{list.itemCount}</span>
            </button>
          ))}
          {!lists.length && <p className="lists-index-empty">Create a list for groceries, packing, or anything else you want to check off.</p>}
        </div>
      </aside>

      <section className="lists-sheet">
        {error && <div className="lists-error" role="alert"><span>{error}</span><button className="link-btn" onClick={() => void load()}>Retry</button></div>}
        {!active ? (
          <div className="lists-empty"><Hi icon={CheckIcon} size={26} /><h2>No list selected</h2><p>Name one on the left, then add items as you think of them.</p></div>
        ) : <>
          <header className="lists-head">
            <input
              className="lists-title" value={active.title} aria-label="List title"
              onChange={(event) => setLists((current) => current.map((list) => list.id === active.id ? { ...list, title: event.target.value } : list))}
              onBlur={(event) => { if (event.target.value.trim()) void apply(() => updateList(active.id, { title: event.target.value.trim() })) }}
            />
            <span className="lists-progress tnum">{active.checkedCount} of {active.itemCount}</span>
            <button className="btn compact danger" onClick={() => void removeList()} disabled={busy} aria-label="Delete list"><Hi icon={TrashIcon} size={15} /></button>
          </header>

          <form className="lists-add-item" onSubmit={submitItem}>
            <input value={newItem} onChange={(event) => setNewItem(event.target.value)} placeholder="Add an item" aria-label="New list item" />
            <button className="btn compact primary" disabled={busy || !newItem.trim()}><Hi icon={PlusIcon} size={14} /> Add</button>
          </form>

          <div className="lists-items">
            {active.items.map((item) => (
              <div className={`lists-item${item.checked ? ' checked' : ''}`} key={item.id}>
                <input type="checkbox" checked={item.checked} disabled={busy} aria-label={`Check ${item.text}`}
                  onChange={(event) => void apply(() => updateListItem(item.id, { checked: event.target.checked }))} />
                <span>{item.text}</span>
                <button className="lists-item-remove" onClick={() => void apply(() => deleteListItem(item.id))} disabled={busy} aria-label={`Remove ${item.text}`}><Hi icon={XMarkIcon} size={15} /></button>
              </div>
            ))}
            {!active.items.length && <p className="lists-items-empty">This list is empty. Add the first item above.</p>}
          </div>

          <section className="lists-todos" aria-labelledby="list-related-title">
            <div className="lists-todos-head"><h3 id="list-related-title">Related todos</h3><span>{active.linkedTodos.length}</span></div>
            {active.linkedTodos.map((todo) => (
              <div className="lists-todo" key={todo.id}>
                <Hi icon={LinkIcon} size={14} /><span>{todo.title}</span><small>{todo.status}</small>
                <button onClick={() => void apply(() => unlinkListTodo(active.id, todo.id))} disabled={busy} aria-label={`Unlink ${todo.title}`}><Hi icon={XMarkIcon} size={14} /></button>
              </div>
            ))}
            <div className="lists-link-todo">
              <select value={todoId} onChange={(event) => setTodoId(event.target.value)} aria-label="Todo to link">
                <option value="">Link a todo…</option>
                {availableTodos.map((todo) => <option key={todo.id} value={todo.id}>{todo.title}</option>)}
              </select>
              <button className="btn compact" disabled={busy || !todoId} onClick={() => {
                if (!active || !todoId) return
                const selected = todoId; setTodoId(''); void apply(() => linkListTodo(active.id, selected))
              }}><Hi icon={LinkIcon} size={14} /> Link</button>
            </div>
          </section>
        </>}
      </section>
    </div>
  )
}
