// Productivity → Lists, drawn as the iPhone app draws it
// (mobile/src/features/productivity/ListsView.tsx and features/lists/ListDetailScreen.tsx):
// one row per list with how far along it is, a "New list" row at the foot, and a
// list opened as its own sheet: the title edits in place, the items still to do come
// first and the checked ones fold under "Checked", tasks linked to it sit under the
// title as chips, and the add line is at the foot. On a desktop the lists and the open
// list sit side by side; at phone width a list opens over the lists, with a back
// control, as the app pushes it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AuthError, addListItems, createList, deleteList, deleteListItem, getLists, getTodoBoard,
  linkListTodo, unlinkListTodo, updateList, updateListItem,
} from '../api'
import {
  ArrowUpIcon, CheckCircleIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, EllipsisHorizontalIcon,
  ExclamationTriangleIcon, EyeIcon, EyeSlashIcon, Hi, LinkIcon, PencilIcon, PlusIcon, TrashIcon, XMarkIcon,
} from '../icons'
import { findLanding, landKey, useLandOn } from '../landing'
import { pushToast } from '../toast'
import Menu, { type MenuEntry } from '../todos/Menu'
import { openTaskCard } from '../work/card'
import { cleanItemText, listProgress, splitItems, withChecked, withText, withoutItem } from '../lists/items'
import type { LinkedListTodo, ListItem, TotemList } from '../lists/types'
import type { Todo } from '../todos/types'
import IconListCheck from '@tabler/icons-react/dist/esm/icons/IconListCheck.mjs'
import '../lists/lists.css'

type Change = () => Promise<{ list: TotemList }>

