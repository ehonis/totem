import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createDraftStore, loadDrafts, serializeDrafts, emptyDrafts, draftKeyAt, listDrafts, heldUploadIds, draftPreview,
  writeDraft, freshDraft, moveDraft, returnDraft, undoDiscard, removeDraft, discardDraft, mergeDrafts, foldLegacy, readSaved,
  type DraftPlace, type DraftState,
} from './drafts'
import type { Attachment } from './types'

const home: DraftPlace = { kind: 'home' }
const harbor: DraftPlace = { kind: 'folder', id: 'harbor' }
const file = (id: string, name = `${id}.png`): Attachment => ({ id, name, mime: 'image/png', size: 10, kind: 'image', url: `/api/chat/uploads/${id}` })

/** A store over a fake disk, with ids minted in order. */
function setup(initial: DraftState = emptyDrafts(), save: (json: string) => void = () => {}) {
  let n = 0
  let now = 1000
  const disk: string[] = []
  const onSaveError = vi.fn()
  const store = createDraftStore(initial, {
    save: (json) => { save(json); disk.push(json) },
    now: () => (now += 1),
    mint: () => `d${++n}`,
    onSaveError,
    delayMs: 50,
  })
  return { store, disk, onSaveError }
}

afterEach(() => { vi.useRealTimers() })

const texts = (st: DraftState) => Object.fromEntries(Object.entries(st.drafts).map(([k, v]) => [k, v.text]))

describe('loading', () => {
  it('carries the old text-only drafts over, each still the one its place shows', () => {
    const legacy = JSON.stringify({ 'new:regular': 'home words', 'new:project:wp': 'plan', 'new:task:t1': 'fix it', 'new:temporary': 'gone at midnight', c42: 'reply', 'new:project:empty': '  ' })
    const s = loadDrafts(null, legacy, 5)
    expect(Object.keys(s.drafts).sort()).toEqual(['c42', 'new:project:wp', 'new:regular', 'new:task:t1', 'new:temporary'])
    expect(s.drafts['new:task:t1']).toMatchObject({ text: 'fix it', attachments: [], place: { kind: 'task', id: 't1' }, createdAt: 5 })
    expect(s.drafts['new:temporary'].temporary).toBe(true)
    expect(draftKeyAt(s, home)).toBe('new:regular')
    expect(draftKeyAt(s, home, true)).toBe('new:temporary')
    expect(draftKeyAt(s, { kind: 'project', id: 'wp' })).toBe('new:project:wp')
    expect(draftKeyAt(s, { kind: 'task', id: 't1' })).toBe('new:task:t1')
  })

  it('prefers the v2 record, drops what does not read, and survives garbage', () => {
    const good = serializeDrafts(writeDraft(emptyDrafts(), 'new:a', { text: 'hello', attachments: [file('u1')] }, { place: harbor }, 7))
    const s = loadDrafts(good, null, 9)
    expect(Object.keys(s.drafts)).toEqual(['new:a'])
    expect(s.drafts['new:a'].attachments).toEqual([file('u1')])
    const bad = JSON.stringify({ v: 2, drafts: { x: { text: 1 }, y: { text: 'hi', attachments: [{ id: 3 }], place: { kind: 'home' } } }, current: { home: 'not-new' } })
    const t = loadDrafts(bad, null, 1)
    expect(Object.keys(t.drafts)).toEqual(['y'])
    expect(t.drafts.y.attachments).toEqual([])
    expect(t.current).toEqual({})
    expect(loadDrafts('{nope', '[1,2', 1)).toEqual(emptyDrafts())
  })

  it('writes the carried-over record once, so the old key can go', () => {
    vi.useFakeTimers()
    const { store, disk } = setup(loadDrafts(null, JSON.stringify({ 'new:regular': 'x' }), 1))
    store.flush()
    expect(JSON.parse(disk[0]).drafts['new:regular'].text).toBe('x')
  })
})

