import { describe, expect, it } from 'vitest'
import { mergeEarlier, mergeLatest, mergeSummary, isLoaded, type ThreadPage } from './history'
import type { ChatMessage, ChatThread } from './types'

const m = (id: string, content = id, role: ChatMessage['role'] = id.startsWith('u') ? 'user' : 'assistant'): ChatMessage => ({ id, role, content, createdAt: 1 })
const page = (ids: string[], history = { hasMore: false, before: null as string | null }, extra: Partial<ChatThread> = {}): ThreadPage =>
  ({ id: 't', kind: 'regular', createdAt: 1, updatedAt: 2, messages: ids.map((id) => m(id)), messageCount: 10, history, ...extra })

describe('history', () => {
  it('a first window replaces a summary preview', () => {
    const summary: ChatThread = { id: 't', kind: 'regular', createdAt: 1, updatedAt: 2, summary: true, messages: [m('u9', 'cut…')] }
    const t = mergeLatest(summary, page(['u8', 'a8', 'u9', 'a9'], { hasMore: true, before: 'u8' }))
    expect(isLoaded(t)).toBe(true)
    expect(t.summary).toBeUndefined()
    expect(t.messages.map((x) => x.id)).toEqual(['u8', 'a8', 'u9', 'a9'])
    expect(t.history).toEqual({ hasMore: true, before: 'u8' })
  })

  it('a newer window keeps earlier pages and unchanged message objects', () => {
    const loaded = mergeEarlier(mergeLatest(undefined, page(['u2', 'a2'], { hasMore: true, before: 'u2' })), page(['u1', 'a1'], { hasMore: false, before: null }))
    const keep = loaded.messages[2]
    const next = mergeLatest(loaded, page(['u2', 'a2', 'u3', 'a3'], { hasMore: true, before: 'u2' }))
    expect(next.messages.map((x) => x.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    expect(next.messages[2]).toBe(keep)
    expect(next.history).toEqual({ hasMore: false, before: null })
  })

  it('a window that does not overlap starts over from it', () => {
    const loaded = mergeLatest(undefined, page(['u1', 'a1']))
    const next = mergeLatest(loaded, page(['u7', 'a7'], { hasMore: true, before: 'u7' }))
    expect(next.messages.map((x) => x.id)).toEqual(['u7', 'a7'])
    expect(next.history).toEqual({ hasMore: true, before: 'u7' })
  })

  it('an earlier page drops what is already there', () => {
    const loaded = mergeLatest(undefined, page(['a1', 'u2'], { hasMore: true, before: 'a1' }))
    const t = mergeEarlier(loaded, page(['u1', 'a1'], { hasMore: false, before: null }))
    expect(t.messages.map((x) => x.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('a summary keeps an opened chat\'s messages and says when it changed', () => {
    const loaded = mergeLatest(undefined, page(['u1', 'a1']))
    const same = mergeSummary(loaded, { ...loaded, title: 'New name', summary: true, messages: [m('a1', 'cut')] })
    expect(same.stale).toBe(false)
    expect(same.thread.messages).toBe(loaded.messages)
    expect(same.thread.title).toBe('New name')
    expect(same.thread.summary).toBeUndefined()
    const moved = mergeSummary(loaded, { ...loaded, updatedAt: 3, messageCount: 12, summary: true, messages: [m('a2')] })
    expect(moved.stale).toBe(true)
    expect(moved.thread.messages).toBe(loaded.messages)
    const fresh = mergeSummary(undefined, { ...loaded, summary: true })
    expect(fresh.thread.summary).toBe(true)
  })

  it('an unsent message here does not make an opened chat stale', () => {
    const loaded = mergeLatest(undefined, page(['u1', 'a1']))
    const withUnsent = { ...loaded, messages: [...loaded.messages, { ...m('local-x'), unsent: true }] }
    expect(mergeSummary(withUnsent, { ...loaded, summary: true, messages: [m('a1', 'cut')] }).stale).toBe(false)
  })
})
