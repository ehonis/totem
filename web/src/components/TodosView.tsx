// Productivity → Tasks on the web: one grouped list of what needs doing (yours and
// the shared task sheet's), a detail pane beside it, and a keyboard map. The list is
// buildList's (todos/board.ts, shared byte for byte with the iPhone app): Overdue,
// Today, Upcoming, No date, then Snoozed and Completed folded at the foot. Rows tick
// off in one click, x or Space, with Undo; everything else about a task is edited in
// the pane, in place, with nothing to save. Below ~1100 px the pane slides over the
// list; at phone width it fills the screen. docs/tasks.md has the keys.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Hi, ChevronDownIcon, EllipsisHorizontalIcon, MagnifyingGlassIcon, PlusIcon, XMarkIcon, ArchiveBoxIcon, TrashIcon, ArrowPathIcon, AdjustmentsHorizontalIcon, CheckCircleIcon, FlagIcon } from '../icons'
import { COMMANDS } from '../shortcuts'
import { useCommand, isTypingTarget } from '../useShortcuts'
import { buildList, byWake, nextWake, sectionFor, sheetName as nameOfSheet, wakeLabel, SECTION_TITLE, type ListItem, type SectionKey } from '../todos/board'
import { dateKey } from '../todos/format'
import { filterTodos } from '../todos/state'
import type { SheetItem, Todo } from '../todos/types'
import { useVentureTags } from '../todos/ventureTags'
import { useTaskBoard } from '../todos/useTaskBoard'
import Menu, { type MenuEntry } from '../todos/Menu'
import { DueMenu, PriorityMenu, PRIORITIES, priorityName, SnoozeMenu } from '../todos/TaskMenus'
import QuickAdd, { type QuickAddHandle, type Scope } from '../todos/QuickAdd'
import { SheetRow, TaskRow, issueKey, type RowPlace } from '../todos/TaskRow'
import { ShelfPane, SheetDetail, SummaryPane, TaskDetail, type Summary } from '../todos/TaskPane'
import { SheetIcon, SnoozeIcon } from '../todos/taskIcons'
import { snoozeTimes } from '../todos/format'
import '../todos/todos.css'

type Pane = { kind: 'task'; id: string; notes?: number } | { kind: 'sheet'; id: string } | { kind: 'shelf'; shelf: 'archive' | 'deleted' } | null
type RowMenu = { kind: 'snooze' | 'due' | 'priority'; id: string; anchor: HTMLElement | null }

const VIEW_KEY = 'totem.tasks.view'
interface SavedView { scope: Scope; snoozedOpen: boolean; completedOpen: boolean }
function readView(): SavedView {
  const fallback: SavedView = { scope: 'all', snoozedOpen: false, completedOpen: false }
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null') as Partial<SavedView> | null
    return {
      scope: saved?.scope === 'Personal' || saved?.scope === 'Ventures' || saved?.scope === 'sheet' ? saved.scope : 'all',
      snoozedOpen: saved?.snoozedOpen === true,
      completedOpen: saved?.completedOpen === true,
    }
  } catch { return fallback }
}
function writeView(view: SavedView) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)) } catch { /* a convenience; the page works without it */ }
}

