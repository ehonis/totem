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
  createProject: (...args: unknown[]) => createProject(...args),
  projectById: () => undefined,
}))
vi.mock('./api', () => ({ holdUploads: vi.fn(async () => ({ held: [], missing: [] })), deleteUpload: vi.fn() }))
vi.mock('../toast', () => ({ pushToast: vi.fn(), pushError: vi.fn() }))
const createTask = vi.fn()
const createProject = vi.fn()
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

describe('$ghost and a new folder, picked from the `$` menu', () => {
  const withKind = (setDraftKind: (k: 'regular' | 'temporary') => void, scope?: { id: string }) => renderHook(() => useChatDrafts({
    activeId: null, active: null, scopeProject: scope as any, draftTaskId: null, draftKind: 'regular', setDraftKind,
    composer: { current: null }, slot: '', visible: false, editing: false, onEditFiles: () => {},
  })).result.current

  it('$ghost moves the words to a ghost chat’s draft at Home', () => {
    fake.threads = []
    fake.projects = [{ id: 'acme' }]
    const set = vi.fn()
    const here = drafts.keyAt({ kind: 'project', id: 'acme' })
    drafts.write(here, { text: 'x' }, { place: { kind: 'project', id: 'acme' } })
    withKind(set, { id: 'acme' }).pickDestination({ kind: 'ghost', key: 'ghost', name: 'Ghost chat' }, 'just between us', 0)
    expect(set).toHaveBeenLastCalledWith('temporary')
    const ghost = drafts.get().drafts[drafts.keyAt({ kind: 'home' }, true)]
    expect(ghost?.text).toBe('just between us')
    expect(ghost?.temporary).toBe(true)
    expect(drafts.get().drafts[here]).toBeUndefined()
    fake.projects = []
  })

  it('a new folder is made, then the words move into it', async () => {
    fake.threads = []
    const home = drafts.keyAt({ kind: 'home' })
    drafts.write(home, { text: 'x' }, { place: { kind: 'home' } })
    createProject.mockResolvedValueOnce({ id: 'tax', name: 'Tax returns' })
    fake.projects = [{ id: 'tax' }]
    withKind(() => {}).pickDestination({ kind: 'new-folder', key: 'new-project', name: 'Tax returns' }, 'sort the 1099s', 0)
    await vi.waitFor(() => expect(drafts.get().drafts[drafts.keyAt({ kind: 'project', id: 'tax' })]?.text).toBe('sort the 1099s'))
    expect(createProject).toHaveBeenLastCalledWith({ name: 'Tax returns' }, { open: false })
    fake.projects = []
  })

  it('a folder the bridge refuses leaves the words where they were', async () => {
    const home = drafts.keyAt({ kind: 'home' })
    drafts.write(home, { text: 'x' }, { place: { kind: 'home' } })
    createProject.mockRejectedValueOnce(new Error('nope'))
    withKind(() => {}).pickDestination({ kind: 'new-folder', key: 'new-folder:acme', name: 'Receipts', parent: { id: 'acme' } as any }, 'keep me', 0)
    await vi.waitFor(() => expect(createProject).toHaveBeenLastCalledWith({ name: 'Receipts', parentId: 'acme' }, { open: false }))
    expect(drafts.get().drafts[home].text).toBe('keep me')
  })
})