describe('writing', () => {
  it('drops a draft once it has neither words nor files', () => {
    let s = writeDraft(emptyDrafts(), 'c1', { text: 'hi' }, { place: home }, 1)
    s = writeDraft(s, 'c1', { attachments: [file('u1')] }, { place: home }, 2)
    s = writeDraft(s, 'c1', { text: '   ' }, { place: home }, 3)
    expect(s.drafts.c1).toMatchObject({ text: '   ', attachments: [file('u1')], createdAt: 1, updatedAt: 3 })
    s = writeDraft(s, 'c1', { attachments: [] }, { place: home }, 4)
    expect(s.drafts.c1).toBeUndefined()
    expect(writeDraft(s, 'c2', { text: '' }, { place: home }, 5)).toBe(s)
  })

  it('marks a later change later even when the clock has stepped back', () => {
    let s = writeDraft(emptyDrafts(), 'c1', { text: 'before sleep' }, { place: home }, 1000)
    s = writeDraft(s, 'c1', { text: 'after waking' }, { place: home }, 400)
    expect(s.drafts.c1.updatedAt).toBe(1001)
    s = writeDraft(s, 'c1', { attachments: [file('u1')] }, { place: home }, 300)
    expect(s.drafts.c1.filesAt).toBe(1002)
  })

  it('leaves the state alone when nothing changed', () => {
    const s = writeDraft(emptyDrafts(), 'c1', { text: 'hi', attachments: [file('u1')] }, { place: home }, 1)
    expect(writeDraft(s, 'c1', { text: 'hi', attachments: [file('u1')] }, { place: home }, 2)).toBe(s)
  })
})

describe('new chats', () => {
  it('reuses the place’s draft while it is empty, and mints a new one when it has words', () => {
    const mint = vi.fn(() => 'm1')
    let s = emptyDrafts()
    expect(freshDraft(s, home, false, mint)).toBe(s)
    expect(mint).not.toHaveBeenCalled()
    s = writeDraft(s, draftKeyAt(s, home), { text: 'first' }, { place: home }, 1)
    s = freshDraft(s, home, false, mint)
    expect(draftKeyAt(s, home)).toBe('new:m1')
    expect(listDrafts(s).map((d) => d.text)).toEqual(['first'])
    // Another place keeps its own.
    expect(draftKeyAt(s, harbor)).toBe('new:project:harbor')
  })

  it('moves a draft to another place, which shows it; where it was starts fresh', () => {
    let s = writeDraft(emptyDrafts(), 'new:d1', { text: 'fix the map', attachments: [file('u1')] }, { place: home }, 1)
    s = { ...s, current: { home: 'new:d1' } }
    s = moveDraft(s, 'new:d1', harbor, false, 2, () => 'unused')
    expect(s.drafts['new:d1']).toMatchObject({ place: harbor, attachments: [file('u1')] })
    expect(draftKeyAt(s, harbor)).toBe('new:d1')
    expect(s.current.home).toBeUndefined()
    // An empty draft still moves the composer's key.
    const t = moveDraft(emptyDrafts(), 'new:x', { kind: 'task', id: 't1', projectId: 'wp' }, false, 3, () => 'unused')
    expect(draftKeyAt(t, { kind: 'task', id: 't1' })).toBe('new:x')
  })

  it('gives a draft moved off its place’s own key a key of its own, so the two places never share it', () => {
    let s = writeDraft(emptyDrafts(), 'new:home', { text: 'for the project' }, { place: home }, 1)
    s = moveDraft(s, 'new:home', harbor, false, 2, () => 'm9')
    expect(Object.keys(s.drafts)).toEqual(['new:m9'])
    expect(s.drafts['new:m9']).toMatchObject({ key: 'new:m9', place: harbor, text: 'for the project' })
    expect(draftKeyAt(s, harbor)).toBe('new:m9')
    // Home's composer is empty again, and typing there makes Home's own draft.
    expect(draftKeyAt(s, home)).toBe('new:home')
    expect(s.drafts[draftKeyAt(s, home)]).toBeUndefined()
    // So are the old keys carried over from before.
    const old = loadDrafts(null, JSON.stringify({ 'new:project:wp': 'plan' }), 1)
    const moved = moveDraft(old, 'new:project:wp', home, false, 2, () => 'm10')
    expect(draftKeyAt(moved, home)).toBe('new:m10')
    expect(draftKeyAt(moved, { kind: 'project', id: 'wp' })).toBe('new:project:wp')
    expect(moved.drafts['new:project:wp']).toBeUndefined()
  })

  it('lists new-chat drafts newest first, never a chat’s own', () => {
    let s = writeDraft(emptyDrafts(), 'new:a', { text: 'older' }, { place: home }, 1)
    s = writeDraft(s, 'new:b', { attachments: [file('u1'), file('u2')] }, { place: harbor }, 2)
    s = writeDraft(s, 'c1', { text: 'a reply' }, { place: home }, 3)
    s = writeDraft(s, 'new:a', { text: 'older, edited later' }, { place: home }, 4)
    expect(listDrafts(s).map((d) => d.key)).toEqual(['new:b', 'new:a'])
    expect(listDrafts(s, (d) => d.place.kind === 'home').map((d) => d.key)).toEqual(['new:a'])
    expect(draftPreview(s.drafts['new:b'])).toBe('2 attachments')
    expect(draftPreview({ text: '\n  first line \nsecond', attachments: [] })).toBe('first line')
    expect(draftPreview({ text: 'see [notes.pdf](totem-ref://upload/abcdefgh12) please\nmore', attachments: [] })).toBe('see notes.pdf please')
    expect(heldUploadIds(s)).toEqual(['u1', 'u2'])
  })
})

