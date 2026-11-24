import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import type { ChatThread, Project } from './types'

// The chats panel's draft rows and the pencil on a chat with unsent words.

const projects = [
  { id: 'wp', name: 'Ballpark', instructions: '', createdAt: 0, updatedAt: 2 },
  { id: 'harbor', name: 'harbor', parentId: 'wp', instructions: '', createdAt: 0, updatedAt: 1 },
  { id: 'other', name: 'Other', instructions: '', createdAt: 0, updatedAt: 1 },
] as Project[]
const fake = { projects, prefs: {}, retitling: {}, handoffs: {}, runs: {}, threads: [] }
const nav = { openProject: vi.fn(), startTaskDraft: vi.fn() }
vi.mock('./store', async (orig) => ({ ...(await orig<typeof import('./store')>()), useChat: (sel: (s: typeof fake) => unknown) => sel(fake), ...nav }))
const toastMock = { pushToast: vi.fn(), pushError: vi.fn() }
vi.mock('../toast', async (orig) => ({ ...(await orig<typeof import('../toast')>()), ...toastMock }))

// jsdom has no matchMedia; the rows ask it whether chats can be dragged.
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia

const { drafts, setShownDraft } = await import('./draftsWeb')
const { default: ChatsPanelDrafts } = await import('./ChatsPanelDrafts')
const { ThreadItem } = await import('./ThreadList')

const file = (id: string) => ({ id, name: `${id}.png`, mime: 'image/png', size: 1, kind: 'image' as const })
let clock = 0
function seed() {
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10))
  drafts.write('new:home1', { text: 'Plan the week\nwith details' }, { place: { kind: 'home' } })
  drafts.write('new:fold1', { attachments: [file('u1'), file('u2')] }, { place: { kind: 'folder', id: 'harbor' } })
  drafts.write('new:other1', { text: 'Elsewhere' }, { place: { kind: 'project', id: 'other' } })
  drafts.write('c1', { text: 'A reply in progress' }, { place: { kind: 'home' } })
}
const rows = () => screen.queryAllByRole('button', { name: /^Unsent draft/ })