export default function ListsView({ onAuthError }: { onAuthError: () => void }) {
  const [lists, setLists] = useState<TotemList[]>([])
  const [todos, setTodos] = useState<Todo[]>([])
  const [activeId, setActiveId] = useState('')
  // At phone width the open list covers the lists (the app's pushed screen).
  const [opened, setOpened] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const active = useMemo(() => lists.find((list) => list.id === activeId) ?? lists[0] ?? null, [lists, activeId])

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const [payload, board] = await Promise.all([getLists(), getTodoBoard({})])
      setLists(payload.lists)
      setTodos(board.todos)
      setActiveId((current) => payload.lists.some((list) => list.id === current) ? current : payload.lists[0]?.id ?? '')
      if (!quiet) setError('')
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setError(cause instanceof Error ? cause.message : 'Lists could not load.')
    } finally { if (!quiet) setLoading(false) }
  }, [onAuthError])

  useEffect(() => { void load() }, [load])

  // Changes go out one after another, and only the answer to the last one in flight
  // for that list is drawn: an earlier answer would undo the later changes already on
  // screen. Counted per list, so a change to another list never hides this one's answer.
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const sent = useRef<Record<string, number>>({})
  const send = useCallback((run: Change, optimistic: { id: string; next?: (list: TotemList) => TotemList }) => {
    if (optimistic.next) setLists((current) => current.map((list) => list.id === optimistic.id ? optimistic.next!(list) : list))
    const key = optimistic.id
    const mine = (sent.current[key] = (sent.current[key] || 0) + 1)
    setError('')
    const done = chain.current.then(async () => {
      try {
        const { list } = await run()
        if (mine === sent.current[key]) setLists((current) => current.map((value) => value.id === list.id ? list : value))
        return list
      } catch (cause) {
        if (cause instanceof AuthError) onAuthError()
        else {
          setError(cause instanceof Error ? cause.message : 'That change could not be saved.')
          await load(true)
        }
        return null
      }
    })
    chain.current = done
    return done
  }, [load, onAuthError])

  const open = useCallback((id: string) => { setActiveId(id); setOpened(true) }, [])

  async function submitList(title: string) {
    setError('')
    try {
      const { list } = await createList({ title })
      setLists((current) => [...current, list])
      open(list.id)
      return true
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setError(cause instanceof Error ? cause.message : 'That list could not be created.')
      return false
    }
  }

  async function removeList(list: TotemList) {
    const items = list.itemCount === 1 ? 'Its item goes' : list.itemCount ? `Its ${list.itemCount} items go` : 'It goes'
    if (!window.confirm(`Delete “${list.title}”? ${items} with it. This can’t be undone.`)) return
    setError('')
    try {
      await deleteList(list.id)
      setLists((current) => current.filter((value) => value.id !== list.id))
      setActiveId('')
      setOpened(false)
    } catch (cause) {
      if (cause instanceof AuthError) onAuthError()
      else setError(cause instanceof Error ? cause.message : 'That list could not be deleted.')
    }
  }

  // A search hit (landing.ts): open its list, then land on the item that matched,
  // or on the list's header when the title matched.
  useLandOn('list', {
    ready: !loading,
    prepare: ({ id }) => open(id),
    find: ({ id, extra }) => (extra.item ? findLanding(landKey('list-item', extra.item)) : null) ?? findLanding(landKey('list', id)),
  })

  if (loading) return (
    <div className="view lv-view" aria-busy="true">
      <div className="pk-page lv-page">
        <div className="pk-card lv-skeleton lv-skeleton-side" /><div className="pk-card lv-skeleton lv-skeleton-body" />
      </div>
    </div>
  )

  return (
    <div className={`view lv-view${opened && active ? ' lv-opened' : ''}`}>
      <div className="pk-page lv-page">
        <section className="pk-card lv-master" aria-label="Your lists">
          {error && !(opened && active) && <ErrorLine text={error} onRetry={() => void load()} master />}
          <MasterRows lists={lists} activeId={active?.id ?? ''} onOpen={open} />
          {!lists.length && (
            <div className="lv-empty">
              <IconListCheck size={34} stroke={1.5} aria-hidden="true" />
              <strong>No lists yet</strong>
              <p>Groceries, packing, anything you check off as you go. Name your first one below.</p>
            </div>
          )}
          <NewListRow onSubmit={submitList} />
        </section>

        {active ? (
          <ListSheet
            key={active.id}
            list={active}
            todos={todos}
            error={error}
            onRetry={() => void load()}
            onBack={() => setOpened(false)}
            onDelete={() => void removeList(active)}
            send={send}
          />
        ) : (
          <section className="pk-card lv-detail lv-detail-empty">
            <div className="pk-empty">
              <Hi icon={CheckIcon} size={26} />
              <span>Name a list, then add items as you think of them.</span>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function ErrorLine({ text, onRetry, master }: { text: string; onRetry?: () => void; master?: boolean }) {
  return (
    <div className={`lv-error${master ? ' lv-error-master' : ''}`} role="alert">
      <Hi icon={ExclamationTriangleIcon} size={15} />
      <span>{text}</span>
      {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
    </div>
  )
}

/** One row per list: its title, a thin bar and "1 of 5", linked tasks, a chevron. ↑/↓ move between rows. */
function MasterRows({ lists, activeId, onOpen }: { lists: TotemList[]; activeId: string; onOpen: (id: string) => void }) {
  function keydown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.lv-row'))
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    event.preventDefault()
    rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }
  if (!lists.length) return null
  return (
    <div className="lv-rows" onKeyDown={keydown}>
      {lists.map((list) => {
        const progress = listProgress(list)
        const linked = list.linkedTodos.filter((todo) => todo.status !== 'done').length
        const summary = [progress.label, linked ? `${linked} linked ${linked === 1 ? 'task' : 'tasks'}` : null].filter(Boolean).join(', ')
        return (
          <button
            key={list.id}
            type="button"
            className={`lv-row${list.id === activeId ? ' lv-active' : ''}${progress.done ? ' lv-done' : ''}`}
            aria-current={list.id === activeId ? 'true' : undefined}
            aria-label={`${list.title}, ${summary}`}
            onClick={() => onOpen(list.id)}
          >
            <span className="lv-row-main">
              <span className="lv-row-title">
                <span>{list.title}</span>
                {progress.done && <Hi icon={CheckCircleIcon} size={16} className="lv-green" />}
              </span>
              <span className="lv-row-meta">
                <span className="pk-bar lv-row-bar" style={{ '--bar': progress.done ? 'var(--green)' : 'var(--accent)' } as React.CSSProperties}>
                  <span style={{ width: `${progress.ratio * 100}%` }} />
                </span>
                <span className="tnum">{progress.label}</span>
                {linked > 0 && <span className="lv-row-linked tnum"><Hi icon={LinkIcon} size={12} />{linked}</span>}
              </span>
            </span>
            <Hi icon={ChevronRightIcon} size={16} className="lv-chevron" />
          </button>
        )
      })}
    </div>
  )
}

/** The foot of the lists: "+ New list", which becomes its name field when clicked. */
function NewListRow({ onSubmit }: { onSubmit: (title: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit() {
    const value = title.trim()
    if (!value || busy) return
    setBusy(true)
    const ok = await onSubmit(value)
    setBusy(false)
    if (ok) { setTitle(''); setEditing(false) }
  }
  if (!editing) {
    return (
      <button type="button" className="lv-new" onClick={() => setEditing(true)}>
        <span className="lv-plus"><Hi icon={PlusIcon} size={16} /></span>
        New list
      </button>
    )
  }
  return (
    <form className="lv-new lv-new-editing" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <span className="lv-plus"><Hi icon={PlusIcon} size={16} /></span>
      <input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Name the list"
        aria-label="New list name"
        disabled={busy}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setTitle(''); setEditing(false) } }}
        onBlur={() => { if (!title.trim()) setEditing(false) }}
      />
      <button className="pk-btn pk-primary pk-compact" disabled={busy || !title.trim()} aria-label="Create list">Create</button>
    </form>
  )
}

interface SheetProps {
  list: TotemList
  todos: Todo[]
  error: string
  onRetry: () => void
  onBack: () => void
  onDelete: () => void
  send: (run: Change, optimistic: { id: string; next?: (list: TotemList) => TotemList }) => Promise<TotemList | null>
}

/** One list, in a card: title, linked tasks, items still to do, Checked, and the add line. */
function ListSheet({ list, todos, error, onRetry, onBack, onDelete, send }: SheetProps) {
  const [title, setTitle] = useState(list.title)
  const [newItem, setNewItem] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showChecked, setShowChecked] = useState(true)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const addInput = useRef<HTMLInputElement>(null)

  useEffect(() => { setTitle(list.title) }, [list.title])

  const progress = listProgress(list)
  const { open, checked } = splitItems(list.items)
  const linked = new Set(list.linkedTodos.map((todo) => todo.id))
  const available = todos.filter((todo) => !linked.has(todo.id) && todo.status !== 'done')

  function saveTitle() {
    const next = title.trim()
    if (!next || next === list.title) { setTitle(list.title); return }
    void send(() => updateList(list.id, { title: next }), { id: list.id, next: (value) => ({ ...value, title: next }) })
  }

  function toggle(item: ListItem) {
    void send(() => updateListItem(item.id, { checked: !item.checked }), { id: list.id, next: (value) => withChecked(value, item.id, !item.checked) })
  }

  function saveText(item: ListItem, raw: string) {
    setEditingId(null)
    const text = cleanItemText(raw)
    if (!text || text === item.text) return
    void send(() => updateListItem(item.id, { text }), { id: list.id, next: (value) => withText(value, item.id, text) })
  }

  function remove(item: ListItem) {
    if (editingId === item.id) setEditingId(null)
    void send(() => deleteListItem(item.id), { id: list.id, next: (value) => withoutItem(value, item.id) }).then((saved) => {
      if (!saved) return
      pushToast(`Removed “${item.text}”`, 'success', {
        duration: 6000,
        action: { label: 'Undo', onClick: () => { void send(() => addListItems(list.id, [{ text: item.text, checked: item.checked }]), { id: list.id }) } },
      })
    })
  }

  function add(event: React.FormEvent) {
    event.preventDefault()
    const text = cleanItemText(newItem)
    if (!text) return
    setNewItem('')
    void send(() => addListItems(list.id, [{ text }]), { id: list.id }).then(() => addInput.current?.scrollIntoView({ block: 'nearest' }))
  }

  const menuItems: MenuEntry[] = [
    { key: 'rename', label: 'Rename', icon: PencilIcon, onSelect: () => { titleInput.current?.focus(); titleInput.current?.select() } },
    checked.length
      ? { key: 'checked', label: showChecked ? 'Hide checked items' : 'Show checked items', icon: showChecked ? EyeSlashIcon : EyeIcon, onSelect: () => setShowChecked((v) => !v) }
      : null,
    'separator',
    { key: 'delete', label: 'Delete list…', icon: TrashIcon, danger: true, onSelect: onDelete },
  ].filter(Boolean) as MenuEntry[]

  const itemRow = (item: ListItem) => (
    <ItemRow
      key={item.id}
      item={item}
      editing={editingId === item.id}
      onToggle={() => toggle(item)}
      onEdit={() => setEditingId(item.id)}
      onSave={(text) => saveText(item, text)}
      onCancel={() => setEditingId(null)}
      onRemove={() => remove(item)}
    />
  )

  return (
    <section className="pk-card lv-detail" aria-label={list.title}>
      <header className="lv-head" data-land={landKey('list', list.id)}>
        <button type="button" className="lv-back" onClick={onBack} aria-label="Back to lists">
          <Hi icon={ChevronLeftIcon} size={20} /> Lists
        </button>
        <input
          ref={titleInput}
          className="lv-title"
          value={title}
          aria-label="List title"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            else if (event.key === 'Escape') { setTitle(list.title); requestAnimationFrame(() => titleInput.current?.blur()) }
          }}
        />
        <button
          type="button"
          className="pk-icon-btn pk-ghost lv-more"
          aria-label="List actions"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={(event) => setMenu(menu ? null : event.currentTarget)}
        >
          <Hi icon={EllipsisHorizontalIcon} size={20} />
        </button>
        <span className="lv-sub tnum">{list.itemCount ? `${progress.label} checked` : 'No items yet'}</span>
      </header>
      {menu && <Menu anchor={menu} label="List actions" items={menuItems} onClose={() => setMenu(null)} width={220} />}

      <LinkedTasks
        list={list}
        available={available}
        onLink={(todoId) => void send(() => linkListTodo(list.id, todoId), { id: list.id })}
        onUnlink={(todo) => void send(() => unlinkListTodo(list.id, todo.id), { id: list.id })}
      />

      {error && <ErrorLine text={error} onRetry={onRetry} />}
      {open.length === 0 && checked.length > 0 && (
        <p className="lv-all-done"><Hi icon={CheckCircleIcon} size={18} /> All done</p>
      )}

      <div className="lv-items">
        {open.map(itemRow)}
        {checked.length > 0 && (
          <button type="button" className="lv-group" aria-expanded={showChecked} onClick={() => setShowChecked((v) => !v)}>
            <span>Checked</span>
            <span className="tnum">{checked.length}</span>
            <Hi icon={ChevronDownIcon} size={14} className={`lv-group-chevron${showChecked ? '' : ' lv-folded'}`} />
          </button>
        )}
        {showChecked && checked.map(itemRow)}
        {!list.items.length && <p className="lv-items-empty">Nothing on this list yet. Type the first item below.</p>}
      </div>

      <form className="lv-add" onSubmit={add}>
        <label className="lv-add-field">
          <Hi icon={PlusIcon} size={18} />
          <input ref={addInput} value={newItem} onChange={(event) => setNewItem(event.target.value)} placeholder="Add an item" aria-label="New list item" />
        </label>
        <button className="lv-send" disabled={!cleanItemText(newItem)} aria-label="Add item"><Hi icon={ArrowUpIcon} size={18} /></button>
      </form>
    </section>
  )
}