describe('discard, send and failure', () => {
  it('discarding the draft a composer shows moves that composer to a fresh one', () => {
    let s = writeDraft(emptyDrafts(), 'new:a', { text: 'open one' }, { place: home }, 1)
    s = { ...s, current: { home: 'new:a' } }
    const r = discardDraft(s, 'new:a', () => 'm2')
    expect(r.removed!.text).toBe('open one')
    expect(draftKeyAt(r.state, home)).toBe('new:m2')
    // A row not on screen leaves the composer alone, and so does a chat's own draft.
    const other = writeDraft(s, 'new:b', { text: 'a row' }, { place: home }, 2)
    expect(draftKeyAt(discardDraft(other, 'new:b', () => 'm3').state, home)).toBe('new:a')
  })

  it('Undo puts a discarded draft back, unless it has new content', () => {
    const s = writeDraft(emptyDrafts(), 'new:a', { text: 'keep me' }, { place: home }, 1)
    const { state, removed } = removeDraft(s, 'new:a')
    expect(state.drafts['new:a']).toBeUndefined()
    expect(undoDiscard(state, removed!).state.drafts['new:a'].text).toBe('keep me')
    const typed = writeDraft(state, 'new:a', { text: 'something else' }, { place: home }, 2)
    expect(undoDiscard(typed, removed!)).toEqual({ state: typed, ok: false })
  })

  it('a failed send goes back into the same draft, ahead of anything written since', () => {
    const sent = writeDraft(emptyDrafts(), 'c1', { text: 'the question', attachments: [file('u1')] }, { place: home }, 1).drafts.c1
    expect(returnDraft(emptyDrafts(), sent, 5).drafts.c1).toMatchObject({ text: 'the question', attachments: [file('u1')] })
    const since = writeDraft(emptyDrafts(), 'c1', { text: 'and more', attachments: [file('u2'), file('u1')] }, { place: home }, 3)
    expect(returnDraft(since, sent, 5).drafts.c1).toMatchObject({ text: 'the question\nand more', attachments: [file('u1'), file('u2')] })
  })

  it('the store: a send takes the draft out, and putting it back restores words and files', () => {
    const { store } = setup()
    store.write('new:home', { text: 'hello', attachments: [file('u1')] }, { place: home })
    const held = store.remove('new:home')
    expect(store.get().drafts['new:home']).toBeUndefined()
    store.putBack(held!)
    expect(store.get().drafts['new:home']).toMatchObject({ text: 'hello', attachments: [file('u1')] })
  })
})

