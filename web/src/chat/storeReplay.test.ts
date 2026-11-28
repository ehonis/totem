import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StreamEvent } from './types'

// Opening a chat whose reply is still running: the window read from the bridge holds the
// reply as saved so far, and attaching to the run replays it from its start. The replay
// rebuilds the reply, so its text is there once, not twice (the window's, then again).

let replay: StreamEvent[] = []
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  getThreadPage: () => Promise.resolve({
    id: 't', kind: 'regular', title: 'Deals', createdAt: 1, updatedAt: 2, messageCount: 2,
    history: { hasMore: false, before: null },
    messages: [
      { id: 'u', role: 'user', content: 'any deals?', createdAt: 1 },
      { id: 'a', role: 'assistant', content: 'Checking both lists.', parts: [{ type: 'text', text: 'Checking both lists.' }], status: 'streaming', createdAt: 1 },
    ],
  }),
}))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  getRuns: () => Promise.resolve({ runs: [{ threadId: 't', status: 'running', mode: 'chat', startedAt: 1 }] }),
  attachRun: (_id: string, _since: number, onEvent: (e: StreamEvent) => void) => {
    const done = Promise.resolve().then(() => { for (const e of replay) onEvent(e) })
    return { detach() {}, done: new Promise(() => {}), stalled: false, ready: done }
  },
}))

const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => { localStorage.clear() })

describe('re-attaching to a running reply from its start', () => {
  it('rebuilds the reply instead of doubling the text the window already had', async () => {
    vi.resetModules()
    const store = await import('./store')
    replay = [
      { type: 'start', threadId: 't', seq: 1, provider: 'claude', userMessage: { id: 'u', role: 'user', content: 'any deals?', createdAt: 1 }, assistantMessage: { id: 'a', role: 'assistant', content: '', parts: [], status: 'streaming', createdAt: 1 } } as unknown as StreamEvent,
      { type: 'delta', seq: 2, text: 'Checking both lists.' } as unknown as StreamEvent,
    ]
    await store.resumeRuns()
    await settle(); await settle()
    const reply = store.getState().threads.find((t) => t.id === 't')!.messages[1]
    expect(reply.content).toBe('Checking both lists.')
  })
})
