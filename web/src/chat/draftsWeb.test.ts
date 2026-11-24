import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { serializeDrafts, writeDraft, emptyDrafts } from './drafts'

// The web's side of the drafts against a stand-in chat store and bridge: Undo
// and the release of a discarded draft's uploads, the uploads held past the
// bridge's sweep, chats that are gone, other tabs, and the old drafts.

const chat = {
  state: { runs: {} as Record<string, unknown>, loaded: false, threads: [] as { id: string }[] },
  answered: 0,
  subs: new Set<() => void>(),
}
const emit = () => chat.subs.forEach((fn) => fn())
vi.mock('./store', () => ({
  getState: () => chat.state,
  subscribe: (fn: () => void) => { chat.subs.add(fn); return () => chat.subs.delete(fn) },
  listAnswered: () => chat.answered,
  openProject: vi.fn(),
  startTaskDraft: vi.fn(),
}))
const api = { holdUploads: vi.fn(async (ids: string[]) => ({ held: ids.filter((id) => id !== 'gone'), missing: ids.filter((id) => id === 'gone') })), deleteUpload: vi.fn(async () => {}) }
vi.mock('./api', () => api)
vi.mock('../work/state', () => ({ taskHome: () => null }))
const toastMock = { pushToast: vi.fn(), pushError: vi.fn() }
vi.mock('../toast', () => toastMock)

const file = (id: string) => ({ id, name: `${id}.png`, mime: 'image/png', size: 1, kind: 'image' as const })
const home = { place: { kind: 'home' as const } }

// Each load is a fresh copy of the module; the window listeners of the copies before it go.
let added: [string, EventListenerOrEventListenerObject][] = []
const realAdd = window.addEventListener.bind(window)
window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => { added.push([type, fn]); realAdd(type, fn, opts) }) as typeof window.addEventListener
/** The module loaded again over the same storage: a reload of this page. */
async function reload() {
  for (const [type, fn] of added) window.removeEventListener(type, fn)
  added = []
  vi.resetModules()
  const web = await import('./draftsWeb')
  web.startDraftSync()
  return web
}
async function load(legacy?: Record<string, string>, v2?: unknown) {
  for (const [type, fn] of added) window.removeEventListener(type, fn)
  added = []
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  if (legacy) localStorage.setItem('totem.chat.drafts', JSON.stringify(legacy))
  if (v2) localStorage.setItem('totem.chat.drafts.v2', JSON.stringify(v2))
  const web = await import('./draftsWeb')
  web.startDraftSync()
  return web
}

