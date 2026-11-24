import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDraftStore, emptyDrafts, type DraftState } from './drafts'
import {
  arrive, chatDraftPreviews, createUploadHolds, discardWithUndo, draftRows, followChatList, keepEdit, openedDraft, ownedBy,
  placeFor, placeOfThread, returnUnsent, rowsSignature, takeForSend, trayOf, writeTray,
} from './draftsShared'
import type { Project } from './types'

// The draft logic the web and the iPhone app share (draftsShared.ts, copied byte for
// byte to mobile/src/lib/chat/): holds, Discard and Undo, gone chats, the rows, and
// the chat view's draft on send, refusal and arrival.

function store(initial: DraftState = emptyDrafts()) {
  let clock = 1000
  let n = 0
  return createDraftStore(initial, { save: () => {}, now: () => ++clock, mint: () => `id${++n}` })
}
const file = (id: string) => ({ id, name: `${id}.png`, mime: 'image/png', size: 10, kind: 'image' as const })
const home = { place: { kind: 'home' as const } }
const project = (id: string, name: string, parentId?: string) => ({ id, name, ...(parentId ? { parentId } : {}), chatCount: 0, updatedAt: 0 }) as Project

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('upload holds', () => {
  it('names every held upload at start and a beat after the set changes, and says which are missing', async () => {
    const s = store()
    s.write('chat-1', { text: 'x', attachments: [file('b'), file('a')] }, home)
    const hold = vi.fn(async (ids: string[]) => ({ held: ids.filter((id) => id !== 'a'), missing: ids.filter((id) => id === 'a') }))
    const holds = createUploadHolds(s, { hold, delayMs: 1000 })
    const seen: string[][] = []
    holds.subscribe(() => seen.push([...holds.missing()]))
    holds.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(hold.mock.calls).toEqual([[['a', 'b']]])
    expect(seen).toEqual([['a']])
    s.write('chat-1', { text: 'more words, same files' }, home)
    await vi.advanceTimersByTimeAsync(1000)
    expect(hold).toHaveBeenCalledTimes(1)
    s.write('chat-2', { attachments: [file('c')] }, home)
    await vi.advanceTimersByTimeAsync(999)
    expect(hold).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(hold.mock.calls[1][0]).toEqual(['a', 'b', 'c'])
  })

  it('a set that failed to reach the bridge goes again on renew, and only then', async () => {
    const s = store()
    s.write('chat-1', { attachments: [file('a')] }, home)
    let down = true
    const hold = vi.fn(async (ids: string[]) => { if (down) throw new Error('restarting'); return { held: ids, missing: [] } })
    const holds = createUploadHolds(s, { hold })
    holds.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(hold).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hold).toHaveBeenCalledTimes(1)
    down = false
    holds.renew()
    await vi.advanceTimersByTimeAsync(0)
    expect(hold).toHaveBeenCalledTimes(2)
    holds.renew()
    await vi.advanceTimersByTimeAsync(0)
    expect(hold).toHaveBeenCalledTimes(2)
  })
})

describe('discard with Undo', () => {
  it('Undo brings the draft back; its files go only once the line has gone, and only unshared ones', () => {
    const s = store()
    s.write('chat-1', { text: 'x', attachments: [file('mine'), file('shared')] }, home)
    s.write('chat-2', { attachments: [file('shared')] }, home)
    const released: string[] = []
    let line!: { undo: () => boolean; gone: () => void }
    discardWithUndo(s, 'chat-1', { show: (l) => { line = l }, release: (id) => released.push(id) })
    expect(s.get().drafts['chat-1']).toBeUndefined()
    expect(line.undo()).toBe(true)
    expect(s.get().drafts['chat-1'].text).toBe('x')
    line.gone()
    expect(released).toEqual([])

    discardWithUndo(s, 'chat-1', { show: (l) => { line = l }, release: (id) => released.push(id) })
    line.gone()
    expect(released).toEqual(['mine'])
    expect(line.undo()).toBe(true)
    expect(s.get().drafts['chat-1']).toBeUndefined()
  })

  it('Undo is refused once the draft has new words, and its old files go', () => {
    const s = store()
    s.write('chat-1', { text: 'old', attachments: [file('old')] }, home)
    const released: string[] = []
    let line!: { undo: () => boolean }
    discardWithUndo(s, 'chat-1', { show: (l) => { line = l }, release: (id) => released.push(id) })
    s.write('chat-1', { text: 'typed since' }, home)
    expect(line.undo()).toBe(false)
    expect(s.get().drafts['chat-1'].text).toBe('typed since')
    expect(released).toEqual(['old'])
  })

  it('the open new-chat draft moves the composer on, and Undo moves it back', () => {
    const s = store()
    const key = s.keyAt({ kind: 'home' })
    s.write(key, { text: 'on screen' }, home)
    let line!: { undo: () => boolean }
    discardWithUndo(s, key, { show: (l) => { line = l }, release: () => {} })
    expect(s.keyAt({ kind: 'home' })).not.toBe(key)
    line.undo()
    expect(s.keyAt({ kind: 'home' })).toBe(key)
  })
})