function ItemRow({ item, editing, onToggle, onEdit, onSave, onCancel, onRemove }: {
  item: ListItem
  editing: boolean
  onToggle: () => void
  onEdit: () => void
  onSave: (text: string) => void
  onCancel: () => void
  onRemove: () => void
}) {
  const [draft, setDraft] = useState(item.text)
  const cancelled = useRef(false)
  useEffect(() => { if (editing) { setDraft(item.text); cancelled.current = false } }, [editing, item.text])
  return (
    <div className={`lv-item${item.checked ? ' lv-checked' : ''}`} data-land={landKey('list-item', item.id)}>
      <button type="button" role="checkbox" aria-checked={item.checked} aria-label={item.text} className="lv-check" onClick={onToggle}>
        <span className="lv-circle">{item.checked && <Hi icon={CheckIcon} size={14} />}</span>
      </button>
      {editing ? (
        <input
          autoFocus
          className="lv-item-edit"
          value={draft}
          aria-label={`Edit ${item.text}`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => { if (cancelled.current) onCancel(); else onSave(draft) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            else if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; event.currentTarget.blur() }
          }}
        />
      ) : (
        <button type="button" className="lv-item-text" onClick={onEdit} title="Edit" aria-label={`Edit ${item.text}`}>{item.text}</button>
      )}
      <button type="button" className="pk-icon-btn pk-ghost pk-compact lv-remove" onClick={onRemove} aria-label={`Remove ${item.text}`}>
        <Hi icon={XMarkIcon} size={15} />
      </button>
    </div>
  )
}

