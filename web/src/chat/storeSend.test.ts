import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StreamEvent } from './types'

// The chat store's side of drafts: a send says when the bridge refused it (so
// its draft comes back), and never for a message that never got there or that
// the bridge had started. And the chat list cached in the browser comes back on load.

type Scenario = (onEvent: (e: StreamEvent) => void, onError: (e: Error & { status?: number }) => void) => void
let scenario: Scenario = () => {}
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  // The bridge stays out of reach for the retry's check of the list.
  getThreadSummaries: () => Promise.reject(new Error('offline')),
  sendChat: (_args: unknown, onEvent: (e: StreamEvent) => void, onError: (e: Error) => void) => {
    // As a real stream, it answers after the call returns.
    const done = Promise.resolve().then(() => scenario(onEvent, onError))
    return { detach() {}, done }
  },
}))

const settle = () => new Promise((r) => setTimeout(r, 0))

async function freshStore() {
  vi.resetModules()
  return import('./store')
}

beforeEach(() => { localStorage.clear(); scenario = () => {} })

describe('a send the bridge refused', () => {
  const refuse: Scenario = (_e, onError) => onError(Object.assign(new Error('busy'), { status: 400 }))

  it('calls onRefused', async () => {
    const store = await freshStore()
    scenario = refuse
    const onRefused = vi.fn()
    store.send({ text: 'hello', onRefused })
    await settle()
    expect(onRefused).toHaveBeenCalledTimes(1)
  })

  it('does not for one that never reached the bridge: that stays as "Not sent"', async () => {
    const store = await freshStore()
    scenario = (_e, onError) => onError(new Error('Failed to fetch'))
    const onRefused = vi.fn()
    const id = store.send({ text: 'on a plane', onRefused })
    await settle()
    expect(onRefused).not.toHaveBeenCalled()
    expect(store.hasUnsent(id)).toBe(true)
  })

  it('does not once the bridge has started the turn', async () => {
    const store = await freshStore()
    scenario = (onEvent, onError) => {
      onEvent({ type: 'start', threadId: 't', seq: 1, provider: 'p', userMessage: { id: 'u', role: 'user', content: 'x', createdAt: 1 }, assistantMessage: { id: 'a', role: 'assistant', content: '', createdAt: 1 } } as StreamEvent)
      onError(Object.assign(new Error('gone'), { status: 404 }))
    }
    const onRefused = vi.fn()
    store.send({ text: 'hello', onRefused })
    await settle()
    expect(onRefused).not.toHaveBeenCalled()
  })
})

describe('a retried "Not sent" message', () => {
  it('calls the retry’s onRefused when the bridge then refuses it', async () => {
    const store = await freshStore()
    scenario = (_e, onError) => onError(new Error('Failed to fetch'))
    const id = store.send({ text: 'on a plane' })
    await settle()
    scenario = (_e, onError) => onError(Object.assign(new Error('busy'), { status: 400 }))
    const onRefused = vi.fn()
    await store.retryUnsent(id, onRefused)
    await settle()
    expect(onRefused).toHaveBeenCalledTimes(1)
  })
})

describe('the cached chat list', () => {
  it('comes back on load', async () => {
    const at = Date.now()
    localStorage.setItem('chat_threads_v3', JSON.stringify({ v: 3, opened: ['c1'], threads: [{ id: 'c1', kind: 'regular', title: 'Cached chat', messages: [], messageCount: 0, createdAt: at, updatedAt: at }] }))
    const store = await freshStore()
    expect(store.getState().threads.map((t) => t.id)).toEqual(['c1'])
  })
})