it('a gone chat’s draft is dropped only after a list the bridge answered', () => {
  const s = store()
  s.write('gone', { text: 'x' }, home)
  s.write('here', { text: 'y' }, home)
  s.write('running', { text: 'z' }, home)
  s.write(s.keyAt({ kind: 'home' }), { text: 'new chat' }, home)
  const chat = { threads: [{ id: 'here' }], runs: { running: {} }, answered: 0, subs: new Set<() => void>() }
  followChatList(s, { subscribe: (fn) => { chat.subs.add(fn); return () => { chat.subs.delete(fn) } }, getState: () => chat, listAnswered: () => chat.answered })
  chat.subs.forEach((fn) => fn())
  expect(s.get().drafts.gone).toBeTruthy()
  chat.answered = 1
  chat.subs.forEach((fn) => fn())
  expect(Object.keys(s.get().drafts).sort()).toEqual(['here', 'new:home', 'running'])
})

describe('the panel’s rows', () => {
  const projects = [project('p1', 'Garden'), project('f1', 'Beds', 'p1')]
  function four() {
    const s = store()
    s.write('chat-1', { text: 'a chat’s draft is not a row' }, home)
    s.write('new:a', { text: 'first line\nsecond line' }, home)
    s.write('new:b', { attachments: [file('x'), file('y')] }, { place: { kind: 'folder', id: 'f1' } })
    s.write('new:c', { text: 'for a task' }, { place: { kind: 'task', id: 't1', projectId: 'p1' } })
    s.write('new:d', { text: 'gone at midnight' }, { place: { kind: 'home' }, temporary: true })
    return s
  }

  it('new-chat drafts only, newest first, each with its place', () => {
    const rows = draftRows(four().get(), { projects, projectId: null, shown: null, listedOnArrival: false })
    expect(rows.map((r) => [r.key, r.preview, r.place, r.icon])).toEqual([
      ['new:d', 'gone at midnight', 'Temporary chat', 'temporary'],
      ['new:c', 'for a task', 'Garden', 'task'],
      ['new:b', '2 attachments', 'Beds', 'project'],
      ['new:a', 'first line', 'Home', 'home'],
    ])
    const inGarden = draftRows(four().get(), { projects, projectId: 'p1', shown: null, listedOnArrival: false })
    expect(inGarden.map((r) => r.key)).toEqual(['new:c', 'new:b'])
  })

  it('the draft on screen is listed only if it had words when opened', () => {
    const s = store()
    s.write('new:a', { text: 'typing now' }, home)
    const rows = (listedOnArrival: boolean) => draftRows(s.get(), { projects: [], projectId: null, shown: 'new:a', listedOnArrival })
    expect(rows(false)).toEqual([])
    expect(rows(true).map((r) => [r.key, r.active])).toEqual([['new:a', true]])
  })

  it('the signature changes with a row, not with typing a row never shows', () => {
    const s = four()
    const sig = () => rowsSignature(draftRows(s.get(), { projects, projectId: null, shown: null, listedOnArrival: false }))
    const before = sig()
    s.write('chat-1', { text: 'more typing in a chat' }, home)
    s.write('new:a', { text: 'first line\nsecond line, longer' }, home)
    expect(sig()).toBe(before)
    s.write('new:a', { text: 'a new first line' }, home)
    expect(sig()).not.toBe(before)
  })

  it('each chat’s draft by chat id, for Recent chats', () => {
    const s = store()
    s.write('chat-1', { text: '  first\nsecond' }, home)
    s.write('chat-2', { attachments: [file('x')] }, home)
    s.write('new:a', { text: 'not a chat yet' }, home)
    expect(chatDraftPreviews(s.get())).toEqual({ 'chat-1': 'first', 'chat-2': '1 attachment' })
  })
})

describe('places', () => {
  const projects = [{ id: 'p1' }, { id: 'f1', parentId: 'p1' }]
  it('a chat’s place: its task, its folder or project, else Home', () => {
    expect(placeOfThread({ taskId: 't1', projectId: 'f1' }, projects)).toEqual({ kind: 'task', id: 't1', projectId: 'f1' })
    expect(placeOfThread({ projectId: 'f1' }, projects)).toEqual({ kind: 'folder', id: 'f1' })
    expect(placeOfThread({ projectId: 'p1' }, projects)).toEqual({ kind: 'project', id: 'p1' })
    expect(placeOfThread({ projectId: 'deleted' }, projects)).toEqual({ kind: 'home' })
  })
  it('a new chat’s place', () => {
    expect(placeFor({ taskId: 't1', projectId: 'f1' }, projects)).toEqual({ kind: 'task', id: 't1', projectId: 'f1' })
    expect(placeFor({ taskId: null, projectId: 'f1' }, projects)).toEqual({ kind: 'folder', id: 'f1' })
    expect(placeFor({ taskId: null, projectId: null }, projects)).toEqual({ kind: 'home' })
  })
})

