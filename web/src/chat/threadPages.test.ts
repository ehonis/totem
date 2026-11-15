import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatThread } from './types'
import { summarize } from './history'

// The store over a fake bridge: the list is summaries, a chat is read a window at a time.
const api = vi.hoisted(() => ({ summaries: vi.fn(), page: vi.fn() }))
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  getThreadSummaries: api.summaries,
  getThreadPage: api.page,
}))

const store = await import('./store')
const m = (id: string, content = `text ${id}`): ChatMessage => ({ id, role: id.startsWith('u') ? 'user' : 'assistant', content, createdAt: 1 })
const summary = (id: string, extra: Partial<ChatThread> = {}): ChatThread => ({ id, kind: 'regular', createdAt: 1, updatedAt: 10, summary: true, messageCount: 4, messages: [m('u2'), m('a2', 'cut…')], ...extra })
const page = (id: string, ids: string[], history = { hasMore: false, before: null as string | null }, extra: Partial<ChatThread> = {}) =>
  ({ id, kind: 'regular', createdAt: 1, updatedAt: 10, messageCount: 4, messages: ids.map((x) => m(x)), history, ...extra })

beforeEach(() => {
  const s = store.getState() as any
  s.threads = []
  s.runs = {}
  s.loads = {}
  s.activeId = null
  api.summaries.mockReset()
  api.page.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe('chats a window at a time', () => {
  it('the list is summaries; opening a chat reads its window and drops the preview', async () => {
    api.summaries.mockResolvedValue({ threads: [summary('a')] })
    await store.syncThreads()
    expect(store.getState().threads[0].summary).toBe(true)
    api.page.mockResolvedValue(page('a', ['u1', 'a1', 'u2', 'a2'], { hasMore: true, before: 'u1' }))
    await store.openThread('a')
    const t = store.getState().threads[0]
    expect(t.summary).toBeUndefined()
    expect(t.messages.map((x) => x.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(api.page).toHaveBeenCalledWith('a', { turns: 10 })
  })

  it('one read at a time per chat, and a failure is kept for Try again', async () => {
    api.summaries.mockResolvedValue({ threads: [summary('a')] })
    await store.syncThreads()
    api.page.mockRejectedValue(new TypeError('Load failed'))
    await Promise.all([store.openThread('a'), store.openThread('a')])
    expect(api.page).toHaveBeenCalledTimes(1)
    expect(store.getState().loads.a).toMatchObject({ latest: 'error', error: 'Couldn’t reach Totem' })
  })

  it('load earlier puts the older page in front', async () => {
    api.page.mockResolvedValueOnce(page('a', ['u2', 'a2'], { hasMore: true, before: 'u2' }))
    await store.openThread('a')
    api.page.mockResolvedValueOnce(page('a', ['u1', 'a1'], { hasMore: false, before: null }))
    expect(await store.loadEarlier('a')).toBe(true)
    expect(api.page).toHaveBeenLastCalledWith('a', { turns: 10, before: 'u2' })
    const t = store.getState().threads[0]
    expect(t.messages.map((x) => x.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(t.history).toEqual({ hasMore: false, before: null })
    expect(await store.loadEarlier('a')).toBe(false)
  })

  it('a sync keeps an opened chat\'s messages, and reads it again only when it changed', async () => {
    api.page.mockResolvedValue(page('a', ['u1', 'a1', 'u2', 'a2']))
    await store.openThread('a')
    const before = store.getState().threads[0].messages
    api.summaries.mockResolvedValue({ threads: [summary('a', { title: 'Renamed' })] })
    await store.syncThreads()
    expect(store.getState().threads[0].messages).toBe(before)
    expect(store.getState().threads[0].title).toBe('Renamed')
    expect(api.page).toHaveBeenCalledTimes(1)
    api.summaries.mockResolvedValue({ threads: [summary('a', { updatedAt: 20, messageCount: 6, messages: [m('a3')] })] })
    api.page.mockResolvedValue(page('a', ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'], undefined, { updatedAt: 20, messageCount: 6 }))
    await store.syncThreads()
    await vi.waitFor(() => expect(store.getState().threads[0].messages).toHaveLength(6))
    expect(store.getState().threads[0].messages[0]).toBe(before[0])
  })

  it('an older sync answer never lands on top of a newer one', async () => {
    let first!: (v: unknown) => void
    api.summaries.mockReturnValueOnce(new Promise((r) => { first = r }))
    api.summaries.mockResolvedValueOnce({ threads: [summary('a', { title: 'new' })] })
    const slow = store.syncThreads()
    await store.syncThreads()
    first({ threads: [summary('a', { title: 'old' })] })
    await slow
    expect(store.getState().threads[0].title).toBe('new')
  })

  it('a chat whose run is live keeps its live copy through a sync', async () => {
    api.page.mockResolvedValue(page('a', ['u1', 'a1']))
    await store.openThread('a')
    const live = store.getState().threads[0]
    ;(store.getState() as any).runs = { a: { seq: 3, activity: '', startedAt: 1, handle: null } }
    api.summaries.mockResolvedValue({ threads: [summary('a', { updatedAt: 99 })] })
    await store.syncThreads()
    expect(store.getState().threads[0]).toBe(live)
    expect(api.page).toHaveBeenCalledTimes(1)
  })

  it('the title falls back to the first message the list remembers', () => {
    expect(store.threadTitle(summary('a', { firstUserText: 'Plan the trip to Lisbon' }))).toBe('Plan the trip to Lisbon')
    expect(store.threadTitle({ ...page('a', ['u9']), history: { hasMore: true, before: 'u9' } } as ChatThread)).toBe('text u9')
  })
})

describe('the instant-paint cache', () => {
  it('keeps the windows of the chats opened last and summaries of the rest, within its size', () => {
    const big = (id: string): ChatThread => ({ id, kind: 'regular', createdAt: 1, updatedAt: 1, messageCount: 2, messages: [m(`u-${id}`, 'x'.repeat(5000)), m(`a-${id}`, 'y'.repeat(5000))] })
    const threads = ['a', 'b', 'c'].map(big)
    const all = JSON.parse(store.cachePayload(threads, ['a', 'b', 'c'], { windows: 2 })!)
    expect(all.threads.map((t: ChatThread) => !!t.summary)).toEqual([false, false, true])
    expect(all.threads[2].messages[1].content.length).toBe(401)
    const tight = JSON.parse(store.cachePayload(threads, ['a', 'b', 'c'], { windows: 3, bytes: 15_000 })!)
    expect(tight.threads.filter((t: ChatThread) => !t.summary).map((t: ChatThread) => t.id)).toEqual(['a'])
  })

  it('a summary of a loaded chat holds its last turn and what waits on the owner', () => {
    const t: ChatThread = { id: 'a', kind: 'regular', createdAt: 1, updatedAt: 1, messages: [m('u1'), m('a1'), m('u2'), { ...m('a2'), parts: [{ type: 'tool', id: 'p' } as any, { type: 'approval', id: 'q', status: 'pending' } as any] }], history: { hasMore: false, before: null } }
    const s = summarize(t)
    expect(s.summary).toBe(true)
    expect(s.messages.map((x) => x.id)).toEqual(['u2', 'a2'])
    expect(s.messages[1].parts!.map((p: any) => p.id)).toEqual(['q'])
    expect(s.firstUserText).toBe('text u1')
    expect(s.history).toBeUndefined()
  })

  it('a card still waiting from an earlier turn comes along as a stub', () => {
    const t: ChatThread = { id: 'a', kind: 'regular', createdAt: 1, updatedAt: 1, messages: [m('u1'), { ...m('a1'), parts: [{ type: 'inbox', id: 'card', status: 'pending' } as any] }, m('u2'), m('a2')] }
    const s = summarize(t)
    expect(s.messages.map((x) => x.id)).toEqual(['a1', 'u2', 'a2'])
    expect(s.messages[0].content).toBe('')
    expect(s.messages[0].parts!.map((p: any) => p.id)).toEqual(['card'])
  })
})

describe('network errors', () => {
  it('say so in words', () => {
    expect(store.networkText(new TypeError('Failed to fetch'))).toBe('Couldn’t reach Totem')
    expect(store.networkText(new TypeError('Load failed'))).toBe('Couldn’t reach Totem')
    expect(store.networkText(Object.assign(new Error('busy'), { status: 409 }))).toBe('busy')
  })
})
