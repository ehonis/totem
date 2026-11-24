// The chats panel's task card (TaskCard.tsx) and the live link to the Tasks page:
// a change made on the card shows on the page at once, and one made on the page
// shows on the card. The bridge is a fake fetch.
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TodosView from '../components/TodosView'
import ToastHost from '../components/ToastHost'
import type { SheetFeed, Todo } from '../todos/types'
import { withSheetMark } from '../todos/board'
import TaskCardHost, { PinnedTask } from './TaskCard'
import TaskBar from './TaskBar'
import TaskBadge from './TaskBadge'
import { closeTaskCard, installTaskNav, openTaskCard } from './card'
import { createTask, loadWork } from './state'
import { getState, loadProjects } from '../chat/store'

const NOW = new Date(2026, 10, 9, 10, 0, 0)

function task(input: Partial<Todo> & Pick<Todo, 'id' | 'title'>): Todo {
  return {
    description: '', area: 'Personal', ventureTag: null, status: 'todo', priority: 1, dueDate: null, recurrence: null,
    snoozedUntil: null, position: 0, createdAt: '2026-11-01T12:00:00.000Z', updatedAt: '2026-11-01T12:00:00.000Z',
    outcome: null, completedAt: null, archivedAt: null, deletedAt: null, tags: [], notes: [], relations: [], externalLinks: [],
    lists: [], issueLink: null, folderId: null,
    syncState: { status: 'idle', pending: 0, conflicts: 0, exhausted: 0, missing: false, lastSuccessAt: null, lastError: null },
    ...input,
  }
}
const PROJECTS = [
  { id: 'acme', name: 'Acme', instructions: '', fileCount: 0, chatCount: 0, createdAt: 0, updatedAt: 0 },
  { id: 'home', name: 'Home reno', instructions: '', fileCount: 0, chatCount: 0, createdAt: 0, updatedAt: 0 },
]

let todos: Todo[]
let sheet: SheetFeed
let calls: Array<{ method: string; url: string; body: any }>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function route(url: string, method: string, body: any): Response {
  const path = url.split('?')[0]
  if (path === '/api/todos/board' && method === 'GET') return json({ todos, counts: { archived: 0, snoozed: 0, deleted: 0 } })
  if (path === '/api/todos/board' && method === 'POST') {
    const created = task({ id: `new-${todos.length}`, title: body.title, folderId: body.folderId ?? null })
    todos = [...todos, created]
    return json({ todo: created })
  }
  if (path === '/api/todos/sheet/mark' && method === 'POST') {
    sheet = withSheetMark(sheet, body.id, body.state ? { state: body.state, at: NOW.toISOString(), ...(body.until ? { until: body.until } : {}) } : null)
    return json(sheet)
  }
  if (path === '/api/todos/sheet') return json(sheet)
  if (path === '/api/todos/completed') return json({ todos: [] })
  if (path === '/api/chat/projects') return json({ projects: PROJECTS })
  const project = PROJECTS.find((p) => path === `/api/chat/projects/${p.id}`)
  if (project && method === 'GET') return json({ project: { ...project, files: [], memory: '' } })
  if (path.startsWith('/api/chat/task-folders/') && method === 'PUT') {
    const id = decodeURIComponent(path.slice('/api/chat/task-folders/'.length))
    sheet = { ...sheet, items: sheet.items.map((item) => (item.id === id ? { ...item, folderId: body.projectId } : item)) } as SheetFeed
    return json({ folders: {} })
  }
  const one = /^\/api\/todos\/([^/]+)$/.exec(path)
  if (one && method === 'PATCH') {
    const next = { ...todos.find((item) => item.id === decodeURIComponent(one[1]))!, ...body }
    todos = todos.map((item) => (item.id === next.id ? next : item))
    return json({ todo: next })
  }
  return json({ error: `unrouted ${method} ${path}` }, 404)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  todos = [task({ id: 'today', title: 'Call the bank', dueDate: '2026-11-09' }), task({ id: 'site', title: 'Fix the footer', folderId: 'acme' })]
  sheet = {
    configured: true, title: 'Team HQ', url: 'https://docs.example.test/sheet', fetchedAt: NOW.toISOString(), stale: false, error: null, defaultFolderId: 'acme',
    items: [{ id: 'sheet:0:7:abcd1234', row: 7, title: 'Order banner stands', who: 'Owner', priority: 1, status: 'In Progress', dueDate: null, notes: '', url: 'https://docs.example.test/sheet#7', folderId: 'acme', folderDefault: true }],
  }
  calls = []
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as any
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const method = (init?.method || 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    return route(url, method, body)
  })
})
afterEach(() => { act(() => closeTaskCard()); cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers() })

const sent = (method: string, path: RegExp) => calls.filter((call) => call.method === method && path.test(call.url))
const row = (title: string) => screen.getAllByRole('row').find((el) => el.dataset.row && el.getAttribute('aria-label')?.startsWith(title))!

