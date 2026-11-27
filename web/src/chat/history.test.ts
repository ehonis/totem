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

  it('takes when the chat\'s task was finished from each summary, so a reopened task takes it away', () => {
    const loaded = { ...mergeLatest(undefined, page(['u1', 'a1'])), taskId: 'task-1', taskDoneAt: 5 }
    const reopened = mergeSummary(loaded, { ...loaded, taskDoneAt: undefined, summary: true, messages: [m('a1', 'cut')] })
    expect(reopened.thread.taskDoneAt).toBeUndefined()
    expect(reopened.stale).toBe(false)
    const done = mergeSummary({ ...loaded, taskDoneAt: undefined }, { ...loaded, taskDoneAt: 9, summary: true, messages: [m('a1', 'cut')] })
    expect(done.thread.taskDoneAt).toBe(9)
  })

  it('a stale chat stays stale until a window replaces it, so a failed read is tried again', () => {
    const loaded = mergeLatest(undefined, page(['u1', 'a1']))
    const remote: ChatThread = { ...loaded, updatedAt: 3, messageCount: 12, summary: true, messages: [m('a2')] }
    const first = mergeSummary(loaded, remote)
    expect(first.stale).toBe(true)
    expect(first.thread.updatedAt).toBe(2)
    // The read failed: the next sync still sees it as behind.
    expect(mergeSummary(first.thread, remote).stale).toBe(true)
    // The window landed: caught up.
    const read = mergeLatest(first.thread, page(['u1', 'a1', 'u2', 'a2'], undefined, { updatedAt: 3, messageCount: 12 }))
    expect(mergeSummary(read, remote).stale).toBe(false)
  })

  it('a reply held as streaming that the bridge shows finished makes the chat stale', () => {
    const loaded = mergeLatest(undefined, page(['u1', 'a1']))
    const cut = { ...loaded, messages: [loaded.messages[0], { ...loaded.messages[1], status: 'streaming' as const }] }
    expect(mergeSummary(cut, { ...loaded, summary: true, messages: [{ ...m('a1', 'cut'), status: 'done' }] }).stale).toBe(true)
    // The bridge left it streaming too (a restart cut its run off): the same, so not read on every sync.
    expect(mergeSummary(cut, { ...loaded, summary: true, messages: [{ ...m('a1', 'cut'), status: 'streaming' }] }).stale).toBe(false)
  })

  it('an unsent message here does not make an opened chat stale', () => {
    const loaded = mergeLatest(undefined, page(['u1', 'a1']))
    const withUnsent = { ...loaded, messages: [...loaded.messages, { ...m('local-x'), unsent: true }] }
    expect(mergeSummary(withUnsent, { ...loaded, summary: true, messages: [m('a1', 'cut')] }).stale).toBe(false)
  })
})