/** The tasks linked to this list, as chips: "Link a task" first, then each task (open it; × unlinks). */
function LinkedTasks({ list, available, onLink, onUnlink }: {
  list: TotemList
  available: Todo[]
  onLink: (todoId: string) => void
  onUnlink: (todo: LinkedListTodo) => void
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const items: MenuEntry[] = available.length
    ? available.map((todo) => ({ key: todo.id, label: todo.title, onSelect: () => onLink(todo.id) }))
    : [{ key: 'none', label: 'No open tasks to link', disabled: true, onSelect: () => {} }]
  return (
    <div className="lv-chips" aria-label="Linked tasks" role="group">
      <button
        type="button"
        className="lv-chip lv-chip-add"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(event) => setMenu(menu ? null : event.currentTarget)}
      >
        <Hi icon={LinkIcon} size={14} /> {list.linkedTodos.length ? 'Link' : 'Link a task'}
      </button>
      {menu && <Menu anchor={menu} label="Link a task" items={[{ heading: 'Link a task' }, ...items]} onClose={() => setMenu(null)} width={300} />}
      {list.linkedTodos.map((todo) => {
        const done = todo.status === 'done'
        return (
          <span key={todo.id} className={`lv-chip${done ? ' lv-chip-done' : ''}`}>
            <button type="button" className="lv-chip-open" onClick={() => openTaskCard(todo.id)} aria-label={`Task: ${todo.title}, ${done ? 'done' : 'to do'}`}>
              <span className="pk-dot" style={{ '--dot': done ? 'var(--green)' : 'var(--muted)' } as React.CSSProperties} />
              <span className="lv-chip-title">{todo.title}</span>
            </button>
            <button type="button" className="lv-chip-x" onClick={() => onUnlink(todo)} aria-label={`Unlink ${todo.title}`}>
              <Hi icon={XMarkIcon} size={13} />
            </button>
          </span>
        )
      })}
    </div>
  )
}