beforeEach(() => {
  for (const key of Object.keys(drafts.get().drafts)) drafts.remove(key)
  setShownDraft(null)
  nav.openProject.mockClear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('draft rows', () => {
  it('draws nothing at all without drafts', () => {
    const { container } = render(<ChatsPanelDrafts projectId={null} onOpen={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists every new-chat draft at Home, newest first, with its place and first line, never a chat’s', () => {
    seed()
    render(<ChatsPanelDrafts projectId={null} onOpen={() => {}} />)
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Unsent draft in Other: Elsewhere',
      'Unsent draft in harbor: 2 attachments',
      'Unsent draft in Home: Plan the week',
    ])
  })

  it('in a project, lists its own and its folders’ drafts only', () => {
    seed()
    render(<ChatsPanelDrafts projectId="wp" onOpen={() => {}} />)
    expect(rows().map((r) => r.textContent)).toEqual(['harbor2 attachments'])
  })

  it('opens a draft at its place on click, Enter or Space', () => {
    seed()
    const onOpen = vi.fn()
    render(<ChatsPanelDrafts projectId={null} onOpen={onOpen} />)
    fireEvent.click(rows()[1])
    expect(nav.openProject).toHaveBeenLastCalledWith('harbor')
    expect(drafts.keyAt({ kind: 'folder', id: 'harbor' })).toBe('new:fold1')
    fireEvent.keyDown(rows()[2], { key: 'Enter' })
    expect(nav.openProject).toHaveBeenLastCalledWith(null)
    fireEvent.keyDown(rows()[0], { key: ' ' })
    expect(nav.openProject).toHaveBeenLastCalledWith('other')
    expect(onOpen).toHaveBeenCalledTimes(3)
  })

  it('discards from the ×, with an Undo toast, without opening the draft', () => {
    seed()
    const onOpen = vi.fn()
    render(<ChatsPanelDrafts projectId={null} onOpen={onOpen} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Discard draft' })[0])
    expect(onOpen).not.toHaveBeenCalled()
    expect(drafts.get().drafts['new:other1']).toBeUndefined()
    expect(rows()).toHaveLength(2)
    expect(toastMock.pushToast).toHaveBeenLastCalledWith('Draft discarded', 'info', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))
  })

  it('keeps the open draft’s row in place while he types, and adds none for a fresh one', () => {
    seed()
    render(<ChatsPanelDrafts projectId={null} onOpen={() => {}} />)
    act(() => setShownDraft('new:home1'))
    act(() => drafts.write('new:home1', { text: 'Plan the week, edited' }, { place: { kind: 'home' } }))
    expect(rows().map((r) => r.getAttribute('aria-current'))).toEqual([null, null, 'true'])
    expect(rows()[2]).toHaveAttribute('aria-label', 'Unsent draft in Home: Plan the week, edited')
    act(() => setShownDraft('new:fresh'))
    act(() => drafts.write('new:fresh', { text: 'just started' }, { place: { kind: 'home' } }))
    expect(rows().map((r) => r.textContent)).not.toContain('Homejust started')
  })

  it('leaves no row behind when the open draft is discarded', () => {
    seed()
    render(<ChatsPanelDrafts projectId={null} onOpen={() => {}} />)
    act(() => setShownDraft('new:home1'))
    const open = rows().find((r) => r.getAttribute('aria-current') === 'true')!
    fireEvent.click(open.querySelector('button')!)
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual(['Unsent draft in Other: Elsewhere', 'Unsent draft in harbor: 2 attachments'])
  })

  it('typing again after discarding the open draft starts a new one, never the discarded one', () => {
    seed()
    render(<ChatsPanelDrafts projectId={null} onOpen={() => {}} />)
    act(() => { drafts.show('new:home1'); setShownDraft(drafts.keyAt({ kind: 'home' })) })
    fireEvent.click(rows().find((r) => r.getAttribute('aria-current') === 'true')!.querySelector('button')!)
    const now = drafts.keyAt({ kind: 'home' })
    expect(now).not.toBe('new:home1')
    act(() => { setShownDraft(now); drafts.write(now, { text: 'P' }, { place: { kind: 'home' } }) })
    expect(drafts.get().drafts['new:home1']).toBeUndefined()
    expect(rows().map((r) => r.getAttribute('aria-label'))).not.toContain('Unsent draft in Home: Plan the week')
  })

  it('hands focus to the next row after a discard from the keyboard, else the one before', async () => {
    seed()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    render(<div className="vc-threads-list"><ChatsPanelDrafts projectId={null} onOpen={() => {}} /></div>)
    const discard = (i: number) => fireEvent.click(rows()[i].querySelector('button')!, { detail: 0 })
    discard(0)
    expect(document.activeElement).toBe(rows()[0])
    expect(rows()[0]).toHaveAttribute('aria-label', 'Unsent draft in harbor: 2 attachments')
    discard(1)
    expect(document.activeElement).toBe(rows()[0])
    discard(0)
    expect(document.activeElement).toHaveClass('vc-threads-list')
  })
})

describe('a chat row with unsent words', () => {
  const thread = { id: 'c1', kind: 'regular', title: 'Trip plans', messages: [{ id: 'm', role: 'user', content: 'x', createdAt: 1 }], createdAt: 1, updatedAt: 1 } as ChatThread

  it('wears the pencil and offers Discard draft among its hover actions', () => {
    seed()
    render(<ThreadItem t={thread} active={false} live={false} onOpen={() => {}} />)
    expect(screen.getByRole('img', { name: 'Unsent draft' })).toHaveAttribute('title', 'Unsent draft')
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft in Trip plans' }))
    expect(drafts.get().drafts.c1).toBeUndefined()
    expect(screen.queryByRole('img', { name: 'Unsent draft' })).toBeNull()
  })

  it('shows neither on the chat being viewed, nor on a chat with no draft', () => {
    seed()
    const { rerender } = render(<ThreadItem t={thread} active live={false} onOpen={() => {}} />)
    expect(screen.queryByRole('img', { name: 'Unsent draft' })).toBeNull()
    rerender(<ThreadItem t={{ ...thread, id: 'c9' }} active={false} live={false} onOpen={() => {}} />)
    expect(screen.queryByRole('img', { name: 'Unsent draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Discard draft/ })).toBeNull()
  })
})