describe('other tabs', () => {
  const d = (key: string, text: string, updatedAt: number) => ({ key, text, attachments: [], createdAt: 1, updatedAt, place: home })
  const of = (...list: ReturnType<typeof d>[]): DraftState => ({ drafts: Object.fromEntries(list.map((x) => [x.key, x])), current: {} })

  it('merges three ways against what the other tab’s save replaced', () => {
    const base = of(d('both', 'v1', 1), d('goneThere', 'old', 1), d('goneHere', 'old', 1), d('editedHere', 'v1', 1))
    const local = { ...of(d('both', 'mine', 5), d('goneThere', 'old', 1), d('editedHere', 'mine, after', 6), d('onlyHere', 'unsaved', 7)), current: { home: 'new:x' } }
    const there = of(d('both', 'theirs, later', 8), d('goneHere', 'old', 1), d('onlyThere', 'new there', 4))
    const { state, same } = mergeDrafts(local, there, base)
    expect(texts(state)).toEqual({ both: 'theirs, later', editedHere: 'mine, after', onlyHere: 'unsaved', onlyThere: 'new there' })
    expect(state.current).toEqual({ home: 'new:x' })
    expect(same).toBe(false)
  })

  it('drops a draft the per-field merge leaves empty', () => {
    const mine = { ...d('k', '', 9), attachments: [file('u1')], filesAt: 1 }
    const there = { ...d('k', 'words', 5), filesAt: 10 }
    expect(mergeDrafts(of(mine), of(there), of(d('k', 'words', 1))).state.drafts.k).toBeUndefined()
  })

  it('breaks a tie the same way in every tab', () => {
    const a = d('k', 'from a', 5)
    const b = d('k', 'from b', 5)
    expect(mergeDrafts(of(a), of(b), emptyDrafts()).state.drafts.k.text).toBe('from b')
    expect(mergeDrafts(of(b), of(a), emptyDrafts()).state.drafts.k.text).toBe('from b')
  })

  it('says when the result is the other tab’s save, and changes nothing when there is nothing new', () => {
    const local = of(d('a', 'x', 1))
    const there = of(d('a', 'x', 1), d('b', 'y', 2))
    const r = mergeDrafts(local, there, of(d('a', 'x', 1)))
    expect(r.same).toBe(true)
    expect(mergeDrafts(local, of(d('a', 'x', 1)), local).state).toBe(local)
  })

  it('folds in what a tab on the old page wrote, only the keys that write changed', () => {
    let s = writeDraft(emptyDrafts(), 'new:m1', { text: 'current at home', attachments: [file('u1')] }, { place: home }, 1)
    s = { ...s, current: { home: 'new:m1' } }
    s = writeDraft(s, 'c1', { text: 'edited here since', attachments: [file('u2')] }, { place: home }, 9)
    const was = JSON.stringify({ c1: 'stale', sent: 'sent from here already' })
    const now = JSON.stringify({ c1: 'stale', sent: 'sent from here already', 'new:regular': 'typed in the old tab', c2: 'a reply there' })
    const folded = foldLegacy(s, now, was, 5)
    expect(texts(folded)).toEqual({ 'new:m1': 'current at home', c1: 'edited here since', 'new:regular': 'typed in the old tab', c2: 'a reply there' })
    expect(folded.current).toEqual({ home: 'new:m1' })
  })

  it('clears words an old tab dropped only when its write is plainly a send or a move', () => {
    let s = emptyDrafts()
    for (const [key, text] of [['y', 'B words'], ['a', 'to send'], ['b', 'stays'], ['new:regular', 'move me']]) s = writeDraft(s, key, { text }, { place: home }, 1)
    // A second old tab that never had y writes its own map: y stays.
    expect(texts(foldLegacy(s, JSON.stringify({ x: 'A words' }), JSON.stringify({ y: 'B words' }), 5))).toMatchObject({ y: 'B words', x: 'A words' })
    // A send: nothing else changed.
    expect(texts(foldLegacy(s, JSON.stringify({ b: 'stays' }), JSON.stringify({ a: 'to send', b: 'stays' }), 5)).a).toBeUndefined()
    // A move: the only other change is a new key holding exactly the dropped words.
    const moved = foldLegacy(s, JSON.stringify({ 'new:project:p': 'move me' }), JSON.stringify({ 'new:regular': 'move me' }), 5)
    expect(texts(moved)['new:regular']).toBeUndefined()
    expect(moved.drafts['new:project:p']).toMatchObject({ text: 'move me', place: { kind: 'project', id: 'p' } })
    // A drop alongside an unrelated change is another tab's write: nothing cleared.
    expect(texts(foldLegacy(s, JSON.stringify({ b: 'stays, edited' }), JSON.stringify({ a: 'to send', b: 'stays' }), 5)).a).toBe('to send')
  })

  it('on a load, folds in only old keys with no draft yet', () => {
    const s = writeDraft(emptyDrafts(), 'c1', { text: 'newer here' }, { place: home }, 9)
    const loaded = loadDrafts(serializeDrafts(s), JSON.stringify({ c1: 'stale', c3: 'old tab' }), 2)
    expect(texts(loaded)).toEqual({ c1: 'newer here', c3: 'old tab' })
    expect(readSaved('{nope')).toBeNull()
  })
})

