import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatThread } from './types'

// A browser handoff reaches a chat the owner is not in through the list
// (the bridge's withHandoff), and opening that chat shows the browser.
const bridge = vi.hoisted(() => ({ summaries: vi.fn(), page: vi.fn(), api: vi.fn() }))
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  getThreadSummaries: bridge.summaries,
  getThreadPage: bridge.page,
  api: bridge.api,
}))

const store = await import('./store')
// A fresh id per test: the store remembers the ones answered.
let n = 0
let handoff = { id: 'h0', reason: 'Sign in to Gmail', at: 1 }
const frame = { tabId: 't', url: 'https://mail.example', title: 'Sign in', image: 'data:image/jpeg;base64,', at: 1 }
const summary = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: 'regular', createdAt: 1, updatedAt: 10, summary: true, messageCount: 2, messages: [], ...extra }) as unknown as ChatThread

beforeEach(() => {
  handoff = { id: `h${++n}`, reason: 'Sign in to Gmail', at: 1 }
  const s = store.getState() as any
  s.threads = []
  s.runs = {}
  s.loads = {}
  s.handoffs = {}
  s.browser = {}
  s.browserOpen = false
  s.activeId = null
  bridge.summaries.mockReset()
  bridge.page.mockReset().mockResolvedValue({ id: 'a', kind: 'regular', createdAt: 1, updatedAt: 10, messageCount: 0, messages: [], history: { hasMore: false, before: null } })
  bridge.api.mockReset()
})

describe('a chat waiting on the owner in its browser', () => {
  it('the list names it, and the handoff is kept off the thread', async () => {
    bridge.summaries.mockResolvedValue({ threads: [summary('a', { handoff })] })
    await store.syncThreads()
    expect(store.getState().handoffs.a).toEqual(handoff)
    expect((store.getState().threads[0] as any).handoff).toBeUndefined()
  })

  it('a later list without it takes it back', async () => {
    bridge.summaries.mockResolvedValue({ threads: [summary('a', { handoff })] })
    await store.syncThreads()
    bridge.summaries.mockResolvedValue({ threads: [summary('a')] })
    await store.syncThreads()
    expect(store.getState().handoffs.a).toBeUndefined()
  })

  it('a chat whose run this device follows keeps what its stream said', async () => {
    ;(store.getState() as any).runs = { a: { seq: 0, activity: '', startedAt: 1 } }
    ;(store.getState() as any).handoffs = { a: handoff }
    bridge.summaries.mockResolvedValue({ threads: [summary('a')] })
    await store.syncThreads()
    expect(store.getState().handoffs.a).toEqual(handoff)
  })

  it('opening the chat opens the browser panel', async () => {
    ;(store.getState() as any).browser = { a: { ...frame, live: true } }
    bridge.summaries.mockResolvedValue({ threads: [summary('a', { handoff })] })
    await store.syncThreads()
    bridge.api.mockResolvedValue({ open: true, frame, handoff })
    store.setActive('a')
    expect(store.getState().browserOpen).toBe(true)
  })

  it('opening it with no frame yet reads the browser, then opens the panel', async () => {
    bridge.summaries.mockResolvedValue({ threads: [summary('a', { handoff })] })
    await store.syncThreads()
    bridge.api.mockResolvedValue({ open: true, frame, handoff })
    store.setActive('a')
    await vi.waitFor(() => expect(store.getState().browserOpen).toBe(true))
  })

  it('Done here is not undone by a list sent before the bridge heard it', async () => {
    bridge.summaries.mockResolvedValue({ threads: [summary('a', { handoff })] })
    await store.syncThreads()
    bridge.api.mockResolvedValue({ live: true, message: null })
    await store.answerHandoff('a', 'done')
    expect(store.getState().handoffs.a).toBeUndefined()
    await store.syncThreads()
    expect(store.getState().handoffs.a).toBeUndefined()
  })

  it('a Done the bridge refused leaves it waiting', async () => {
    bridge.summaries.mockResolvedValue({ threads: [summary('a', { handoff })] })
    await store.syncThreads()
    bridge.api.mockRejectedValue(new TypeError('Load failed'))
    await store.answerHandoff('a', 'done')
    expect(store.getState().handoffs.a).toEqual(handoff)
  })
})
