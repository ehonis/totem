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
import TasksPanel from './TasksPanel'
import { closeTaskCard, installTaskNav, openTaskCard } from './card'
import { createTask, loadWork } from './state'
import { loadProjects } from '../chat/store'

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
  it('opens the task’s card and turns the chats panel to Tasks (it used to only do the latter)', async () => {
    const user = userEvent.setup()
    const modes: string[] = []
    const onMode = (e: Event) => modes.push((e as CustomEvent).detail)
    window.addEventListener('totem:panel-mode', onMode)
    const shown = vi.fn()
    render(<><TaskBar thread={null} draftTaskId="today" projectId={null} onShowPanel={shown} /><TaskCardHost /></>)
    await user.click(await screen.findByRole('button', { name: /Call the bank/ }))
    expect(await screen.findByRole('dialog', { name: 'Task: Call the bank' })).toBeVisible()
    expect(modes).toEqual(['tasks'])
    expect(shown).toHaveBeenCalled()
    window.removeEventListener('totem:panel-mode', onMode)
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

describe('the chats panel’s task rows', () => {
  it('snooze a task from its row in one click, with Undo', async () => {
    const user = userEvent.setup()
    render(<><TasksPanel onOpenChat={() => {}} /><ToastHost /></>)
    await user.click(await screen.findByRole('button', { name: 'Snooze “Call the bank”' }))
    await user.click(await screen.findByRole('menuitem', { name: /Tomorrow/ }))
    const tomorrow = new Date(2026, 10, 10, 9, 0, 0).toISOString()
    await waitFor(() => expect(sent('PATCH', /\/api\/todos\/today$/)[0]?.body).toEqual({ snoozedUntil: tomorrow }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Snooze “Call the bank”' })).toBeNull())
    expect(screen.queryByRole('menu')).toBeNull()
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(sent('PATCH', /\/api\/todos\/today$/)[1]?.body).toEqual({ snoozedUntil: null }))
  })

  it('snoozes or marks a sheet row done for the owner only; the sheet is never written', async () => {
    const user = userEvent.setup()
    render(<><TasksPanel onOpenChat={() => {}} /><ToastHost /></>)
    await user.click(await screen.findByRole('button', { name: 'Snooze “Order banner stands”' }))
    await user.click(await screen.findByRole('menuitem', { name: /Tomorrow/ }))
    const tomorrow = new Date(2026, 10, 10, 9, 0, 0).toISOString()
    await waitFor(() => expect(sent('POST', /\/api\/todos\/sheet\/mark$/)[0]?.body).toEqual({ id: 'sheet:0:7:abcd1234', state: 'snoozed', until: tomorrow }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Snooze “Order banner stands”' })).toBeNull())
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(sent('POST', /\/api\/todos\/sheet\/mark$/)[1]?.body).toEqual({ id: 'sheet:0:7:abcd1234', state: null }))
    await user.click(await screen.findByRole('button', { name: 'Mark “Order banner stands” done for you (the sheet is unchanged)' }))
    await waitFor(() => expect(sent('POST', /\/api\/todos\/sheet\/mark$/)[2]?.body).toEqual({ id: 'sheet:0:7:abcd1234', state: 'done' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Order banner stands/ })).toBeNull())
    expect(sent('PUT', /task-folders/)).toHaveLength(0)
  })
})

describe('the chats panel’s add line', () => {
  async function mountPanel() {
    const user = userEvent.setup()
    await act(async () => { await loadProjects(); await loadWork() })
    render(<><TasksPanel onOpenChat={() => {}} /><ToastHost /></>)
    await screen.findByRole('button', { name: 'Snooze “Call the bank”' })
    return user
  }
  const addLine = () => screen.getByRole('textbox', { name: 'Add a task…' })
  const folderButton = () => screen.getByRole('button', { name: /^Folder: / })

  it('files a new task in any folder, even one with no tasks (and so no group) yet, and keeps it for the next', async () => {
    const user = await mountPanel()
    expect(folderButton()).toHaveAccessibleName('Folder: Personal. Change')
    // Home reno has no open task, so it has no group and no + to add from.
    expect(screen.queryByRole('button', { name: 'Add a task to Home reno' })).toBeNull()
    await user.click(folderButton())
    await user.click(await screen.findByRole('option', { name: /Home reno/ }))
    expect(folderButton()).toHaveAccessibleName('Folder: Home reno. Change')
    expect(addLine()).toHaveFocus()
    await user.type(addLine(), 'Measure the hall tomorrow{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)[0]?.body).toEqual({ title: 'Measure the hall', dueDate: '2026-11-10', folderId: 'home' }))
    expect(await screen.findByRole('button', { name: 'Add a task to Home reno' })).toBeVisible()
    expect(addLine()).toHaveValue('')
    expect(addLine()).toHaveFocus()
    // The next task goes there too, and so does the next visit.
    await user.type(addLine(), 'Buy paint{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)[1]?.body).toEqual({ title: 'Buy paint', folderId: 'home' }))
    cleanup()
    await mountPanel()
    expect(folderButton()).toHaveAccessibleName('Folder: Home reno. Change')
  })

  it('a #folder typed in the title wins for that task, until the button is used again', async () => {
    const user = await mountPanel()
    await user.type(addLine(), 'Send the invoice #acme')
    expect(folderButton()).toHaveAccessibleName('Folder: Acme, from the title. Change')
    // The button says it, so no chip repeats it.
    expect(screen.queryByLabelText('Recognised in the title')).toBeNull()
    await user.click(folderButton())
    await user.click(await screen.findByRole('option', { name: /Home reno/ }))
    expect(folderButton()).toHaveAccessibleName('Folder: Home reno. Change')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)[0]?.body).toEqual({ title: 'Send the invoice #acme', folderId: 'home' }))
    // After that task, a #folder decides again.
    await user.type(addLine(), 'Chase the deposit #acme p1{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)[1]?.body).toEqual({ title: 'Chase the deposit', priority: 4, folderId: 'acme' }))
    expect(folderButton()).toHaveAccessibleName('Folder: Home reno. Change')
  })

  it('a #folder typed after the button was used still wins, and a filter the new task matches says nothing', async () => {
    const user = await mountPanel()
    await user.click(folderButton())
    await user.click(await screen.findByRole('option', { name: /Home reno/ }))
    await user.type(screen.getByRole('textbox', { name: 'Filter tasks and chats' }), 'invoice')
    await user.type(addLine(), 'Send the invoice #acme')
    expect(folderButton()).toHaveAccessibleName('Folder: Acme, from the title. Change')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)[0]?.body).toEqual({ title: 'Send the invoice', folderId: 'acme' }))
    expect(await screen.findByText('Send the invoice')).toBeVisible()
    expect(screen.queryByText(/The filter hides it/)).toBeNull()
    await user.type(addLine(), 'Water the plants{Enter}')
    expect(await screen.findByText(/Added “Water the plants” to Home reno\. The filter hides it\./)).toBeVisible()
  })

  it('the button keeps every #folder already typed as text, and a #folder deleted and typed again wins', async () => {
    const user = await mountPanel()
    await user.type(addLine(), 'Call #acme about #home')
    await user.click(folderButton())
    await user.click(await screen.findByRole('option', { name: /Personal/ }))
    expect(folderButton()).toHaveAccessibleName('Folder: Personal. Change')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)[0]?.body).toEqual({ title: 'Call #acme about #home' }))
    await user.type(addLine(), 'Call #acme')
    expect(folderButton()).toHaveAccessibleName('Folder: Acme, from the title. Change')
    await user.clear(addLine())
    await user.type(addLine(), 'Call #acme')
    expect(folderButton()).toHaveAccessibleName('Folder: Acme, from the title. Change')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)[1]?.body).toEqual({ title: 'Call', folderId: 'acme' }))
  })

  it('a word kept as text stays in the title, and a folder since deleted reads as Personal', async () => {
    localStorage.setItem('totem.work.addFolder', JSON.stringify('gone'))
    const user = await mountPanel()
    expect(folderButton()).toHaveAccessibleName('Folder: Personal. Change')
    await user.type(addLine(), 'Water the plants tomorrow')
    await user.click(screen.getByRole('button', { name: 'Keep “tomorrow” as text' }))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)[0]?.body).toEqual({ title: 'Water the plants tomorrow' }))
  })

  it('a group’s + starts on its folder, can file elsewhere, and stays open while the picker is used', async () => {
    const user = await mountPanel()
    await user.click(screen.getByRole('button', { name: 'Add a task to Acme' }))
    const line = () => screen.getByRole('textbox', { name: 'New task…' })
    expect(line()).toHaveFocus()
    const buttons = screen.getAllByRole('button', { name: /^Folder: / })
    expect(buttons[1]).toHaveAccessibleName('Folder: Acme. Change')
    await user.click(buttons[1])
    await user.click(await screen.findByRole('option', { name: /Home reno/ }))
    expect(line()).toHaveFocus()
    await user.type(line(), 'Order tiles{Enter}')
    await waitFor(() => expect(sent('POST', /\/api\/todos\/board$/)[0]?.body).toEqual({ title: 'Order tiles', folderId: 'home' }))
    // The top line's own folder is untouched.
    expect(screen.getAllByRole('button', { name: /^Folder: / })[0]).toHaveAccessibleName('Folder: Personal. Change')
  })
})
