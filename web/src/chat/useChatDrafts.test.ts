import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ChatThread } from './types'

// Where a retried "Not sent" message's words go when the bridge refuses it: the
// chat's own draft when the bridge has the chat, else a row of its own. Filed
// under a chat the bridge never had, the gone-chat sweep would delete them.

const fake = { projects: [] as { id: string }[], threads: [] as ChatThread[], runs: {} }
vi.mock('./store', () => ({
  useChat: (sel: (s: typeof fake) => unknown) => sel(fake),
  getState: () => fake,
  subscribe: () => () => {},
  listAnswered: () => 0,
  openProject: vi.fn(),
  startTaskDraft: vi.fn(),
  projectById: () => undefined,
}))
vi.mock('./api', () => ({ holdUploads: vi.fn(async () => ({ held: [], missing: [] })), deleteUpload: vi.fn() }))
vi.mock('../toast', () => ({ pushToast: vi.fn(), pushError: vi.fn() }))
vi.mock('../work/state', () => ({ taskHome: () => null }))

const { useChatDrafts } = await import('./useChatDrafts')
const { drafts } = await import('./draftsWeb')

const thread = (id: string, extra: Partial<ChatThread>): ChatThread => ({ id, kind: 'regular', messages: [], createdAt: 1, updatedAt: 1, ...extra }) as ChatThread
const local = (id: string) => ({ id: `local-${id}`, role: 'user' as const, content: 'x', createdAt: 1 })

function hook() {
  return renderHook(() => useChatDrafts({
    activeId: null, active: null, scopeProject: undefined, draftTaskId: null, draftKind: 'regular', setDraftKind: () => {},
    composer: { current: null }, slot: '', visible: false, editing: false, onEditFiles: () => {},
  })).result.current
}

beforeEach(() => { for (const key of Object.keys(drafts.get().drafts)) drafts.remove(key) })

describe('a retried message the bridge refused', () => {
  it('goes into the chat’s own draft when the bridge has the chat', () => {
    fake.threads = [thread('c1', { messageCount: 4, messages: [local('u')] })]
    hook().onDiscarded('the question', [], 'c1')
    expect(drafts.get().drafts.c1.text).toBe('the question')
  })

  it('becomes a row of its own for a new chat the bridge never had, leaving the composer alone', () => {
    fake.threads = [thread('n1', { messages: [local('u'), { ...local('a'), role: 'assistant' }] })]
    const before = drafts.keyAt({ kind: 'home' })
    hook().onDiscarded('first words', [], 'n1')
    expect(drafts.get().drafts.n1).toBeUndefined()
    expect(drafts.get().drafts['new:refused-n1'].text).toBe('first words')
    expect(drafts.keyAt({ kind: 'home' })).toBe(before)
  })
})