describe('the chat view’s draft', () => {
  it('arriving: a fresh composer for a place left full, the opened draft kept, the first view taking the opened one', () => {
    const calls: string[] = []
    const io = (opened: string | null, keyAt = 'new:x') => ({ takeOpened: () => { calls.push('take'); return opened }, keyAt: () => keyAt, fresh: () => { calls.push('fresh') } })
    arrive(null, { activeId: null, place: 'home', fresh: 0 }, io(null))
    expect(calls).toEqual(['take'])
    calls.length = 0
    arrive({ activeId: null, place: 'home', fresh: 0 }, { activeId: null, place: 'home', fresh: 0 }, io(null))
    expect(calls).toEqual([])
    arrive({ activeId: 'c1', place: null, fresh: 0 }, { activeId: null, place: 'home', fresh: 0 }, io(null))
    expect(calls).toEqual(['take', 'fresh'])
    calls.length = 0
    arrive({ activeId: 'c1', place: null, fresh: 0 }, { activeId: null, place: 'home', fresh: 0 }, io('new:x'))
    expect(calls).toEqual(['take'])
    calls.length = 0
    arrive({ activeId: null, place: 'home', fresh: 0 }, { activeId: null, place: 'home', fresh: 1 }, io('new:x'))
    expect(calls).toEqual(['take', 'fresh'], 'New chat asked for wins over an opened draft')
  })

  it('the opened draft says whether it is a temporary chat’s until it is taken', () => {
    const s = store()
    s.write('new:t', { text: 'off the record' }, { place: { kind: 'home' }, temporary: true })
    const opened = openedDraft(s)
    expect(opened.temporary()).toBe(false)
    opened.set('new:t')
    expect(opened.temporary()).toBe(true)
    expect(opened.take()).toBe('new:t')
    expect(opened.temporary()).toBe(false)
    expect(opened.take()).toBe(null)
  })

  it('a send takes the draft out; a refusal puts it back, and lost files are named', () => {
    const s = store()
    s.write('chat-1', { text: 'hello', attachments: [file('ok'), file('lost')] }, home)
    const { putBack, lost } = takeForSend(s, 'chat-1', new Set(['lost']))
    expect(s.get().drafts['chat-1']).toBeUndefined()
    expect(lost.map((a) => a.id)).toEqual(['lost'])
    putBack!()
    expect(s.get().drafts['chat-1'].text).toBe('hello')
    expect(takeForSend(s, 'nothing', new Set()).putBack).toBeUndefined()
  })

  it('a refused retry of a chat the bridge has lands in its draft; of one it never had, in a row of its own', () => {
    const s = store()
    const thread = { id: 'c1', kind: 'regular' as const }
    const known = returnUnsent(s, { thread, live: { messageCount: 4, messages: [] }, refusedIn: 'c1', projects: [], text: 'again', attachments: [], now: 5 })
    expect(known).toEqual({ key: 'c1', kept: true })
    const fresh = returnUnsent(s, { thread: { id: 'c2', kind: 'regular' }, live: { messageCount: 0, messages: [{ id: 'local-1' } as never] }, refusedIn: 'c2', projects: [], text: 'first words', attachments: [file('f')], now: 5 })
    expect(fresh).toEqual({ key: 'new:refused-c2', kept: false })
    expect(s.get().drafts['new:refused-c2'].attachments.map((a) => a.id)).toEqual(['f'])
    expect(s.keyAt({ kind: 'home' })).not.toBe('new:refused-c2')
  })

  it('a discarded unsent message of a chat never started goes to its place’s composer', () => {
    const s = store()
    const r = returnUnsent(s, { thread: { id: 'c3', kind: 'temporary' }, live: undefined, projects: [], text: 'later', attachments: [], now: 5 })
    expect(r.kept).toBe(false)
    expect(s.keyAt({ kind: 'home' }, true)).toBe(r.key)
    expect(s.get().drafts[r.key].temporary).toBe(true)
  })

  it('the tray: lost files stay named in the draft, files only it holds are its own', () => {
    const s = store()
    s.write('chat-1', { attachments: [file('a'), file('lost')] }, home)
    s.write('chat-2', { attachments: [file('a')] }, home)
    const missing = new Set(['lost'])
    expect(trayOf(s.get().drafts['chat-1'].attachments, missing)).toEqual({ tray: [file('a')], lost: [file('lost')] })
    writeTray(s, 'chat-1', [file('a'), file('b')], missing, home)
    expect(s.get().drafts['chat-1'].attachments.map((a) => a.id)).toEqual(['a', 'b', 'lost'])
    const own = ownedBy(s.get(), 'chat-1')
    expect([own(file('a')), own(file('b'))]).toEqual([false, true])
  })

  it('a queued message’s edit is kept as the chat’s draft only when the chat has none', () => {
    const s = store()
    expect(keepEdit(s, 'c1', 'edited words', [file('q')], home)).toBe(true)
    expect(s.get().drafts.c1.text).toBe('edited words')
    expect(keepEdit(s, 'c1', 'another edit', [], home)).toBe(false)
    expect(s.get().drafts.c1.text).toBe('edited words')
  })
})