async function mount() {
  const user = userEvent.setup()
  render(<><TodosView onAuthError={() => {}} now={() => new Date(NOW)} beatMs={0} /><TaskCardHost /><ToastHost /></>)
  await screen.findByRole('grid', { name: 'Tasks' })
  await screen.findByRole('radio', { name: /^Acme/ })
  return user
}

describe('task card', () => {
  it('edits a task’s due date and folder, and the Tasks page shows it at once', async () => {
    const user = await mount()
    act(() => openTaskCard('today'))
    const card = await screen.findByRole('dialog', { name: 'Task: Call the bank' })

    await user.click(within(card).getByRole('button', { name: /Today/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: /^Tomorrow/ }))
    await waitFor(() => expect(sent('PATCH', /\/api\/todos\/today$/)[0]?.body).toEqual({ dueDate: '2026-11-10' }))
    // The page read the board again and moved the row to Upcoming.
    await waitFor(() => expect(within(row('Call the bank')).getByText('Tomorrow')).toBeVisible())

    await user.click(within(card).getByRole('button', { name: /^Folder: Personal/ }))
    await user.click(await screen.findByRole('option', { name: /Home reno/ }))
    await waitFor(() => expect(last(sent('PATCH', /\/api\/todos\/today$/))?.body).toEqual({ folderId: 'home' }))
    await waitFor(() => expect(within(row('Call the bank')).getByText('Home reno', { selector: '.tk-mark *' })).toBeVisible())
    expect(within(card).getByRole('button', { name: /^Folder: Home reno/ })).toBeVisible()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task: Call the bank' })).toBeNull())
  })

  it('Open in Tasks goes to the Tasks page (its route is todos)', async () => {
    const navigate = vi.fn()
    const uninstall = installTaskNav({ navigate })
    const user = await mount()
    act(() => openTaskCard('today'))
    const card = await screen.findByRole('dialog', { name: 'Task: Call the bank' })
    await user.click(within(card).getByRole('button', { name: /Open in Tasks/ }))
    expect(navigate).toHaveBeenCalledWith({ tab: 'productivity', app: 'todos' })
    expect(screen.queryByRole('dialog', { name: 'Task: Call the bank' })).toBeNull()
    uninstall()
  })

  it('Esc in the folder picker closes only the picker; Esc on the card is taken from the side panels', async () => {
    const user = await mount()
    act(() => openTaskCard('today'))
    const card = await screen.findByRole('dialog', { name: 'Task: Call the bank' })
    await user.click(within(card).getByRole('button', { name: /^Folder:/ }))
    expect(await screen.findByRole('option', { name: /Home reno/ })).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('option', { name: /Home reno/ })).toBeNull())
    expect(screen.getByRole('dialog', { name: 'Task: Call the bank' })).toBeVisible()
    let prevented: boolean | null = null
    const onWindow = (e: KeyboardEvent) => { prevented = e.defaultPrevented }
    window.addEventListener('keydown', onWindow)
    await user.keyboard('{Escape}')
    window.removeEventListener('keydown', onWindow)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task: Call the bank' })).toBeNull())
    expect(prevented).toBe(true)
  })

  it('a description typed and then left by clicking the backdrop is saved', async () => {
    const user = await mount()
    act(() => openTaskCard('today'))
    const card = await screen.findByRole('dialog', { name: 'Task: Call the bank' })
    expect(card).toHaveAttribute('aria-modal', 'true')
    await user.click(within(card).getByRole('textbox', { name: 'Description' }))
    await user.keyboard('Ask about the fee')
    // A click inside the card leaves it open; the backdrop around it closes it.
    await user.click(within(card).getByText('Folder'))
    expect(screen.getByRole('dialog', { name: 'Task: Call the bank' })).toBeVisible()
    await user.pointer({ keys: '[MouseLeft]', target: card.parentElement! })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task: Call the bank' })).toBeNull())
    await waitFor(() => expect(last(sent('PATCH', /\/api\/todos\/today$/))?.body).toEqual({ description: 'Ask about the fee' }))
  })

  it('a field mid-edit is saved when the card goes away with no blur (WebKit)', async () => {
    const user = await mount()
    act(() => openTaskCard('today'))
    const card = await screen.findByRole('dialog', { name: 'Task: Call the bank' })
    const box = within(card).getByRole('textbox', { name: 'Description' })
    await user.clear(box)
    await user.keyboard('Bring the forms')
    // Unmount with focus still in the field, and no blur event on the way out.
    box.onblur = null
    const blur = vi.spyOn(HTMLElement.prototype, 'blur').mockImplementation(() => {})
    box.addEventListener('focusout', (e) => e.stopImmediatePropagation(), { capture: true })
    act(() => closeTaskCard())
    blur.mockRestore()
    await waitFor(() => expect(last(sent('PATCH', /\/api\/todos\/today$/))?.body).toEqual({ description: 'Bring the forms' }))
  })

  it('files a sheet row elsewhere, or Personal, from its card', async () => {
    const user = await mount()
    act(() => openTaskCard('sheet:0:7:abcd1234'))
    const card = await screen.findByRole('dialog', { name: 'Task: Order banner stands' })
    expect(within(card).queryByRole('textbox', { name: 'Title' })).toBeNull()
    await user.click(within(card).getByRole('button', { name: /^Folder: Acme/ }))
    await user.click(await screen.findByRole('option', { name: /Personal/ }))
    await waitFor(() => expect(sent('PUT', /\/api\/chat\/task-folders\/sheet/)[0]?.body).toEqual({ projectId: null }))
  })

  it('a task added in the chats panel appears on the Tasks page without a reload', async () => {
    await mount()
    await act(async () => { await createTask({ title: 'Measure the hall' }, 'home') })
    expect(sent('POST', /\/api\/todos\/board$/)[0]?.body).toMatchObject({ title: 'Measure the hall', folderId: 'home' })
    expect(await screen.findByText('Measure the hall')).toBeVisible()
  })
})