describe('two tabs in one browser', () => {
  // Two stores over one storage, each told of the other's saves as a browser does
  // (a storage event a moment later, with the value it replaced), into `merge`.
  function twoTabs() {
    vi.useFakeTimers()
    let stored: string | null = null
    let clock = 1000
    let n = 0
    const saves = { a: 0, b: 0 }
    const tabs: Record<'a' | 'b', ReturnType<typeof createDraftStore>> = {} as never
    const make = (me: 'a' | 'b', other: 'a' | 'b') => createDraftStore(emptyDrafts(), {
      read: () => stored,
      save: (json) => {
        const was = stored
        stored = json
        saves[me] += 1
        setTimeout(() => tabs[other].merge(json, was), 5)
      },
      now: () => (clock += 1),
      mint: () => `${me}${++n}`,
      delayMs: 300,
    })
    tabs.a = make('a', 'b')
    tabs.b = make('b', 'a')
    const disk = () => texts(readSaved(stored) || emptyDrafts())
    return { ...tabs, saves, disk, settle: () => vi.advanceTimersByTime(3000) }
  }

  it('keeps typing across New chat while the other tab sits idle', () => {
    const t = twoTabs()
    t.a.write(t.a.keyAt(home), { text: 'first draft' }, { place: home })
    vi.advanceTimersByTime(400)
    const second = t.a.fresh(home)
    t.a.write(second, { text: 'second draft' }, { place: home })
    t.settle()
    expect(t.a.get().drafts[second].text).toBe('second draft')
    expect(Object.values(t.disk()).sort()).toEqual(['first draft', 'second draft'])
    expect(Object.values(texts(t.b.get())).sort()).toEqual(['first draft', 'second draft'])
  })

  it('keeps a file one tab attached while the other typed in the same draft', () => {
    const t = twoTabs()
    t.a.write('new:home', { text: 'hello' }, { place: home })
    t.settle()
    t.b.write('new:home', { attachments: [file('u1')] }, { place: home })
    vi.advanceTimersByTime(10)
    t.a.write('new:home', { text: 'hello there' }, { place: home })
    t.settle()
    for (const tab of [t.a, t.b]) expect(tab.get().drafts['new:home']).toMatchObject({ text: 'hello there', attachments: [file('u1')] })
  })

  it('a save made before the other tab’s new draft reached it never drops that draft, even for a moment', () => {
    const t = twoTabs()
    t.b.write('c0', { text: 'shared' }, { place: home })
    t.settle()
    t.a.write('new:k', { text: 'a long paragraph' }, { place: home })
    t.b.write('c0', { text: 'shared, B' }, { place: home })
    // At 300 ms both save: B's save is made before A's storage event reaches it.
    vi.advanceTimersByTime(300)
    vi.advanceTimersByTime(6)
    // B's save has reached A: A's paragraph is still in its composer, so typing on keeps it.
    expect(t.a.get().drafts['new:k']?.text).toBe('a long paragraph')
    t.settle()
    for (const tab of [t.a, t.b]) expect(texts(tab.get())).toEqual({ c0: 'shared, B', 'new:k': 'a long paragraph' })
    expect(t.disk()).toEqual({ c0: 'shared, B', 'new:k': 'a long paragraph' })
  })

  it('an idle tab never writes back', () => {
    const t = twoTabs()
    t.a.write('c1', { text: 'one' }, { place: home })
    t.settle()
    t.a.write('c1', { text: 'one, two' }, { place: home })
    t.a.remove('c1')
    t.settle()
    expect(t.saves.b).toBe(0)
    expect(t.b.get().drafts.c1).toBeUndefined()
  })

  it('a discarded draft stays gone in both tabs, Undo toast or not', () => {
    const t = twoTabs()
    t.a.write('new:x', { text: 'discard me' }, { place: home })
    t.settle()
    t.a.discard('new:x')
    t.settle()
    expect(t.a.get().drafts['new:x']).toBeUndefined()
    expect(t.b.get().drafts['new:x']).toBeUndefined()
    expect(t.disk()).toEqual({})
  })

  it('a refused send put back after the send was saved is kept', () => {
    const t = twoTabs()
    t.a.write('c1', { text: 'the question' }, { place: home })
    t.settle()
    const held = t.a.remove('c1')!
    vi.advanceTimersByTime(450)
    t.a.putBack(held)
    t.settle()
    expect(t.a.get().drafts.c1.text).toBe('the question')
    expect(t.b.get().drafts.c1.text).toBe('the question')
    expect(t.disk()).toEqual({ c1: 'the question' })
  })

  it('a draft only this tab has, not yet saved, survives the other tab’s save', () => {
    const t = twoTabs()
    t.b.write('c2', { text: 'from b' }, { place: home })
    vi.advanceTimersByTime(250)
    t.a.write('c1', { text: 'typed in a' }, { place: home })
    t.settle()
    expect(texts(t.a.get())).toEqual({ c1: 'typed in a', c2: 'from b' })
    expect(texts(t.b.get())).toEqual({ c1: 'typed in a', c2: 'from b' })
  })

  it('a draft discarded here is not brought back by the other tab saving before this tab does', () => {
    const t = twoTabs()
    t.a.write('c1', { text: 'shared' }, { place: home })
    t.settle()
    t.a.discard('c1')
    t.b.write('c2', { text: 'b types' }, { place: home })
    vi.advanceTimersByTime(100)
    t.settle()
    expect(texts(t.a.get())).toEqual({ c2: 'b types' })
    expect(texts(t.b.get())).toEqual({ c2: 'b types' })
  })
})

