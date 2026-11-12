// The web Tasks page (#217): the grouped list from buildList with sheet rows mixed
// in, one-click complete with Undo, snooze with Undo, the inline quick-add, the
// keyboard map, the detail pane's save-on-change fields, the read-only sheet pane,
// and counts read from the board rather than the archive. The bridge is a fake
// fetch; nothing reaches the network.
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TodosView from '../components/TodosView'
import ToastHost from '../components/ToastHost'
import type { SheetFeed, Todo } from './types'

// Monday 9 November 2026, 10:00 local.
const NOW = new Date(2026, 10, 9, 10, 0, 0)
const clock = () => new Date(NOW)

function task(input: Partial<Todo> & Pick<Todo, 'id' | 'title'>): Todo {
  return {
    description: '', area: 'Personal', ventureTag: null, status: 'todo', priority: 1, dueDate: null, recurrence: null,
    snoozedUntil: null, position: 0, createdAt: '2026-11-01T12:00:00.000Z', updatedAt: '2026-11-01T12:00:00.000Z',
    outcome: null, completedAt: null, archivedAt: null, deletedAt: null, tags: [], notes: [], relations: [], externalLinks: [],
    lists: [], issueLink: null,
    syncState: { status: 'idle', pending: 0, conflicts: 0, exhausted: 0, missing: false, lastSuccessAt: null, lastError: null },
    ...input,
  }
}

const SHEET: SheetFeed = {
  configured: true, title: 'Team HQ', url: 'https://docs.example.test/sheet', fetchedAt: NOW.toISOString(), stale: false, error: null,
  items: [{ id: 'sheet:0:7:abcd1234', row: 7, title: 'Order banner stands', who: 'Owner', priority: 1, status: 'In Progress', dueDate: '2026-11-09', notes: 'Two of them', url: 'https://docs.example.test/sheet#gid=0&range=B7' }],
}

interface Fake { todos: Todo[]; sheet: SheetFeed; counts?: { archived: number; snoozed: number; deleted: number }; archived?: Todo[]; sheetFails?: boolean; recent?: Array<{ id: string; completedAt: string; outcome: string }> }
let fake: Fake
let calls: Array<{ method: string; url: string; body: any }>

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function route(url: string, method: string, body: any): Response {
  const path = url.split('?')[0]
  if (path === '/api/todos/board' && method === 'GET' && url.includes('archived=true')) return json({ todos: fake.archived ?? [], counts: fake.counts })
  if (path === '/api/todos/board' && method === 'GET') return json({ todos: fake.todos, counts: fake.counts ?? { archived: 0, snoozed: 0, deleted: 0 } })
  if (path === '/api/todos/board' && method === 'POST') {
    const created = task({ id: 'new-1', title: body.title, dueDate: body.dueDate ?? null, priority: body.priority ?? 1, area: body.area ?? 'Personal', ventureTag: body.ventureTag ?? null })
    fake.todos = [...fake.todos, created]
    return json({ todo: created })
  }
  if (path === '/api/todos/bulk' && method === 'POST') {
    // Completing rolls a dated repeating task's next occurrence, as the bridge does.
    const status = body.operation === 'complete' ? 'done' : body.operation === 'move' ? body.value : null
    const changed: Todo[] = []
    for (const id of body.ids as string[]) {
      const todo = fake.todos.find((item) => item.id === id)!
      const next = status ? { ...todo, status, completedAt: status === 'done' ? NOW.toISOString() : null, outcome: status === 'done' ? 'completed' as const : null } : todo
      fake.todos = fake.todos.map((item) => (item.id === id ? next : item))
      changed.push(next)
      if (status === 'done' && todo.recurrence && todo.dueDate) fake.todos = [...fake.todos, task({ id: `${id}-next`, title: todo.title, recurrence: todo.recurrence, dueDate: '2026-11-17' })]
    }
    return json({ todos: changed })
  }
  if (path === '/api/todos/sheet') return fake.sheetFails ? json({ error: 'Drive said no' }, 500) : json(fake.sheet)
  if (path === '/api/todos/completed') return json({ todos: fake.recent ?? [] })
  const note = /^\/api\/todos\/([^/]+)\/notes$/.exec(path)
  if (note) return json({ note: { id: 'n-new', body: body.body, createdAt: NOW.toISOString() } })
  if (path === '/api/todos/venture-tags') return json({ ventureTags: [{ name: 'Acme', color: null }] })
  if (path === '/api/todos/issue-states') return json({ fetchedAt: NOW.toISOString(), states: { 'acme/app#12': { state: 'open', title: 'Crash on save', url: 'https://github.com/acme/app/issues/12' } } })
  const move = /^\/api\/todos\/([^/]+)\/move$/.exec(path)
  if (move) {
    const todo = fake.todos.find((item) => item.id === decodeURIComponent(move[1]))!
    const next = { ...todo, status: body.status, outcome: body.status === 'done' ? (body.outcome ?? 'completed') : null, completedAt: body.status === 'done' ? NOW.toISOString() : null }
    fake.todos = fake.todos.map((item) => (item.id === next.id ? next : item))
    return json({ todo: next })
  }
  const one = /^\/api\/todos\/([^/]+)$/.exec(path)
  if (one && method === 'PATCH' && body.priority === 2) return json({ error: 'Priority is locked on this task.' }, 422)
  if (one && method === 'PATCH') {
    const todo = fake.todos.find((item) => item.id === decodeURIComponent(one[1]))!
    const next = { ...todo, ...body }
    fake.todos = fake.todos.map((item) => (item.id === next.id ? next : item))
    return json({ todo: next })
  }
  return json({ error: `unrouted ${method} ${path}` }, 404)
}