describe('the composer’s task strip', () => {
  it('opens the task’s card', async () => {
    const user = userEvent.setup()
    render(<><TaskBar thread={null} draftTaskId="today" projectId={null} /><TaskCardHost /></>)
    await user.click(await screen.findByRole('button', { name: /Call the bank/ }))
    expect(await screen.findByRole('dialog', { name: 'Task: Call the bank' })).toBeVisible()
  })
})

describe('a chat card’s task badge', () => {
  it('names the task and its due day, and opens its card without opening the chat', async () => {
    const user = userEvent.setup()
    const row = vi.fn()
    render(<><div onClick={row}><TaskBadge taskRef="today" /></div><TaskCardHost /></>)
    const badge = await screen.findByRole('button', { name: /^Task: Call the bank, due today\./ })
    expect(badge).toHaveTextContent('Today')
    await user.click(badge)
    expect(await screen.findByRole('dialog', { name: 'Task: Call the bank' })).toBeVisible()
    expect(row).not.toHaveBeenCalled()
  })

  it('says so when the task is gone', async () => {
    render(<TaskBadge taskRef="no-such-task" />)
    expect(await screen.findByText('Task removed')).toBeVisible()
  })
})

describe('the chat’s pinned task', () => {
  function Chat({ visible = true }: { visible?: boolean }) {
    return (
      <div className="vc">
        <PinnedTask taskRef="today" visible={visible} />
        <p>Messages</p>
        <TaskBar thread={null} draftTaskId="today" projectId={null} />
      </div>
    )
  }

  it('stays put while the page is clicked, folds, and saves from its rows', async () => {
    // jsdom lays out a 0px column, which would start it folded.
    localStorage.setItem('totem.taskPin.folded', '0')
    const user = userEvent.setup()
    render(<><Chat /><TaskCardHost /></>)
    const pin = await screen.findByRole('complementary', { name: /Call the bank/ })
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByText('Messages'))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('complementary', { name: /Call the bank/ })).toBeVisible()

    await user.click(within(pin).getByRole('button', { name: /Today/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: /^Tomorrow/ }))
    await waitFor(() => expect(sent('PATCH', /\/api\/todos\/today$/)[0]?.body).toEqual({ dueDate: '2026-11-10' }))

    await user.click(within(pin).getByRole('button', { name: 'Fold the task' }))
    expect(within(pin).queryByRole('textbox', { name: 'Description' })).toBeNull()
    expect(localStorage.getItem('totem.taskPin.folded')).toBe('1')
    await user.click(within(pin).getByRole('button', { name: 'Show the task’s settings', expanded: false }))
    expect(within(pin).getByRole('textbox', { name: 'Description' })).toBeVisible()
  })

  it('opening the chat’s own task unfolds the pinned card instead of a dialog', async () => {
    localStorage.setItem('totem.taskPin.folded', '1')
    const user = userEvent.setup()
    render(<><Chat /><TaskCardHost /></>)
    const pin = await screen.findByRole('complementary', { name: /Call the bank/ })
    expect(within(pin).queryByRole('textbox', { name: 'Description' })).toBeNull()
    await user.click(within(screen.getByRole('group', { name: 'Linked task' })).getByRole('button', { name: /Call the bank/ }))
    expect(within(pin).getByRole('textbox', { name: 'Description' })).toBeVisible()
    expect(screen.queryByRole('dialog')).toBeNull()
    // Any other task still opens as a dialog.
    act(() => openTaskCard('site'))
    expect(await screen.findByRole('dialog', { name: 'Task: Fix the footer' })).toBeVisible()
  })

  it('a chat behind another page does not catch its task: that opens as a dialog', async () => {
    render(<><Chat visible={false} /><TaskCardHost /></>)
    await screen.findByRole('complementary', { name: /Call the bank/ })
    act(() => openTaskCard('today'))
    expect(await screen.findByRole('dialog', { name: 'Task: Call the bank' })).toBeVisible()
  })
})

function last<T>(list: T[]) { return list[list.length - 1] }