/** Below this the pane slides over the list instead of sitting beside it. */
const OVERLAY_QUERY = '(max-width: 1100px)'
function useOverlay() {
  const [overlay, setOverlay] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.(OVERLAY_QUERY).matches))
  useEffect(() => {
    const media = window.matchMedia?.(OVERLAY_QUERY)
    if (!media) return
    const update = () => setOverlay(media.matches)
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return overlay
}

const keyOf = (item: ListItem) => (item.kind === 'task' ? item.todo.id : item.item.id)
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

function sheetMatches(item: SheetItem, needle: string) {
  return `${item.title}\n${item.notes}\n${item.who}`.toLocaleLowerCase().includes(needle)
}

function openSettings(hash: string) {
  window.history.pushState(null, '', `/settings/tasks${hash}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

interface TodosViewProps {
  onAuthError: () => void
  /** The page's clock; tests pin it. */
  now?: () => Date
  /** How long a ticked row stays checked before it leaves; tests shorten it. */
  beatMs?: number
}

export default function TodosView({ onAuthError, now: clock = () => new Date(), beatMs }: TodosViewProps) {
  const clockRef = useRef(clock)
  clockRef.current = clock
  const [now, setNow] = useState(() => clock())
  // Ticks each minute so "Today" turns over at midnight and snoozes come back on time.
  useEffect(() => {
    const timer = setInterval(() => setNow(clockRef.current()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const board = useTaskBoard({ onAuthError, now: () => clockRef.current(), beatMs })
  const ventureTags = useVentureTags()
  const overlay = useOverlay()

  const [view, setView] = useState<SavedView>(readView)
  useEffect(() => { writeView(view) }, [view])
  const [search, setSearch] = useState('')
  const [pane, setPane] = useState<Pane>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null)
  const [headMenu, setHeadMenu] = useState<HTMLElement | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [bulkMenu, setBulkMenu] = useState<null | { kind: 'snooze' | 'priority'; anchor: HTMLElement }>(null)
  const [flashId, setFlashId] = useState<string | null>(null)

  const root = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const quickAdd = useRef<QuickAddHandle>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())
  const snoozedHead = useRef<HTMLButtonElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useCommand(COMMANDS.todoNew, () => quickAdd.current?.focus())

  const feed = board.sheet
  const sheetOn = feed?.configured === true
  const sheetName = nameOfSheet(feed)
  const sheetItems = useMemo(() => (feed?.items ?? []), [feed])
  const hasVentures = ventureTags.length > 0 || board.todos.some((todo) => todo.area === 'Ventures')
  // A saved scope whose chip is gone (no sheet set up, no ventures left) shows everything.
  const scope: Scope = (view.scope === 'sheet' && feed && !sheetOn) || (view.scope === 'Ventures' && board.loaded && !hasVentures) ? 'all' : view.scope

  // Everything, for the live line and the summary: what the day holds, whatever is filtered.
  const full = useMemo(() => buildList(board.todos, sheetItems, { now }), [board.todos, sheetItems, now])
  const needle = search.trim().toLocaleLowerCase()
  const todos = useMemo(() => {
    if (scope === 'sheet') return []
    const scoped = scope === 'all' ? board.todos : board.todos.filter((todo) => todo.area === scope)
    return needle ? filterTodos(scoped, { search: needle }, now) : scoped
  }, [board.todos, scope, needle, now])
  const sheet = useMemo(() => {
    if (scope === 'Personal' || scope === 'Ventures') return []
    return needle ? sheetItems.filter((item) => sheetMatches(item, needle)) : sheetItems
  }, [sheetItems, scope, needle])
  const list = useMemo(() => buildList(todos, sheet, { now }), [todos, sheet, now])
  const snoozed = useMemo(() => byWake(todos.filter((todo) => todo.status !== 'done' && todo.snoozedUntil && new Date(todo.snoozedUntil) > now)), [todos, now])
  const allSnoozed = useMemo(() => board.todos.filter((todo) => todo.status !== 'done' && todo.snoozedUntil && new Date(todo.snoozedUntil) > now), [board.todos, now])
  const today = dateKey(now)
  const completed = list.completed
  // Which headings are drawn: the sticky observer below re-runs only when this changes.
  const drawnHeadings = `${board.loaded}:${list.sections.map((section) => section.key).join(',')}:${snoozed.length > 0}:${completed.length > 0}`

  // A section heading is drawn bare at rest and gets its band only while stuck to the
  // top of the list, so the glow is not cut into slabs. A 1 px sentinel above each
  // heading says when it has scrolled under the top edge.
  useEffect(() => {
    const root = scroller.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const head = (entry.target as HTMLElement).nextElementSibling
        const top = entry.rootBounds?.top ?? 0
        head?.classList.toggle('stuck', !entry.isIntersecting && entry.boundingClientRect.top < top)
      }
    }, { root, threshold: 0 })
    root.querySelectorAll('.tk-sentinel').forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [drawnHeadings])
  const completedTitle = completed.every((todo) => todo.completedAt && dateKey(new Date(todo.completedAt)) === today) ? 'Completed today' : 'Completed'

  // Rows in the order they are drawn: the keyboard walks this.
  const order = useMemo(() => {
    const keys: string[] = []
    for (const section of list.sections) for (const item of section.items) keys.push(keyOf(item))
    if (view.snoozedOpen) for (const todo of snoozed) keys.push(todo.id)
    if (view.completedOpen) for (const todo of completed) keys.push(todo.id)
    return keys
  }, [list, snoozed, completed, view.snoozedOpen, view.completedOpen])

  const todoById = useMemo(() => new Map(board.todos.map((todo) => [todo.id, todo])), [board.todos])
  const sheetById = useMemo(() => new Map(sheetItems.map((item) => [item.id, item])), [sheetItems])
  // The keyboard cursor. When its row leaves (finished, snoozed, binned, moved out of
  // view), it stays at the same place in the list, on the row that took its spot, never
  // back at the top.
  const lastIndex = useRef(0)
  const activeAt = activeKey ? order.indexOf(activeKey) : -1
  const active = activeAt >= 0 ? activeKey : order[Math.min(lastIndex.current, order.length - 1)] ?? null
  useEffect(() => { const at = active ? order.indexOf(active) : -1; if (at >= 0) lastIndex.current = at }, [active, order])

  const counts = {
    overdue: full.sections.find((section) => section.key === 'overdue')?.items.length ?? 0,
    today: full.sections.find((section) => section.key === 'today')?.items.length ?? 0,
  }
  const liveLine = [
    counts.overdue ? `${counts.overdue.toLocaleString()} overdue` : null,
    counts.today ? `${counts.today.toLocaleString()} today` : null,
    board.doneTodayCount ? `${board.doneTodayCount.toLocaleString()} done today` : null,
  ].filter(Boolean).join(' · ') || (board.loaded ? 'Nothing due today' : '')

  // The Snoozed fold's "next back" is about the snoozed tasks it holds (this scope and search).
  const wakeAt = nextWake(snoozed, now)
  const summary: Summary = useMemo(() => {
    const upcoming = full.sections.find((section) => section.key === 'upcoming')?.items[0]
    const first = byWake(allSnoozed)[0]
    return {
      overdue: counts.overdue, today: counts.today, doneToday: board.doneTodayCount,
      nextDue: upcoming ? (upcoming.kind === 'task' ? upcoming.todo.dueDate : upcoming.item.dueDate) : null,
      snoozed: allSnoozed.length,
      nextBack: first?.snoozedUntil ? { title: first.title, at: new Date(first.snoozedUntil) } : null,
    }
  }, [full, allSnoozed, counts.overdue, counts.today, board.doneTodayCount])

  /* ---------------- focus and the pane ---------------- */

  const focusRow = useCallback((key: string | null, scroll = true) => {
    if (!key) return
    setActiveKey(key)
    const go = () => {
      const el = rows.current.get(key)
      if (!el) return false
      el.focus({ preventScroll: true })
      if (scroll) el.scrollIntoView?.({ block: 'nearest' })
      return true
    }
    // A row that is not drawn yet (a fold just opened) is focused once it is.
    if (!go()) requestAnimationFrame(go)
  }, [])

  // Whether the keyboard is working the list. A row that unmounts under focus (it was
  // finished, moved group, or a menu changed it) drops focus to <body>; while this is
  // set, the cursor's row takes it back after the render, so the next key still lands.
  const listFocused = useRef(false)
  useLayoutEffect(() => {
    if (!listFocused.current || !active) return
    const el = document.activeElement
    if (el && el !== document.body) return
    rows.current.get(active)?.focus({ preventScroll: true })
  })
  /** After a row menu closes: the list has the keyboard again. */
  const backToList = () => { listFocused.current = true }

  // m (or "Add a note") bumps this, so a second press focuses the composer again.
  const noteBump = useRef(0)
  const openKey = useCallback((key: string, notes = false) => {
    if (sheetById.has(key)) setPane({ kind: 'sheet', id: key })
    else setPane({ kind: 'task', id: key, notes: notes ? ++noteBump.current : undefined })
  }, [sheetById])

  const closePane = useCallback(() => {
    setPane(null)
    if (active) focusRow(active, false)
  }, [active, focusRow])

  // The pane follows the keyboard cursor once open, as a mail client's reading pane does.
  const follow = (key: string) => {
    setActiveKey(key)
    if (pane && (pane.kind === 'task' || pane.kind === 'sheet')) openKey(key)
  }

  // A new task: make sure it can be seen, then scroll to it and flash it, without taking
  // focus from the quick-add line. The reveal is taken (cleared) at once; the scroll and
  // the flash hang off flashId, so clearing it cannot cancel them.
  useEffect(() => {
    const id = board.revealId
    if (!id) return
    board.clearReveal()
    const todo = todoById.get(id)
    if (todo) {
      if (view.scope !== 'all' && (view.scope === 'sheet' || view.scope !== todo.area)) setView((current) => ({ ...current, scope: 'all' }))
      if (needle && !filterTodos([todo], { search: needle }, now).length) setSearch('')
    }
    setActiveKey(id)
    setFlashId(id)
    // Only a new reveal should run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.revealId])
  useLayoutEffect(() => {
    if (flashId) rows.current.get(flashId)?.scrollIntoView?.({ block: 'nearest' })
  }, [flashId])
  useEffect(() => {
    if (!flashId) return
    const timer = setTimeout(() => setFlashId(null), 1400)
    return () => clearTimeout(timer)
  }, [flashId])

  /* ---------------- actions ---------------- */

  /** The row the cursor should land on once `key` leaves the list: the next one, else the one above. */
  const nextAfter = (key: string) => {
    const at = order.indexOf(key)
    return at < 0 ? null : order[at + 1] ?? order[at - 1] ?? null
  }
  /**
   * A row is about to leave the list (finished, snoozed, binned). If the cursor is on
   * it, the cursor moves to the next row, keeping focus in the list if it was there.
   * If the open pane shows it, the pane follows to that row too, as it does for j/k,
   * or closes when no row is left. Any other row leaving moves neither: snoozing a row
   * from its hover tools leaves the pane on the task it shows.
   */
  const stepOff = (key: string) => {
    const paneOnIt = Boolean(pane && (pane.kind === 'task' || pane.kind === 'sheet') && pane.id === key)
    const cursorOnIt = key === active
    if (!paneOnIt && !cursorOnIt) return
    const next = nextAfter(key)
    if (!next) {
      if (paneOnIt) setPane(null)
      return
    }
    if (paneOnIt) follow(next); else setActiveKey(next)
    if (cursorOnIt && listFocused.current) focusRow(next)
  }
  const toggle = (todo: Todo, fromKeyboard = false) => {
    if (todo.status === 'done') { void board.reopen(todo); return }
    // From the keyboard the cursor goes on to the next row at once, so x x x walks the
    // list; a click leaves it on the ticked row for its beat.
    if (fromKeyboard) stepOff(todo.id)
    void board.complete(todo)
  }
  const toggleSelected = (id: string) => setSelection((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const endSelect = () => { setSelectMode(false); setSelection(new Set()); setBulkMenu(null) }

  function rowMenuFor(key: string, kind: RowMenu['kind']) {
    const todo = todoById.get(key)
    if (!todo || todo.status === 'done') return
    const row = rows.current.get(key) ?? null
    // The hover tools are hidden on a device without hover; then the menu hangs from the row's marks.
    const shown = (el: HTMLElement | null | undefined) => (el && el.getClientRects().length ? el : null)
    const anchor = (kind !== 'priority' ? shown(row?.querySelector<HTMLElement>('.tk-tools')) : null) ?? shown(row?.querySelector<HTMLElement>('.tk-marks')) ?? row
    setRowMenu({ kind, id: key, anchor })
  }

  /* ---------------- keyboard ---------------- */

  function onGridKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement
    // Keys work from a task or sheet row, or from a control inside one (the select
    // box, an issue link). A fold heading is in no row, so its Space and Enter toggle
    // the fold, and a control inside a row keeps its own Space and Enter.
    const row = target.closest<HTMLElement>('[data-row]')
    if (isTypingTarget(target) || !row) return
    if (target !== row && (event.key === ' ' || event.key === 'Enter')) return
    const key = row.dataset.row ?? active
    if (!key) return
    const at = order.indexOf(key)
    const move = (index: number) => {
      event.preventDefault()
      const next = order[Math.max(0, Math.min(order.length - 1, index))]
      if (next) { follow(next); focusRow(next) }
    }
    const todo = todoById.get(key)
    const item = sheetById.get(key)
    switch (event.key) {
      case 'ArrowDown': case 'j': return move(at + 1)
      case 'ArrowUp': case 'k': return move(at - 1)
      case 'Home': return move(0)
      case 'End': return move(order.length - 1)
      case 'Enter': event.preventDefault(); return openKey(key)
      case ' ': case 'x':
        event.preventDefault()
        if (selectMode && todo) return toggleSelected(key)
        if (todo) toggle(todo, true)
        return
      case 's': case 'd': case 'p':
        if (todo && !selectMode) { event.preventDefault(); rowMenuFor(key, event.key === 's' ? 'snooze' : event.key === 'd' ? 'due' : 'priority') }
        return
      case 'n':
        event.preventDefault()
        quickAdd.current?.focus()
        return
      case 'm':
        if (todo) { event.preventDefault(); openKey(key, true) }
        return
      case 'o':
        if (item) { event.preventDefault(); window.open(item.url, '_blank', 'noopener,noreferrer') }
        else if (todo?.issueLink) { event.preventDefault(); window.open(todo.issueLink.url, '_blank', 'noopener,noreferrer') }
        return
      case 'Delete': case 'Backspace':
        if (todo && !selectMode) {
          event.preventDefault()
          stepOff(key)
          void board.remove(todo)
        }
        return
    }
  }

  // Page-wide keys: / searches, n adds, Esc closes, and j/k from nowhere lands on the list.
  // One listener for the page's life; it reads this render's state through a ref.
  const pageKey = useRef<(event: KeyboardEvent) => void>(() => {})
  pageKey.current = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const el = document.activeElement as HTMLElement | null
    const onPage = !el || el === document.body || Boolean(root.current?.contains(el))
    // A dialog or menu over the page (Settings, a portalled menu) keeps its own keys,
    // even while its own focus has fallen to <body>.
    if (!onPage || (el && el.closest('[role="menu"], [role="dialog"]'))) return
    if (document.querySelector('[role="dialog"], [aria-modal="true"], .modal-backdrop')) return
    if (event.key === 'Escape') {
      if (isTypingTarget(event.target) && event.target === searchInput.current) {
        if (search) setSearch(''); else searchInput.current?.blur()
        event.preventDefault()
        return
      }
      if (pane) { event.preventDefault(); closePane(); return }
      if (selectMode) { event.preventDefault(); endSelect(); return }
      return
    }
    if (isTypingTarget(event.target)) return
    const inGrid = Boolean(grid.current?.contains(el))
    if (event.key === '/') { event.preventDefault(); searchInput.current?.focus(); searchInput.current?.select(); return }
    if (inGrid) return
    if (event.key === 'n') { event.preventDefault(); quickAdd.current?.focus(); return }
    if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key) && (!el || el === document.body || el === root.current)) {
      event.preventDefault()
      focusRow(active)
    }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => pageKey.current(event)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---------------- drawing ---------------- */

  const rowRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) rows.current.set(key, el); else rows.current.delete(key)
  }
  const openId = pane && (pane.kind === 'task' || pane.kind === 'sheet') ? pane.id : null

  const drawTask = (todo: Todo, place: RowPlace) => (
    <TaskRow
      key={todo.id}
      todo={todo}
      place={place}
      now={now}
      active={active === todo.id}
      open={openId === todo.id}
      flash={flashId === todo.id}
      ticking={board.ticking.has(todo.id)}
      issue={todo.issueLink ? board.issues?.states[issueKey(todo.issueLink)] : undefined}
      ventureTags={ventureTags}
      selectMode={selectMode}
      selected={selection.has(todo.id)}
      rowRef={rowRef(todo.id)}
      onFocusRow={() => setActiveKey(todo.id)}
      onOpen={() => { setActiveKey(todo.id); openKey(todo.id); focusRow(todo.id, false) }}
      onToggle={() => { setActiveKey(todo.id); toggle(todo) }}
      onSelect={() => toggleSelected(todo.id)}
      onTools={(kind, anchor) => { setActiveKey(todo.id); setRowMenu({ kind, id: todo.id, anchor }) }}
    />
  )
  const drawItem = (item: ListItem, place: SectionKey) => item.kind === 'task' ? drawTask(item.todo, place) : (
    <SheetRow
      key={item.item.id}
      item={item.item}
      place={place}
      source={sheetName}
      now={now}
      active={active === item.item.id}
      open={openId === item.item.id}
      selectMode={selectMode}
      rowRef={rowRef(item.item.id)}
      onFocusRow={() => setActiveKey(item.item.id)}
      onOpen={() => { setActiveKey(item.item.id); openKey(item.item.id); focusRow(item.item.id, false) }}
    />
  )

  const filtering = Boolean(needle) || scope !== 'all'
  const nothing = !list.sections.length && !snoozed.length && !completed.length

  // The sheet's state, once and quietly, wherever its rows would be drawn: the read
  // failed (rows gone, or the last good rows shown stale), or nothing is assigned.
  const sheetShown = scope === 'all' || scope === 'sheet'
  let sheetNote: { text: string; retry: boolean } | null = null
  if (sheetShown) {
    if (board.sheetError) {
      // The route failed; rows read before are still drawn, so say they are old rather than missing.
      sheetNote = feed?.configured && feed.items.length
        ? { text: `${sheetName}: showing rows read${feed.fetchedAt ? ` at ${new Date(feed.fetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ' earlier'}; the last read failed: ${board.sheetError}`, retry: true }
        : { text: `${sheetName} could not be read, so its rows are missing: ${board.sheetError}`, retry: true }
    }
    else if (feed?.configured && (feed.stale || feed.error)) {
      sheetNote = feed.fetchedAt
        ? { text: `${sheetName}: showing rows read at ${new Date(feed.fetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}; the last read failed.`, retry: true }
        : { text: `${sheetName} could not be read yet${feed.error ? `: ${feed.error}` : '.'}`, retry: true }
    } else if (scope === 'sheet' && feed?.configured && !feed.items.length) sheetNote = { text: `Nothing in ${sheetName} is assigned to you.`, retry: false }
  }

  const chips: Array<{ id: Scope; label: string; count: number }> = [
    { id: 'all', label: 'All', count: full.sections.reduce((n, section) => n + section.items.length, 0) },
    { id: 'Personal', label: 'Personal', count: full.sections.reduce((n, section) => n + section.items.filter((item) => item.kind === 'task' && item.todo.area === 'Personal').length, 0) },
    ...(hasVentures ? [{ id: 'Ventures' as Scope, label: 'Ventures', count: full.sections.reduce((n, section) => n + section.items.filter((item) => item.kind === 'task' && item.todo.area === 'Ventures').length, 0) }] : []),
    ...(sheetOn ? [{ id: 'sheet' as Scope, label: sheetName, count: sheetItems.length }] : []),
  ]

  const headItems: MenuEntry[] = [
    { key: 'select', label: selectMode ? 'Stop selecting' : 'Select tasks', icon: CheckCircleIcon, onSelect: () => (selectMode ? endSelect() : setSelectMode(true)) },
    'separator',
    { key: 'snoozed', label: 'Snoozed', detail: allSnoozed.length.toLocaleString(), icon: SnoozeIcon, onSelect: () => { setView((current) => ({ ...current, snoozedOpen: true })); requestAnimationFrame(() => { snoozedHead.current?.scrollIntoView?.({ block: 'start' }); snoozedHead.current?.focus() }) } },
    { key: 'archive', label: 'Archive', detail: board.counts.archived.toLocaleString(), icon: ArchiveBoxIcon, onSelect: () => setPane({ kind: 'shelf', shelf: 'archive' }) },
    { key: 'deleted', label: 'Recycle bin', detail: board.counts.deleted.toLocaleString(), icon: TrashIcon, onSelect: () => setPane({ kind: 'shelf', shelf: 'deleted' }) },
    'separator',
    ...(sheetOn ? [{ key: 'sheet', label: `Read ${sheetName} again`, icon: ArrowPathIcon, onSelect: () => void board.loadSheet(true) }] : []),
    { key: 'settings', label: 'Task settings', icon: AdjustmentsHorizontalIcon, onSelect: () => openSettings('') },
  ]

  const paneTodo = pane?.kind === 'task' ? todoById.get(pane.id) : undefined
  const paneSheet = pane?.kind === 'sheet' ? sheetById.get(pane.id) : undefined
  let paneBody: React.ReactNode = null
  if (paneTodo) {
    paneBody = (
      <TaskDetail
        key={paneTodo.id}
        todo={paneTodo}
        board={board}
        now={now}
        issue={paneTodo.issueLink ? board.issues?.states[issueKey(paneTodo.issueLink)] : undefined}
        ventureTags={ventureTags}
        focusNotes={pane?.kind === 'task' && pane.notes}
        onClose={closePane}
        onOpenTask={(id) => { if (todoById.has(id)) { setActiveKey(id); setPane({ kind: 'task', id }) } }}
      />
    )
  } else if (paneSheet) {
    paneBody = <SheetDetail key={paneSheet.id} item={paneSheet} feed={feed} now={now} onClose={closePane} />
  } else if (pane?.kind === 'shelf') {
    paneBody = <ShelfPane key={pane.shelf} kind={pane.shelf} board={board} onClose={closePane} />
  } else if (!overlay) {
    paneBody = <SummaryPane summary={summary} now={now} feed={feed} sheetError={board.sheetError} onSetUpSheet={() => openSettings('#task-sheet')} />
  }
  const paneOpen = Boolean(paneTodo || paneSheet || pane?.kind === 'shelf')

  const menuTodo = rowMenu ? todoById.get(rowMenu.id) : undefined
  const selectedIds = [...selection].filter((id) => todoById.has(id))

  return (
    <div ref={root} className={`view tk-view${overlay ? ' overlay' : ''}${paneOpen ? ' pane-open' : ''}`}>
      <header className="tk-head">
        <div className="tk-head-title">
          <h1>Tasks</h1>
          <p className="tk-live" aria-live="polite">{liveLine}</p>
        </div>
        <div className="tk-head-actions">
          <label className="tk-search">
            <Hi icon={MagnifyingGlassIcon} size={15} />
            <input ref={searchInput} type="search" aria-label="Search tasks" placeholder="Search" value={search} onChange={(event) => setSearch(event.target.value)} />
            {search ? <button type="button" className="tk-icon-btn small" aria-label="Clear search" onClick={() => { setSearch(''); searchInput.current?.focus() }}><Hi icon={XMarkIcon} size={13} /></button> : <kbd className="tk-kbd" aria-hidden="true">/</kbd>}
          </label>
          <button type="button" className="btn primary compact tk-new" onClick={() => quickAdd.current?.focus()}><Hi icon={PlusIcon} size={15} /><span>New task</span></button>
          <button type="button" className="tk-icon-btn" aria-label="More" aria-haspopup="menu" aria-expanded={Boolean(headMenu)} onClick={(event) => setHeadMenu(headMenu ? null : event.currentTarget)}><Hi icon={EllipsisHorizontalIcon} size={18} /></button>
        </div>
      </header>

      <div className="tk-scopes" role="radiogroup" aria-label="Show">
        {chips.map((chip) => (
          <button key={chip.id} type="button" role="radio" aria-checked={scope === chip.id} className={`tk-scope${scope === chip.id ? ' on' : ''}`} onClick={() => setView((current) => ({ ...current, scope: chip.id }))}>
            {chip.label}{chip.count > 0 && <span>{chip.count.toLocaleString()}</span>}
          </button>
        ))}
      </div>

      <div className="tk-body">
        <div className="tk-scroll" ref={scroller}>
          {selectMode ? (
            <div className="tk-bulk" role="toolbar" aria-label="Selected tasks">
              <span className="tk-bulk-count">{plural(selectedIds.length, 'task')} selected</span>
              <button type="button" className="btn compact" disabled={!selectedIds.length} onClick={() => { void board.bulk(selectedIds, 'complete'); setSelection(new Set()) }}>Done</button>
              <button type="button" className="btn compact" disabled={!selectedIds.length} aria-haspopup="menu" onClick={(event) => setBulkMenu({ kind: 'snooze', anchor: event.currentTarget })}><Hi icon={SnoozeIcon} size={14} />Snooze<Hi icon={ChevronDownIcon} size={12} /></button>
              <button type="button" className="btn compact" disabled={!selectedIds.length} aria-haspopup="menu" onClick={(event) => setBulkMenu({ kind: 'priority', anchor: event.currentTarget })}><Hi icon={FlagIcon} size={14} />Priority<Hi icon={ChevronDownIcon} size={12} /></button>
              <button type="button" className="btn compact danger" disabled={!selectedIds.length} onClick={() => { void board.bulk(selectedIds, 'delete'); setSelection(new Set()) }}>Delete</button>
              <button type="button" className="btn compact tk-bulk-end" onClick={endSelect}>Cancel</button>
            </div>
          ) : (
            <QuickAdd ref={quickAdd} now={now} scope={scope} ventureTags={ventureTags.map((tag) => tag.name)} onCreate={board.create} />
          )}

          {sheetNote && (
            <p className="tk-note tk-sheet-note" role="status"><Hi icon={SheetIcon} size={13} /><span>{sheetNote.text}{sheetNote.retry && <> <button type="button" className="tk-link-btn" onClick={() => void board.loadSheet(true)}>Try again</button></>}</span></p>
          )}
          {!board.loaded && <div className="tk-skeleton" aria-label="Loading tasks"><i /><i /><i /><i /></div>}
          {board.loaded && board.error && !board.todos.length && (
            <div className="tk-error" role="alert"><strong>Tasks could not load.</strong><span>{board.error}</span><button type="button" className="btn compact" onClick={() => void board.load()}>Try again</button></div>
          )}
          {board.loaded && board.error && board.todos.length > 0 && (
            <button type="button" className="tk-note error" onClick={() => void board.load()}>Tasks could not refresh: {board.error}. Try again</button>
          )}

          {board.loaded && (
            <div
              ref={grid} role="grid" aria-label="Tasks" aria-multiselectable={selectMode || undefined} className="tk-grid" onKeyDown={onGridKey}
              onFocus={() => { listFocused.current = true }}
              // Focus leaving the list (search, the pane, a menu, a click elsewhere) lets go of
              // it. A focused row that unmounts fires no blur, so that case keeps it.
              onBlur={(event) => { if (!grid.current?.contains(event.relatedTarget as Node | null)) listFocused.current = false }}
            >
              {list.sections.map((section) => (
                <div role="rowgroup" key={section.key} className={`tk-section tk-section-${section.key}`} aria-labelledby={`tk-h-${section.key}`}>
                  <div className="tk-sentinel" aria-hidden="true" />
                  <div role="row" className="tk-section-head"><span role="columnheader" id={`tk-h-${section.key}`}>{SECTION_TITLE[section.key]}<span className="tk-count">{section.items.length}</span></span></div>
                  {section.items.map((item) => drawItem(item, section.key))}
                </div>
              ))}

              {snoozed.length > 0 && (
                <div role="rowgroup" className="tk-section tk-fold" aria-labelledby="tk-h-snoozed">
                  <div className="tk-sentinel" aria-hidden="true" />
                  <div role="row" className="tk-section-head">
                    <span role="columnheader">
                      <button ref={snoozedHead} type="button" id="tk-h-snoozed" className="tk-fold-btn" aria-expanded={view.snoozedOpen} onClick={() => setView((current) => ({ ...current, snoozedOpen: !current.snoozedOpen }))}>
                        <Hi icon={ChevronDownIcon} size={12} className="tk-fold-caret" />Snoozed<span className="tk-count">{snoozed.length}</span>
                        {wakeAt && <span className="tk-fold-note">next back {wakeLabel(wakeAt, now)}</span>}
                      </button>
                    </span>
                  </div>
                  {view.snoozedOpen && snoozed.map((todo) => drawTask(todo, 'snoozed'))}
                </div>
              )}

              {completed.length > 0 && (
                <div role="rowgroup" className="tk-section tk-fold" aria-labelledby="tk-h-completed">
                  <div className="tk-sentinel" aria-hidden="true" />
                  <div role="row" className="tk-section-head">
                    <span role="columnheader">
                      <button type="button" id="tk-h-completed" className="tk-fold-btn" aria-expanded={view.completedOpen} onClick={() => setView((current) => ({ ...current, completedOpen: !current.completedOpen }))}>
                        <Hi icon={ChevronDownIcon} size={12} className="tk-fold-caret" />{completedTitle}<span className="tk-count">{completed.length}</span>
                      </button>
                    </span>
                  </div>
                  {view.completedOpen && completed.map((todo) => drawTask(todo, 'completed'))}
                </div>
              )}
            </div>
          )}

          {board.loaded && !board.error && nothing && (
            <div className="tk-empty">
              {filtering
                ? <><p>Nothing here{needle ? ` matches “${search.trim()}”` : ''}.</p><button type="button" className="btn compact" onClick={() => { setSearch(''); setView((current) => ({ ...current, scope: 'all' })) }}>Show everything</button></>
                : <p>{board.doneTodayCount ? `All clear. ${plural(board.doneTodayCount, 'task')} done today.` : 'Nothing to do. Add a task above.'}</p>}
            </div>
          )}
          {board.loaded && !nothing && !list.sections.length && !filtering && (
            <p className="tk-clear">{board.doneTodayCount ? `All clear. ${plural(board.doneTodayCount, 'task')} done today.` : 'Nothing open right now.'}</p>
          )}
        </div>

        {paneBody && (
          <aside className={`tk-pane${paneOpen ? ' open' : ''}`} aria-label="Task details">
            {paneBody}
          </aside>
        )}
      </div>

      {headMenu && <Menu anchor={headMenu} label="Tasks" items={headItems} onClose={() => setHeadMenu(null)} width={240} />}
      {rowMenu && menuTodo && rowMenu.kind === 'snooze' && (
        <SnoozeMenu anchor={rowMenu.anchor} todo={menuTodo} now={now} onClose={() => { setRowMenu(null); backToList() }}
          onSnooze={(until) => { stepOff(menuTodo.id); void board.snooze(menuTodo, until) }}
          onWake={() => void board.wake(menuTodo)} />
      )}
      {rowMenu && menuTodo && rowMenu.kind === 'due' && (
        <DueMenu anchor={rowMenu.anchor} dueDate={menuTodo.dueDate} title={menuTodo.title} idKey={menuTodo.id} now={now} onClose={() => { setRowMenu(null); backToList() }}
          onDue={(dueDate) => {
            // Rescheduled into another group: the cursor stays here, on the next row (triage).
            const today = dateKey(now)
            if (sectionFor(dueDate, today) !== sectionFor(menuTodo.dueDate, today)) { const next = nextAfter(menuTodo.id); if (next) setActiveKey(next) }
            void board.update(menuTodo, { dueDate })
          }} />
      )}
      {rowMenu && menuTodo && rowMenu.kind === 'priority' && (
        <PriorityMenu anchor={rowMenu.anchor} priority={menuTodo.priority} title={menuTodo.title} onClose={() => { setRowMenu(null); backToList() }} onPriority={(priority) => void board.update(menuTodo, { priority })} />
      )}
      {bulkMenu?.kind === 'snooze' && (
        <Menu anchor={bulkMenu.anchor} label="Snooze selected" onClose={() => setBulkMenu(null)}
          items={[{ heading: 'Snooze until' }, ...snoozeTimes(now).map((option) => ({ key: option.label, label: option.label, detail: option.detail, onSelect: () => { void board.bulk(selectedIds, 'snooze', option.value.toISOString()); setSelection(new Set()) } }))]} />
      )}
      {bulkMenu?.kind === 'priority' && (
        <Menu anchor={bulkMenu.anchor} label="Priority for selected" width={220} onClose={() => setBulkMenu(null)}
          items={[{ heading: 'Priority' }, ...PRIORITIES.map((value) => ({ key: String(value), label: priorityName(value), icon: FlagIcon, iconClass: `tk-prio-${5 - value}`, onSelect: () => { void board.bulk(selectedIds, 'priority', value); setSelection(new Set()) } }))]} />
      )}
    </div>
  )
}