beforeEach(() => {
  calls = []
  // The toast deck measures itself.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as any
  // A wide desktop: the pane sits beside the list.
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const method = (init?.method || 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    return route(url, method, body)
  })
})

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

const sent = (method: string, path: RegExp) => calls.filter((call) => call.method === method && path.test(call.url))
const last = <T,>(list: T[]) => list[list.length - 1]

async function mount(todos: Todo[], extra: Partial<Fake> = {}) {
  fake = { todos, sheet: SHEET, ...extra }
  const user = userEvent.setup()
  render(<><TodosView onAuthError={() => {}} now={clock} beatMs={0} /><ToastHost /></>)
  await screen.findByRole('grid', { name: 'Tasks' })
  await screen.findAllByRole('row')
  return user
}

const row = (name: RegExp | string) => screen.getAllByRole('row').find((el) => el.dataset.row && (typeof name === 'string' ? el.getAttribute('aria-label')?.startsWith(name) : name.test(el.getAttribute('aria-label') ?? '')))!

const BOARD = () => [
  task({ id: 'late', title: 'Pay the invoice', dueDate: '2026-11-05', priority: 4 }),
  task({ id: 'today', title: 'Call the bank', dueDate: '2026-11-09' }),
  task({ id: 'soon', title: 'Book flights', dueDate: '2026-11-10', recurrence: 'weekly' }),
  task({ id: 'whenever', title: 'Sort the garage', area: 'Ventures', ventureTag: 'Acme', issueLink: { connector: 'github', repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/issues/12' } }),
  task({ id: 'asleep', title: 'Renew passport', snoozedUntil: '2026-11-10T09:00:00.000Z' }),
  task({ id: 'finished', title: 'Water plants', status: 'done', outcome: 'completed', completedAt: '2026-11-09T08:00:00.000Z' }),
]

describe('Tasks page', () => {
  it('draws buildList’s groups with the sheet’s rows mixed in, and marks only what says something', async () => {
    await mount(BOARD())
    const heads = screen.getAllByRole('columnheader').map((el) => el.textContent)
    expect(heads.slice(0, 4)).toEqual(['Overdue1', 'Today2', 'Upcoming1', 'No date1'])
    // Snoozed and Completed are folded at the foot.
    expect(screen.getByRole('button', { name: /Snoozed/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /Completed today/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Renew passport')).toBeNull()

    // A sheet row sits in Today with the feed's name and no check circle.
    const sheetRow = row('Order banner stands')
    // Named by the icon's tooltip, not repeated as text on every row.
    expect(within(sheetRow).getByTitle('Team HQ (read-only)')).toBeVisible()
    expect(within(sheetRow).queryByText('Team HQ')).toBeNull()
    expect(within(sheetRow).queryByText(/in progress/i)).toBeNull()
    // Its flag is coloured by meaning: the sheet's High is a task's P2 (amber), never P1 red.
    expect(within(sheetRow).getByText('High').closest('.tk-prio')).toHaveClass('tk-prio-2')
    expect(within(sheetRow).queryByRole('checkbox')).toBeNull()
    // Today's group already says "Today"; the overdue row shows its date, not "Overdue".
    expect(within(row('Call the bank')).queryByText('Today')).toBeNull()
    expect(within(row('Pay the invoice')).getByText('Nov 5')).toBeVisible()
    expect(within(row('Pay the invoice')).getByText('P1')).toBeVisible()
    expect(within(row('Book flights')).getByText('Tomorrow')).toBeVisible()
    // No P4 flag, no "Personal" on every row.
    expect(within(row('Call the bank')).queryByText(/^P\d$/)).toBeNull()
    expect(screen.queryByText('Personal', { selector: '.tk-mark, .tk-mark *' })).toBeNull()
    // The issue link carries its live state.
    await waitFor(() => expect(within(row('Sort the garage')).getByRole('link', { name: /#12/ })).toHaveClass('open'))
    // The live line counts the sheet's row too.
    expect(screen.getByText('1 overdue · 2 today · 1 done today')).toBeVisible()
  })

  it('completes in one click and puts the task back on Undo', async () => {
    const user = await mount(BOARD())
    await user.click(within(row('Call the bank')).getByRole('checkbox', { name: 'Complete Call the bank' }))
    await waitFor(() => expect(sent('POST', /\/api\/todos\/today\/move$/)[0]?.body).toEqual({ status: 'done' }))
    await waitFor(() => expect(screen.queryByText('Call the bank')).toBeNull())
    await user.click(await screen.findByRole('button', { name: /Undo/ }))
    await waitFor(() => expect(last(sent('POST', /\/api\/todos\/today\/move$/))?.body).toEqual({ status: 'todo' }))
    expect(await screen.findByText('Call the bank')).toBeVisible()
  })

  it('snoozes from the keyboard and wakes the task again on Undo', async () => {
    const user = await mount(BOARD())
    row('Call the bank').focus()
    await user.keyboard('s')
    const menu = await screen.findByRole('menu', { name: 'Snooze Call the bank' })
    await user.click(within(menu).getByRole('menuitem', { name: /^Tomorrow/ }))
    await waitFor(() => expect(sent('PATCH', /\/api\/todos\/today$/)[0]?.body.snoozedUntil).toBe(new Date(2026, 10, 10, 9, 0, 0).toISOString()))
    await waitFor(() => expect(screen.queryByText('Call the bank')).toBeNull())
    await user.click(await screen.findByRole('button', { name: /Undo/ }))
    await waitFor(() => expect(last(sent('PATCH', /\/api\/todos\/today$/))?.body).toEqual({ snoozedUntil: null }))
    expect(await screen.findByText('Call the bank')).toBeVisible()
    // Undoing a snooze only wakes it: no "moved to To do" for a task that never moved.
    expect(sent('POST', /\/move$/)).toHaveLength(0)
  })

  it('adds from the quick-add line through the canonical route, reveals the row and keeps focus', async () => {
    const user = await mount(BOARD())
    await user.keyboard('n')
    const input = screen.getByRole('textbox', { name: 'Add a task' })
    expect(input).toHaveFocus()
    await user.type(input, 'Renew registration tomorrow p2')
    expect(screen.getByText('Tomorrow', { selector: '.tk-chip' })).toBeVisible()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)[0]?.body).toMatchObject({ title: 'Renew registration', dueDate: '2026-11-10', priority: 3, area: 'Personal' }))
    const added = await waitFor(() => row('Renew registration'))
    expect(added).toHaveClass('active')
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
  })

  it('keeps words typed while a quick-add is still being created', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const user = await mount(BOARD())
    const plain = (globalThis.fetch as any).getMockImplementation()
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const response = plain(input, init)
      if (String(input).startsWith('/api/todos/board') && (init?.method || 'GET').toUpperCase() === 'POST') await held
      return response
    })
    const input = screen.getByRole('textbox', { name: 'Add a task' })
    await user.type(input, 'Renew registration')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)).toHaveLength(1))
    // The create is out; the next task is being typed.
    await user.type(input, ' Pay the parking fine')
    release()
    await waitFor(() => row('Renew registration'))
    // What was sent comes off the front; the words typed since stay, for the next task.
    await waitFor(() => expect(input).toHaveValue('Pay the parking fine'))
  })

  it('leaves the line alone when it was edited some other way during the create', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const user = await mount(BOARD())
    const plain = (globalThis.fetch as any).getMockImplementation()
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const response = plain(input, init)
      if (String(input).startsWith('/api/todos/board') && (init?.method || 'GET').toUpperCase() === 'POST') await held
      return response
    })
    const input = screen.getByRole('textbox', { name: 'Add a task' })
    await user.type(input, 'Renew registration')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)).toHaveLength(1))
    await user.clear(input)
    await user.type(input, 'Something else')
    release()
    await waitFor(() => row('Renew registration'))
    expect(input).toHaveValue('Something else')
  })

  it('toggles the Snoozed and Completed folds with Space and Enter, and sends no move for the cursor’s task', async () => {
    const user = await mount(BOARD())
    row('Call the bank').focus()
    for (const name of [/Snoozed/, /Completed/]) {
      const head = screen.getByRole('button', { name })
      head.focus()
      await user.keyboard(' ')
      expect(head).toHaveAttribute('aria-expanded', 'true')
      await user.keyboard('{Enter}')
      expect(head).toHaveAttribute('aria-expanded', 'false')
      expect(head).toHaveFocus()
    }
    expect(sent('POST', /\/move$/)).toHaveLength(0)
    // No pane opened for the row under the cursor either.
    expect(screen.queryByRole('region', { name: /^Task: / })).toBeNull()
  })

  it('keeps the keys working from a control inside a row: j from the select box moves the cursor', async () => {
    const user = await mount(BOARD(), { sheet: { ...SHEET, items: [] } as SheetFeed })
    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.click(await screen.findByRole('menuitem', { name: /Select tasks/ }))
    within(row('Call the bank')).getByRole('checkbox', { name: 'Select Call the bank' }).focus()
    await user.keyboard('j')
    expect(row('Book flights')).toHaveFocus()
    // Space on the box is the box's own: it selects the row, once.
    within(row('Book flights')).getByRole('checkbox', { name: 'Select Book flights' }).focus()
    await user.keyboard(' ')
    expect(within(row('Book flights')).getByRole('checkbox', { name: 'Select Book flights' })).toBeChecked()
    expect(screen.getByText('1 task selected')).toBeVisible()
  })

  it('leaves the open pane on its task when another row is snoozed from its hover tools', async () => {
    const user = await mount(BOARD(), { sheet: { ...SHEET, items: [] } as SheetFeed })
    await user.click(row('Call the bank'))
    expect(await screen.findByRole('region', { name: 'Task: Call the bank' })).toBeVisible()
    await user.click(within(row('Book flights')).getByRole('button', { name: 'Snooze Book flights' }))
    await user.click(within(await screen.findByRole('menu', { name: 'Snooze Book flights' })).getByRole('menuitem', { name: /^Tomorrow/ }))
    await waitFor(() => expect(screen.queryByText('Book flights')).toBeNull())
    expect(screen.getByRole('region', { name: 'Task: Call the bank' })).toBeVisible()
    // The toast store outlives the page: take this test's Undo toast away.
    await user.click(await screen.findByRole('button', { name: 'Dismiss notification' }))
  })

  it('bulk Done never reopens a task that was already finished', async () => {
    const user = await mount(BOARD(), { sheet: { ...SHEET, items: [] } as SheetFeed })
    await user.click(screen.getByRole('button', { name: /Completed/ }))
    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.click(await screen.findByRole('menuitem', { name: /Select tasks/ }))
    await user.click(row('Call the bank'))
    await user.click(row('Water plants'))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(sent('POST', /\/api\/todos\/bulk$/)).toHaveLength(1))
    expect(await screen.findByText('Done: 2 tasks')).toBeVisible()
    await user.click(await screen.findByRole('button', { name: /Undo/ }))
    await waitFor(() => expect(sent('POST', /\/api\/todos\/bulk$/)).toHaveLength(2))
    expect(last(sent('POST', /\/api\/todos\/bulk$/))?.body).toEqual({ ids: ['today'], operation: 'move', value: 'todo' })
  })

  it('bulk Done with a weekly task: Undo reopens only the others, and says the repeat rolled', async () => {
    const user = await mount(BOARD(), { sheet: { ...SHEET, items: [] } as SheetFeed })
    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.click(await screen.findByRole('menuitem', { name: /Select tasks/ }))
    await user.click(row('Call the bank'))
    await user.click(row('Book flights'))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(sent('POST', /\/api\/todos\/bulk$/)[0]?.body).toMatchObject({ ids: ['today', 'soon'], operation: 'complete' }))
    expect(await screen.findByText(/Done: 2 tasks; 1 repeating task rolled to its next date/)).toBeVisible()
    await user.click(await screen.findByRole('button', { name: /Undo/ }))
    await waitFor(() => expect(sent('POST', /\/api\/todos\/bulk$/)).toHaveLength(2))
    // Only the plain task is reopened: the weekly one's next occurrence already exists.
    expect(last(sent('POST', /\/api\/todos\/bulk$/))?.body).toEqual({ ids: ['today'], operation: 'move', value: 'todo' })
    await waitFor(() => expect(screen.getAllByText('Book flights')).toHaveLength(1))
  })

  it('offers no Undo after finishing an issue-linked weekly task, and draws its next occurrence', async () => {
    const board = BOARD().map((item) => (item.id === 'soon' ? { ...item, externalLinks: [{ id: 'l1', connector: 'github', externalId: 'acme/app#3', externalUrl: 'https://github.com/acme/app/issues/3', sourceStatus: null, sourceSnapshot: null, lastSyncSnapshot: null, initialStatusSeeded: false } as any], issueLink: { connector: 'github' as const, repo: 'acme/app', number: 3, url: 'https://github.com/acme/app/issues/3' } } : item))
    const user = await mount(board)
    let rolled = false
    const plain = (globalThis.fetch as any).getMockImplementation()
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const response = await plain(input, init)
      if (/\/api\/todos\/soon\/move$/.test(String(input)) && !rolled) { rolled = true; fake.todos = [...fake.todos, task({ id: 'soon-next', title: 'Book flights', recurrence: 'weekly', dueDate: '2026-11-17' })] }
      return response
    })
    await user.click(within(row('Book flights')).getByRole('checkbox', { name: 'Complete Book flights' }))
    expect(await screen.findByText(/The next “Book flights” is due/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull()
    expect(row('Book flights')?.dataset.row).toBe('soon-next')
  })

  it('walks the list with j/k, opens with Enter, closes with Esc, completes with x, searches with /', async () => {
    const user = await mount(BOARD())
    row('Pay the invoice').focus()
    // Inside Today the High sheet row ranks above a task with no priority (buildList).
    await user.keyboard('j')
    expect(row('Order banner stands')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(row('Call the bank')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('region', { name: 'Task: Call the bank' })).toBeVisible()
    // The pane follows the cursor, onto the sheet row and back up to the overdue task.
    await user.keyboard('k')
    expect(await screen.findByRole('region', { name: 'Team HQ: Order banner stands' })).toBeVisible()
    await user.keyboard('k')
    expect(await screen.findByRole('region', { name: 'Task: Pay the invoice' })).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('region', { name: /^Task:/ })).toBeNull())
    // Nothing selected: the pane is today's summary.
    expect(screen.getByRole('region', { name: 'Today' })).toBeVisible()
    expect(row('Pay the invoice')).toHaveFocus()
    await user.keyboard('p')
    expect(await screen.findByRole('menu', { name: 'Priority for Pay the invoice' })).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(row('Pay the invoice')).toHaveFocus())
    await user.keyboard('x')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/late\/move$/)[0]?.body).toEqual({ status: 'done' }))
    await user.keyboard('/')
    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveFocus()
  })

  it('saves each pane field as it changes, with no Save button', async () => {
    const user = await mount(BOARD())
    await user.click(screen.getByText('Book flights'))
    const pane = await screen.findByRole('region', { name: 'Task: Book flights' })
    expect(within(pane).queryByRole('button', { name: /save/i })).toBeNull()
    await user.click(within(pane).getByRole('radio', { name: 'P2' }))
    await waitFor(() => expect(sent('PATCH', /\/api\/todos\/soon$/)[0]?.body).toEqual({ priority: 3 }))
    const title = within(pane).getByRole('textbox', { name: 'Title' })
    await user.clear(title)
    await user.type(title, 'Book flights home{Enter}')
    await waitFor(() => expect(last(sent('PATCH', /\/api\/todos\/soon$/))?.body).toEqual({ title: 'Book flights home' }))
    await user.click(within(screen.getByRole('region', { name: 'Task: Book flights home' })).getByRole('button', { name: 'Repeat: every week' }))
    await user.click(within(await screen.findByRole('menu', { name: /^Repeat/ })).getByRole('menuitemradio', { name: 'Every month' }))
    await waitFor(() => expect(last(sent('PATCH', /\/api\/todos\/soon$/))?.body).toEqual({ recurrence: 'monthly' }))
  })

  it('opens a sheet row read-only, with Open in sheet', async () => {
    const user = await mount(BOARD())
    row('Order banner stands').focus()
    await user.keyboard('{Enter}')
    const pane = await screen.findByRole('region', { name: 'Team HQ: Order banner stands' })
    expect(within(pane).getByRole('link', { name: /Open in sheet/ })).toHaveAttribute('href', SHEET.items[0].url)
    expect(within(pane).queryByRole('textbox')).toBeNull()
    expect(within(pane).queryByRole('checkbox')).toBeNull()
    // x does nothing to a row Totem cannot change.
    row('Order banner stands').focus()
    await user.keyboard('x')
    expect(sent('POST', /move$/)).toHaveLength(0)
  })

  it('takes the archive and bin counts from the board, never downloading the archive to count it', async () => {
    const user = await mount(BOARD(), { counts: { archived: 158, snoozed: 1, deleted: 4 } })
    await user.click(screen.getByRole('button', { name: 'More' }))
    const menu = await screen.findByRole('menu', { name: 'Tasks' })
    expect(within(menu).getByRole('menuitem', { name: /Archive\s*158/ })).toBeVisible()
    expect(within(menu).getByRole('menuitem', { name: /Recycle bin\s*4/ })).toBeVisible()
    expect(within(menu).getByRole('menuitem', { name: /Snoozed\s*1/ })).toBeVisible()
    expect(calls.some((call) => /archived=true|deleted=true/.test(call.url))).toBe(false)
  })

  it('says when the sheet is not set up, apart from when nothing is assigned', async () => {
    const user = await mount(BOARD(), { sheet: { ...SHEET, items: [] } as SheetFeed })
    await user.click(screen.getByRole('radio', { name: /Team HQ/ }))
    expect(await screen.findByText('Nothing in Team HQ is assigned to you.')).toBeVisible()
    cleanup()
    await mount(BOARD(), { sheet: { configured: false, items: [], reason: 'Set TASK_SHEET_ID.' } })
    expect(screen.queryByRole('radio', { name: /Task sheet/ })).toBeNull()
  })

  // Round 1 (#226): each of these failed against the first version of the page.

  it('keeps the keyboard in the list after x: x x x walks three rows, and j carries on from there', async () => {
    const user = await mount(BOARD(), { sheet: { ...SHEET, items: [] } as SheetFeed })
    row('Pay the invoice').focus()
    await user.keyboard('x')
    expect(row('Call the bank')).toHaveFocus()
    await user.keyboard('x')
    expect(row('Book flights')).toHaveFocus()
    await user.keyboard('x')
    await waitFor(() => expect(sent('POST', /\/move$/)).toHaveLength(3))
    expect(sent('POST', /\/move$/).map((call) => call.url.split('/')[3])).toEqual(['late', 'today', 'soon'])
    // The finished rows have left; the cursor is still where the list is being worked.
    await waitFor(() => expect(screen.queryByText('Pay the invoice')).toBeNull())
    await waitFor(() => expect(row('Sort the garage')).toHaveFocus())
    await user.keyboard('k')
    expect(row('Sort the garage')).toHaveFocus()
  })

  it('keeps focus in the list after snoozing from the keyboard', async () => {
    const user = await mount(BOARD(), { sheet: { ...SHEET, items: [] } as SheetFeed })
    row('Call the bank').focus()
    await user.keyboard('s')
    await user.click(within(await screen.findByRole('menu', { name: 'Snooze Call the bank' })).getByRole('menuitem', { name: /^Tomorrow/ }))
    await waitFor(() => expect(screen.queryByText('Call the bank')).toBeNull())
    await waitFor(() => expect(row('Book flights')).toHaveFocus())
    await user.keyboard('x')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/soon\/move$/)).toHaveLength(1))
  })

  it('scrolls to a new task and its flash wears off', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    try {
      const user = await mount(BOARD())
      await user.click(screen.getByRole('textbox', { name: 'Add a task' }))
      await user.keyboard('Plan the offsite in 2 weeks{Enter}')
      const added = await waitFor(() => row('Plan the offsite'))
      await waitFor(() => expect(scroll.mock.contexts).toContain(added))
      expect(added).toHaveClass('flash')
      await waitFor(() => expect(row('Plan the offsite')).not.toHaveClass('flash'), { timeout: 3000 })
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })

  it('Esc in the title puts the old title back and saves nothing', async () => {
    const user = await mount(BOARD())
    await user.click(screen.getByText('Book flights'))
    const pane = await screen.findByRole('region', { name: 'Task: Book flights' })
    const title = within(pane).getByRole('textbox', { name: 'Title' })
    await user.click(title)
    await user.keyboard(' XXX')
    await user.keyboard('{Escape}')
    expect(title).toHaveValue('Book flights')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent('PATCH', /\/api\/todos\/soon$/)).toHaveLength(0)
    // The pane is still open: the first Esc belonged to the field.
    expect(screen.getByRole('region', { name: 'Task: Book flights' })).toBeVisible()
  })

  it('opens an archived task read-only from the archive, with Unarchive', async () => {
    const old = task({ id: 'old', title: 'File the taxes', status: 'done', outcome: 'completed', completedAt: '2026-11-02T15:00:00.000Z', archivedAt: '2026-11-02T18:00:00.000Z' })
    const user = await mount(BOARD(), { counts: { archived: 1, snoozed: 1, deleted: 0 }, archived: [old] })
    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.click(within(await screen.findByRole('menu', { name: 'Tasks' })).getByRole('menuitem', { name: /Archive/ }))
    await user.click(await screen.findByRole('button', { name: 'File the taxes' }))
    const pane = await screen.findByRole('region', { name: 'Archive: File the taxes' })
    expect(within(pane).getByRole('button', { name: 'Unarchive' })).toBeVisible()
    expect(within(pane).queryByRole('textbox')).toBeNull()
    await user.click(within(pane).getByRole('button', { name: 'Back to the archive' }))
    expect(await screen.findByRole('region', { name: 'Archive' })).toBeVisible()
  })

  it('keeps an unsent note when you switch tasks and come back', async () => {
    const user = await mount(BOARD())
    await user.click(screen.getByText('Call the bank'))
    await user.type(within(await screen.findByRole('region', { name: 'Task: Call the bank' })).getByRole('textbox', { name: 'New note' }), 'half a thought')
    await user.click(screen.getByText('Book flights'))
    await screen.findByRole('region', { name: 'Task: Book flights' })
    expect(within(screen.getByRole('region', { name: 'Task: Book flights' })).getByRole('textbox', { name: 'New note' })).toHaveValue('')
    await user.click(screen.getByText('Call the bank'))
    expect(within(await screen.findByRole('region', { name: 'Task: Call the bank' })).getByRole('textbox', { name: 'New note' })).toHaveValue('half a thought')
  })

  it('n is always New task; m puts the cursor in the note composer, every time', async () => {
    const user = await mount(BOARD())
    row('Call the bank').focus()
    await user.keyboard('n')
    expect(screen.getByRole('textbox', { name: 'Add a task' })).toHaveFocus()
    row('Call the bank').focus()
    await user.keyboard('m')
    const composer = within(await screen.findByRole('region', { name: 'Task: Call the bank' })).getByRole('textbox', { name: 'New note' })
    await waitFor(() => expect(composer).toHaveFocus())
    row('Call the bank').focus()
    await user.keyboard('m')
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Task: Call the bank' })).getByRole('textbox', { name: 'New note' })).toHaveFocus())
  })

  it('says, in All, when the sheet could not be read, and reads it again on Try again', async () => {
    const user = await mount(BOARD(), { sheetFails: true })
    expect(await screen.findByText(/could not be read, so its rows are missing/)).toBeVisible()
    fake.sheetFails = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Order banner stands')).toBeVisible()
    await waitFor(() => expect(screen.queryByText(/could not be read/)).toBeNull())
    expect(calls.some((call) => call.url.includes('/api/todos/sheet?refresh=1'))).toBe(true)
  })

  it('says when the rows shown are stale', async () => {
    await mount(BOARD(), { sheet: { ...SHEET, stale: true, error: 'Rate limited' } as SheetFeed })
    expect(await screen.findByText(/Team HQ: showing rows read at .*; the last read failed\./)).toBeVisible()
  })

  it('keeps drawing the rows it has when a later sheet read fails, and says they are old rather than missing', async () => {
    const user = await mount(BOARD())
    expect(await screen.findByText('Order banner stands')).toBeVisible()
    fake.sheetFails = true
    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.click(await screen.findByRole('menuitem', { name: /Read Team HQ again/ }))
    expect(await screen.findByText(/Team HQ: showing rows read at .*; the last read failed/)).toBeVisible()
    expect(screen.queryByText(/rows are missing/)).toBeNull()
    expect(screen.getByText('Order banner stands')).toBeVisible()
  })

  it('lets the open pane follow the cursor when x finishes its task', async () => {
    const user = await mount(BOARD(), { sheet: { ...SHEET, items: [] } as SheetFeed })
    row('Call the bank').focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('region', { name: 'Task: Call the bank' })).toBeVisible()
    row('Call the bank').focus()
    await user.keyboard('x')
    expect(await screen.findByRole('region', { name: 'Task: Book flights' })).toBeVisible()
  })

  it('keeps editing the title when Enter only picks an input method’s candidate', async () => {
    const user = await mount(BOARD())
    await user.click(row('Call the bank'))
    const title = await screen.findByRole('textbox', { name: 'Title' })
    title.focus()
    fireEvent.keyDown(title, { key: 'Enter', isComposing: true })
    expect(title).toHaveFocus()
    fireEvent.keyDown(title, { key: 'Enter' })
    expect(title).not.toHaveFocus()
  })

  it('adds a Ventures task from the Ventures scope and stays there', async () => {
    const user = await mount(BOARD())
    await user.click(screen.getByRole('radio', { name: /Ventures/ }))
    await user.click(screen.getByRole('textbox', { name: 'Add a task' }))
    await user.keyboard('Draft the pitch{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)[0]?.body).toMatchObject({ title: 'Draft the pitch', area: 'Ventures', ventureTag: 'Acme' }))
    expect(await screen.findByText('Draft the pitch')).toBeVisible()
    expect(screen.getByRole('radio', { name: /Ventures/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('puts back only the refused field, and names it', async () => {
    const user = await mount(BOARD())
    await user.click(screen.getByText('Book flights'))
    const pane = await screen.findByRole('region', { name: 'Task: Book flights' })
    const title = within(pane).getByRole('textbox', { name: 'Title' })
    await user.clear(title)
    await user.type(title, 'Book flights home{Enter}')
    await waitFor(() => expect(sent('PATCH', /\/api\/todos\/soon$/)).toHaveLength(1))
    await user.click(within(screen.getByRole('region', { name: 'Task: Book flights home' })).getByRole('radio', { name: 'P3' }))
    expect(await screen.findByText(/The priority was not saved: Priority is locked on this task\./)).toBeVisible()
    const after = screen.getByRole('region', { name: 'Task: Book flights home' })
    expect(within(after).getByRole('radio', { name: 'None' })).toHaveAttribute('aria-checked', 'true')
    expect(within(after).getByRole('textbox', { name: 'Title' })).toHaveValue('Book flights home')
  })

  it('counts work filed away today as done, but not what was marked not doing', async () => {
    await mount(BOARD(), {
      recent: [
        { id: 'filed', completedAt: '2026-11-09T09:00:00.000Z', outcome: 'completed' },
        { id: 'dropped', completedAt: '2026-11-09T09:30:00.000Z', outcome: 'not_doing' },
      ],
    })
    // "Water plants" on the board plus the archived "filed"; "dropped" was not doing.
    expect(await screen.findByText('1 overdue · 2 today · 2 done today')).toBeVisible()
  })
})