describe('saving', () => {
  it('saves a burst of changes once, after a beat, and at once on flush', () => {
    vi.useFakeTimers()
    const { store, disk } = setup()
    store.write('c1', { text: 'h' }, { place: home })
    store.write('c1', { text: 'hi' }, { place: home })
    expect(disk).toHaveLength(0)
    vi.advanceTimersByTime(60)
    expect(disk).toHaveLength(1)
    store.write('c1', { text: 'hi there' }, { place: home })
    store.flush()
    expect(JSON.parse(disk[1]).drafts.c1.text).toBe('hi there')
    vi.advanceTimersByTime(60)
    expect(disk).toHaveLength(2)
  })

  it('keeps working in memory when storage is full, saying so once', () => {
    vi.useFakeTimers()
    let full = true
    const { store, disk, onSaveError } = setup(emptyDrafts(), () => { if (full) throw new DOMException('quota', 'QuotaExceededError') })
    store.write('c1', { text: 'one' }, { place: home })
    vi.advanceTimersByTime(60)
    store.write('c1', { text: 'two' }, { place: home })
    vi.advanceTimersByTime(60)
    expect(store.get().drafts.c1.text).toBe('two')
    expect(onSaveError).toHaveBeenCalledTimes(1)
    expect(disk).toHaveLength(0)
    full = false
    store.flush()
    expect(JSON.parse(disk[0]).drafts.c1.text).toBe('two')
  })
})

describe('the owner’s round trip', () => {
  it('a draft in two chats and two new chats all come back after a reload', () => {
    vi.useFakeTimers()
    const { store, disk } = setup()
    store.write('chatX', { text: 'for X', attachments: [file('ux')] }, { place: home })
    store.write('chatY', { text: 'for Y' }, { place: home })
    store.write(store.fresh(home), { text: 'new one', attachments: [file('u1')] }, { place: home })
    store.write(store.fresh(home), { text: 'new two' }, { place: home })
    // "New chat" again: the place's draft has words, so a third, empty one shows.
    const third = store.fresh(home)
    expect(store.get().drafts[third]).toBeUndefined()
    store.flush()
    const reloaded = loadDrafts(disk[disk.length - 1], null, 0)
    expect(listDrafts(reloaded).map((d) => d.text)).toEqual(['new two', 'new one'])
    expect(listDrafts(reloaded)[1].attachments).toEqual([file('u1')])
    expect(reloaded.drafts.chatX).toMatchObject({ text: 'for X', attachments: [file('ux')] })
    expect(reloaded.drafts.chatY.text).toBe('for Y')
    expect(draftKeyAt(reloaded, home)).toBe(third)
  })
})