beforeEach(() => {
  vi.useFakeTimers()
  chat.state = { runs: {}, loaded: false, threads: [] }
  chat.answered = 0
  chat.subs.clear()
  api.holdUploads.mockClear()
  api.deleteUpload.mockClear()
  toastMock.pushToast.mockClear()
  toastMock.pushError.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('discarding a draft', () => {
  const lastToast = () => toastMock.pushToast.mock.calls.at(-1)![2] as { action: { onClick: () => void }; onExpire: () => void }

  it('Undo brings it back and keeps its uploads', async () => {
    const { drafts, discardDraft } = await load()
    drafts.write('new:a', { text: 'maybe', attachments: [file('u1')] }, home)
    discardDraft('new:a')
    expect(drafts.get().drafts['new:a']).toBeUndefined()
    expect(toastMock.pushToast).toHaveBeenLastCalledWith('Draft discarded', 'info', expect.anything())
    lastToast().action.onClick()
    expect(drafts.get().drafts['new:a']).toMatchObject({ text: 'maybe', attachments: [file('u1')] })
    expect(api.deleteUpload).not.toHaveBeenCalled()
  })

  it('Undo fails when the draft has new content, and its uploads then go', async () => {
    const { drafts, discardDraft } = await load()
    drafts.write('c1', { text: 'old', attachments: [file('u1')] }, home)
    discardDraft('c1')
    drafts.write('c1', { text: 'new words' }, home)
    lastToast().action.onClick()
    expect(toastMock.pushError).toHaveBeenCalledWith('The draft has new content.')
    expect(drafts.get().drafts.c1.text).toBe('new words')
    expect(api.deleteUpload).toHaveBeenCalledWith('u1')
  })

  it('releases the uploads only when the toast has gone, and not one another draft holds', async () => {
    const { drafts, discardDraft } = await load()
    drafts.write('new:a', { text: 'a', attachments: [file('u1'), file('shared')] }, home)
    drafts.write('new:b', { text: 'b', attachments: [file('shared')] }, home)
    discardDraft('new:a')
    expect(api.deleteUpload).not.toHaveBeenCalled()
    lastToast().onExpire()
    expect(api.deleteUpload.mock.calls).toEqual([['u1']])
  })
})

describe('uploads held past the sweep', () => {
  it('renews every held upload at start', async () => {
    const stored = { v: 2, drafts: { c1: { key: 'c1', text: '', attachments: [file('u0')], createdAt: 1, updatedAt: 1, place: { kind: 'home' } } }, current: {} }
    await load(undefined, stored)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.holdUploads).toHaveBeenCalledWith(['u0'])
  })

  it('names them again whenever the set changes, and marks the ones the bridge lost', async () => {
    const { drafts, useMissingUploads } = await load()
    drafts.write('c1', { text: 'x', attachments: [file('u1')] }, home)
    await vi.advanceTimersByTimeAsync(1100)
    expect(api.holdUploads).toHaveBeenLastCalledWith(['u1'])
    drafts.write('c1', { text: 'x y' }, home)
    await vi.advanceTimersByTimeAsync(1100)
    expect(api.holdUploads).toHaveBeenCalledTimes(1)
    drafts.write('new:a', { text: 'z', attachments: [file('gone')] }, home)
    await vi.advanceTimersByTimeAsync(1100)
    expect(api.holdUploads).toHaveBeenLastCalledWith(['gone', 'u1'])
    expect([...renderHook(() => useMissingUploads()).result.current]).toEqual(['gone'])
  })

  it('drops a pending renewal when the set goes back to what was last named', async () => {
    const { drafts } = await load()
    drafts.write('c1', { text: 'x', attachments: [file('u1')] }, home)
    await vi.advanceTimersByTimeAsync(1100)
    drafts.write('c2', { text: 'y', attachments: [file('u2')] }, home)
    drafts.remove('c2')
    await vi.advanceTimersByTimeAsync(1100)
    expect(api.holdUploads.mock.calls).toEqual([[['u1']]])
  })
})

describe('a chat that is gone', () => {
  it('keeps every draft and file when the first chat list fails, even though the list counts as loaded', async () => {
    const { drafts } = await load()
    drafts.write('c1', { text: 'a reply', attachments: [file('u1')] }, home)
    drafts.write('c2', { text: 'another' }, home)
    chat.state = { runs: {}, loaded: true, threads: [] }
    emit()
    expect(Object.keys(drafts.get().drafts).sort()).toEqual(['c1', 'c2'])
    expect(api.deleteUpload).not.toHaveBeenCalled()
  })

  it('takes its draft with it once the bridge has listed the chats, leaving the files to their hold', async () => {
    const { drafts } = await load()
    drafts.write('c1', { text: 'kept' }, home)
    drafts.write('c2', { text: 'orphan', attachments: [file('u2')] }, home)
    drafts.write('new:a', { text: 'new chat' }, home)
    chat.state = { runs: {}, loaded: true, threads: [{ id: 'c1' }] }
    chat.answered = 3
    emit()
    expect(Object.keys(drafts.get().drafts).sort()).toEqual(['c1', 'new:a'])
    expect(api.deleteUpload).not.toHaveBeenCalled()
  })

  it('checks again only when a new list arrives, not on every change to the chats', async () => {
    const { drafts } = await load()
    chat.state = { runs: {}, loaded: true, threads: [{ id: 'c1' }] }
    chat.answered = 3
    emit()
    drafts.write('c9', { text: 'a chat made since that list' }, home)
    emit()
    expect(drafts.get().drafts.c9).toBeDefined()
  })
})

describe('other tabs', () => {
  it('takes in another tab’s save against the value it replaced', async () => {
    const { drafts } = await load()
    drafts.write('c1', { text: 'here' }, home)
    drafts.write('c2', { text: 'removed there' }, home)
    drafts.flush()
    const was = localStorage.getItem('totem.chat.drafts.v2')
    vi.setSystemTime(Date.now() + 1000)
    const there = writeDraft(writeDraft(emptyDrafts(), 'c1', { text: 'there, later' }, home, Date.now()), 'c3', { text: 'new there' }, home, Date.now())
    const json = serializeDrafts(there)
    localStorage.setItem('totem.chat.drafts.v2', json)
    window.dispatchEvent(new StorageEvent('storage', { key: 'totem.chat.drafts.v2', newValue: json, oldValue: was }))
    expect(Object.fromEntries(Object.entries(drafts.get().drafts).map(([k, d]) => [k, d.text]))).toEqual({ c1: 'there, later', c3: 'new there' })
    // Nothing of its own to add, so nothing written back.
    await vi.advanceTimersByTimeAsync(1000)
    expect(localStorage.getItem('totem.chat.drafts.v2')).toBe(json)
  })

  it('folds in what a tab on the old page changed, then removes the old key', async () => {
    const { drafts } = await load()
    drafts.write('c1', { text: 'newer here' }, home)
    window.dispatchEvent(new StorageEvent('storage', { key: 'totem.chat.drafts', oldValue: '{"c1":"stale"}', newValue: JSON.stringify({ c1: 'stale', c2: 'typed in the old tab' }) }))
    expect(drafts.get().drafts.c1.text).toBe('newer here')
    expect(drafts.get().drafts.c2.text).toBe('typed in the old tab')
    localStorage.setItem('totem.chat.drafts', '{"c2":"typed in the old tab"}')
    drafts.flush()
    expect(localStorage.getItem('totem.chat.drafts')).toBeNull()
  })
})

describe('back from the back/forward cache', () => {
  it('takes in what other tabs saved meanwhile before it saves', async () => {
    const { drafts } = await load()
    drafts.write('c0', { text: 'old' }, home)
    drafts.flush()
    // Another tab saves while this one is frozen: no storage event reaches it.
    const there = JSON.parse(localStorage.getItem('totem.chat.drafts.v2')!)
    there.drafts['new:k'] = { key: 'new:k', text: 'written while away', attachments: [], createdAt: Date.now(), updatedAt: Date.now(), place: { kind: 'home' } }
    localStorage.setItem('totem.chat.drafts.v2', JSON.stringify(there))
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
    drafts.write('c0', { text: 'old, edited here' }, home)
    drafts.flush()
    const saved = JSON.parse(localStorage.getItem('totem.chat.drafts.v2')!).drafts
    expect(saved['new:k'].text).toBe('written while away')
    expect(saved.c0.text).toBe('old, edited here')
  })
})

describe('a tab still on the old page', () => {
  // That tab writes its whole map on every change; this page removes the key on
  // its next save, so the old tab's next write comes with no old value.
  const oldTabWrites = (next: Record<string, string>) => {
    const was = localStorage.getItem('totem.chat.drafts')
    const json = JSON.stringify(next)
    localStorage.setItem('totem.chat.drafts', json)
    window.dispatchEvent(new StorageEvent('storage', { key: 'totem.chat.drafts', oldValue: was, newValue: json }))
  }

  it('does not bring back a message sent here when it types elsewhere', async () => {
    const { drafts } = await load({ c9: 'question?' })
    expect(drafts.get().drafts.c9.text).toBe('question?')
    expect(localStorage.getItem('totem.chat.drafts')).toBeNull()
    drafts.remove('c9')
    await vi.advanceTimersByTimeAsync(400)
    oldTabWrites({ c9: 'question?', c1: 'h' })
    expect(drafts.get().drafts.c1.text).toBe('h')
    expect(drafts.get().drafts.c9).toBeUndefined()
  })

  it('has its typing taken in a chat that already has a draft here', async () => {
    const { drafts } = await load()
    oldTabWrites({ c1: 'h' })
    await vi.advanceTimersByTimeAsync(400)
    expect(localStorage.getItem('totem.chat.drafts')).toBeNull()
    oldTabWrites({ c1: 'hello world' })
    expect(drafts.get().drafts.c1.text).toBe('hello world')
  })

  it('with two old tabs, one typing does not clear the other’s draft', async () => {
    const { drafts } = await load()
    oldTabWrites({ y: 'B words' })
    await vi.advanceTimersByTimeAsync(400)
    oldTabWrites({ x: 'A words' })
    await vi.advanceTimersByTimeAsync(400)
    expect(drafts.get().drafts.x.text).toBe('A words')
    expect(drafts.get().drafts.y.text).toBe('B words')
  })

  it('still clears a send after this page reloads', async () => {
    await load({ c1: 'sent soon' })
    await vi.advanceTimersByTimeAsync(400)
    expect(localStorage.getItem('totem.chat.drafts')).toBeNull()
    const { drafts } = await reload()
    expect(drafts.get().drafts.c1.text).toBe('sent soon')
    oldTabWrites({})
    expect(drafts.get().drafts.c1).toBeUndefined()
  })

  it('clears the words it sent, unless they were changed here', async () => {
    const { drafts } = await load()
    oldTabWrites({ c1: 'what time is it', c2: 'and this' })
    drafts.write('c2', { text: 'and this, edited here' }, home)
    oldTabWrites({})
    expect(drafts.get().drafts.c1).toBeUndefined()
    expect(drafts.get().drafts.c2.text).toBe('and this, edited here')
  })
})

describe('Undo after discarding the open draft', () => {
  const undo = () => (toastMock.pushToast.mock.calls.at(-1)![2] as { action: { onClick: () => void } }).action.onClick()

  it('puts it back in the composer, which had moved to a fresh draft', async () => {
    const { drafts, discardDraft } = await load()
    drafts.write('new:a', { text: 'open one' }, home)
    drafts.show('new:a')
    discardDraft('new:a')
    expect(drafts.keyAt(home.place)).not.toBe('new:a')
    undo()
    expect(drafts.keyAt(home.place)).toBe('new:a')
  })

  it('leaves the composer where it is once something was typed in the fresh draft', async () => {
    const { drafts, discardDraft } = await load()
    drafts.write('new:a', { text: 'open one' }, home)
    drafts.show('new:a')
    discardDraft('new:a')
    const fresh = drafts.keyAt(home.place)
    drafts.write(fresh, { text: 'something new' }, home)
    undo()
    expect(drafts.keyAt(home.place)).toBe(fresh)
    expect(drafts.get().drafts['new:a'].text).toBe('open one')
  })
})

describe('the old drafts', () => {
  it('are carried over once: written as v2 and the old key removed', async () => {
    const { drafts } = await load({ 'new:regular': 'from before' })
    expect(drafts.get().drafts['new:regular'].text).toBe('from before')
    expect(localStorage.getItem('totem.chat.drafts')).toBeNull()
    expect(JSON.parse(localStorage.getItem('totem.chat.drafts.v2')!).drafts['new:regular'].text).toBe('from before')
  })
})
