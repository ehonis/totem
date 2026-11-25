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
const createTask = vi.fn()
vi.mock('../work/state', () => ({ taskHome: () => null, createTask: (...args: unknown[]) => createTask(...args) }))

const { useChatDrafts } = await import('./useChatDrafts')
const { drafts } = await import('./draftsWeb')
const store = await import('./store')

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

describe('a task picked from the new-chat page', () => {
  const pickWith = (activeId: string | null) => renderHook(() => useChatDrafts({
    activeId, active: null, scopeProject: undefined, draftTaskId: null, draftKind: 'regular', setDraftKind: () => {},
    composer: { current: null }, slot: '', visible: false, editing: false, onEditFiles: () => {},
  })).result.current

  it('takes what was typed on Home with it', () => {
    fake.threads = []
    const home = drafts.keyAt({ kind: 'home' })
    drafts.write(home, { text: 'draft a reply' }, Date.now())
    pickWith(null).startForTask('t1')
    expect(drafts.get().drafts[drafts.keyAt({ kind: 'task', id: 't1' })]?.text).toBe('draft a reply')
  })

  it('leaves an open chat’s own draft with that chat (the side panel beside a chat)', () => {
    fake.threads = [thread('c1', { messageCount: 2 })]
    drafts.write('c1', { text: 'half a reply' }, Date.now())
    pickWith('c1').startForTask('t2')
    expect(drafts.get().drafts.c1.text).toBe('half a reply')
    expect(drafts.keyAt({ kind: 'task', id: 't2' })).not.toBe('c1')
  })
})

describe('$task: a task made in the composer', () => {
  const fields = { title: 'Renew passport', dueDate: null, priority: null, folderId: null }

  it('makes the task and starts a chat for it with an empty box', async () => {
    fake.threads = []
    const home = drafts.keyAt({ kind: 'home' })
    drafts.write(home, { text: 'Renew passport' }, { place: { kind: 'home' } })
    createTask.mockResolvedValueOnce({ ref: 't9', title: 'Renew passport' })
    expect(await hook().newTask(fields)).toBe(true)
    expect(createTask).toHaveBeenLastCalledWith(fields, null)
    expect(drafts.get().drafts[home]).toBeUndefined()
    expect(store.startTaskDraft).toHaveBeenLastCalledWith('t9', null)
  })

  it('keeps the words when the bridge refuses the task', async () => {
    const home = drafts.keyAt({ kind: 'home' })
    drafts.write(home, { text: 'Renew passport' }, { place: { kind: 'home' } })
    createTask.mockResolvedValueOnce(null)
    vi.mocked(store.startTaskDraft).mockClear()
    expect(await hook().newTask(fields)).toBe(false)
    expect(drafts.get().drafts[home].text).toBe('Renew passport')
    expect(store.startTaskDraft).not.toHaveBeenCalled()
  })
})
