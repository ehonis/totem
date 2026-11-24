// Saved drafts for the chat composer, as T3 Code keeps them: every chat keeps one
// unsent message under its own id, and a chat not started yet keeps as many as
// he leaves behind, each under `new:<uuid>`, listed as rows in the chats panel.
// A draft is its words and its finished uploads together, so switching chats
// swaps both.
//
// No DOM and no storage here: the iPhone app copies this file byte for byte
// (#299), and each side hands createDraftStore its own load, save and clock.
import type { Attachment } from './types'
import { plainRefs } from './refs.ts'

/** Where a new chat's draft will start: Home, a project or folder, or for a task (in its folder, if any). */
export type DraftPlace =
  | { kind: 'home' }
  | { kind: 'project' | 'folder'; id: string }
  | { kind: 'task'; id: string; projectId?: string }

export interface Draft {
  key: string
  text: string
  /** Finished uploads only; one still uploading is not kept. */
  attachments: Attachment[]
  createdAt: number
  /** When the words last changed. */
  updatedAt: number
  /** When the files last changed (a draft saved before this field: its `updatedAt`). Two tabs' copies merge words and files each by its own time. */
  filesAt?: number
  place: DraftPlace
  /** A temporary chat's draft (Home only). */
  temporary?: true
}

export interface DraftState {
  drafts: Record<string, Draft>
  /** The new-chat draft each place's composer shows: a place key → a draft key. */
  current: Record<string, string>
}

export const DRAFTS_STORAGE_KEY = 'totem.chat.drafts.v2'
export const LEGACY_DRAFTS_KEY = 'totem.chat.drafts'

export const emptyDrafts = (): DraftState => ({ drafts: {}, current: {} })

/** A draft for a chat not started yet (the rest are keyed by their chat's id). */
export const isNewChatKey = (key: string) => key.startsWith('new:')

export const hasContent = (d: Pick<Draft, 'text' | 'attachments'> | null | undefined) => !!d && (d.text.trim().length > 0 || d.attachments.length > 0)

/** One composer per place: Home, a temporary chat, a project or folder, a task. */
export function placeKey(place: DraftPlace, temporary = false) {
  if (place.kind === 'task') return `task:${place.id}`
  if (place.kind === 'home') return temporary ? 'temporary' : 'home'
  return `project:${place.id}`
}

/** The place's draft key when nothing has been minted for it yet. */
const defaultKey = (place: DraftPlace, temporary = false) => `new:${placeKey(place, temporary)}`
/** A key named after a place (a default, or a pre-v2 key) rather than minted for one draft. */
const PLACE_NAMED = /^new:(home|temporary|regular|project:|task:)/

/** The draft key a place's composer shows. */
export function draftKeyAt(s: DraftState, place: DraftPlace, temporary = false) {
  return s.current[placeKey(place, temporary)] || defaultKey(place, temporary)
}

const isAttachment = (a: any): a is Attachment => !!a && typeof a.id === 'string' && typeof a.name === 'string'
  && typeof a.mime === 'string' && typeof a.size === 'number' && (a.kind === 'image' || a.kind === 'file' || a.kind === 'text')

function readPlace(p: any): DraftPlace | null {
  if (p?.kind === 'home') return { kind: 'home' }
  if ((p?.kind === 'project' || p?.kind === 'folder') && typeof p.id === 'string') return { kind: p.kind, id: p.id }
  if (p?.kind === 'task' && typeof p.id === 'string') return { kind: 'task', id: p.id, ...(typeof p.projectId === 'string' ? { projectId: p.projectId } : {}) }
  return null
}

function readDraft(key: string, d: any): Draft | null {
  const place = readPlace(d?.place)
  if (!place || typeof d.text !== 'string' || !Array.isArray(d.attachments)) return null
  const draft: Draft = {
    key, text: d.text, attachments: d.attachments.filter(isAttachment),
    createdAt: Number(d.createdAt) || 0, updatedAt: Number(d.updatedAt) || 0, place,
    ...(Number(d.filesAt) > 0 ? { filesAt: Number(d.filesAt) } : {}),
    ...(d.temporary === true ? { temporary: true as const } : {}),
  }
  return hasContent(draft) ? draft : null
}

/** Where a pre-v2 draft's key says its chat would have started. */
function legacyPlace(key: string): { place: DraftPlace; temporary: boolean } {
  if (key.startsWith('new:task:')) return { place: { kind: 'task', id: key.slice('new:task:'.length) }, temporary: false }
  if (key.startsWith('new:project:')) return { place: { kind: 'project', id: key.slice('new:project:'.length) }, temporary: false }
  return { place: { kind: 'home' }, temporary: key === 'new:temporary' }
}

/**
 * The stored drafts: the v2 record when it reads, else the old text-only map
 * (`{ [key]: text }`) carried over once, each new-chat draft still the one its
 * place's composer shows.
 */
export function loadDrafts(v2: string | null, legacy: string | null, now: number): DraftState {
  const saved = readSaved(v2)
  return foldLegacy(saved || emptyDrafts(), legacy, null, now)
}

/** A saved v2 record; null when it does not read. */
export function readSaved(v2: string | null): DraftState | null {
  if (!v2) return null
  try {
    const raw = JSON.parse(v2)
    if (!raw || typeof raw.drafts !== 'object') return null
    const s = emptyDrafts()
    for (const [key, d] of Object.entries(raw.drafts || {})) {
      const draft = readDraft(key, d)
      if (draft) s.drafts[key] = draft
    }
    for (const [pk, key] of Object.entries(raw.current || {})) if (typeof key === 'string' && isNewChatKey(key)) s.current[pk] = key
    return s
  } catch { return null }
}

function readLegacy(json: string | null): Record<string, string> {
  let old: unknown = null
  try { old = json ? JSON.parse(json) : null } catch {}
  const out: Record<string, string> = {}
  if (old && typeof old === 'object' && !Array.isArray(old)) {
    for (const [key, text] of Object.entries(old as Record<string, unknown>)) if (typeof text === 'string' && text.trim()) out[key] = text
  }
  return out
}

/**
 * Old text-only drafts (`{ [key]: text }`) folded in, each under its old key (a
 * chat's id, or `new:<place>`), so it never lands in another draft. On a load,
 * only keys with no draft yet: the old map may still hold words since sent. When
 * a tab still on the old page writes its map again, against `was` (the last map
 * seen from it), only what that write changed: words that changed are taken, and
 * words it dropped leave a draft that still holds them, but only when the write is
 * plainly a send or a move from that map (nothing else changed, or the only other
 * change is a new key holding exactly the dropped words). A write that changes
 * anything else is taken as a second old tab's, which never had those keys, so it
 * clears nothing (a second old tab sending a draft only it had still reads as a
 * send). The first time, each new-chat draft is what its place's composer shows.
 */
export function foldLegacy(s: DraftState, legacy: string | null, was: string | null, now: number): DraftState {
  const map = readLegacy(legacy)
  const before = was === null ? null : readLegacy(was)
  let next = s
  const first = !Object.keys(s.drafts).length && !Object.keys(s.current).length
  for (const [key, text] of Object.entries(map)) {
    if (before ? before[key] === text : !!next.drafts[key]) continue
    const { place, temporary } = legacyPlace(key)
    next = writeDraft(next, key, { text }, { place, temporary }, now)
    if (first && isNewChatKey(key)) next = { ...next, current: { ...next.current, [placeKey(place, temporary)]: key } }
  }
  if (!before) return next
  const dropped = Object.keys(before).filter((key) => !(key in map))
  const changed = Object.keys(map).filter((key) => before[key] !== map[key])
  const moved = dropped.length === 1 && changed.length === 1 && !(changed[0] in before) && map[changed[0]] === before[dropped[0]]
  if (changed.length && !moved) return next
  for (const key of dropped) {
    if (next.drafts[key]?.text === before[key]) next = writeDraft(next, key, { text: '' }, { place: next.drafts[key].place }, now)
  }
  return next
}

export const serializeDrafts = (s: DraftState) => JSON.stringify({ v: 2, drafts: s.drafts, current: s.current })

/**
 * Another tab's save merged into this tab's drafts, three ways: `base` is what
 * that save replaced, so what the other tab changed is told from what this tab
 * changed since. A draft both have keeps the newer copy. One only the other
 * tab has is taken unless this tab removed it (the base had it and the other
 * tab did not change it since). One only this tab has goes only if the other tab
 * removed it (the base had it and this tab did not change it since). Each tab
 * keeps its own composers. `same` is whether the result is exactly the other
 * tab's save, so this tab has nothing to write back.
 */
export function mergeDrafts(local: DraftState, incoming: DraftState, base: DraftState): { state: DraftState; same: boolean } {
  const drafts: Record<string, Draft> = {}
  for (const key of new Set([...Object.keys(local.drafts), ...Object.keys(incoming.drafts)])) {
    const mine = local.drafts[key]
    const there = incoming.drafts[key]
    const was = base.drafts[key]
    let keep: Draft | undefined
    if (mine && there) {
      // Words and files each from the copy that changed them last; a tie goes the same way in every tab.
      const words = later(mine, there, (d) => d.updatedAt, (d) => d.text)
      const files = later(mine, there, filesTime, (d) => d.attachments.map((a) => a.id).join(','))
      keep = words === files ? words : { ...words, attachments: files.attachments, filesAt: filesTime(files) }
    } else if (there) keep = !was || changedAt(there) > changedAt(was) ? there : undefined
    else if (mine) keep = was && changedAt(mine) <= changedAt(was) ? undefined : mine
    if (keep && hasContent(keep)) drafts[key] = keep
  }
  const keys = Object.keys(drafts)
  const same = keys.length === Object.keys(incoming.drafts).length && keys.every((k) => drafts[k] === incoming.drafts[k])
  const unchanged = keys.length === Object.keys(local.drafts).length && keys.every((k) => drafts[k] === local.drafts[k] || sameDraft(drafts[k], local.drafts[k]))
  return { state: unchanged ? local : { ...local, drafts }, same }
}

const sameDraft = (a: Draft, b: Draft | undefined) => !!b && a.updatedAt === b.updatedAt && filesTime(a) === filesTime(b) && a.text === b.text && sameAttachments(a.attachments, b.attachments)
const filesTime = (d: Draft) => d.filesAt ?? d.updatedAt
/** Of two copies, the one changed later; on a tie the newer-made, then by `value`, else `b`. */
function later(a: Draft, b: Draft, at: (d: Draft) => number, value: (d: Draft) => string) {
  if (at(a) !== at(b)) return at(a) > at(b) ? a : b
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? a : b
  return value(a) > value(b) ? a : b
}
const changedAt = (d: Draft) => Math.max(d.updatedAt, filesTime(d))
/** A time after the draft's last change, even if the clock has stepped back (a machine waking). */
const after = (d: Draft, now: number) => Math.max(now, changedAt(d) + 1)

const sameAttachments = (a: Attachment[], b: Attachment[]) => a.length === b.length && a.every((x, i) => x.id === b[i].id)

/**
 * The draft at `key` with new words or uploads. One left with neither is dropped.
 * `at` is where a draft made by this write starts; an existing one stays put.
 */
export function writeDraft(s: DraftState, key: string, patch: { text?: string; attachments?: Attachment[] }, at: { place: DraftPlace; temporary?: boolean }, now: number): DraftState {
  const was = s.drafts[key]
  const text = patch.text ?? was?.text ?? ''
  const attachments = patch.attachments ?? was?.attachments ?? []
  if (was && was.text === text && sameAttachments(was.attachments, attachments)) return s
  const next: Draft = was
    ? { ...was, text, attachments, ...(was.text !== text ? { updatedAt: after(was, now) } : {}), ...(sameAttachments(was.attachments, attachments) ? {} : { filesAt: after(was, now) }) }
    : { key, text, attachments, createdAt: now, updatedAt: now, filesAt: now, place: at.place, ...(at.temporary && at.place.kind === 'home' ? { temporary: true as const } : {}) }
  if (!hasContent(next)) {
    if (!was) return s
    const { [key]: _gone, ...drafts } = s.drafts
    return { ...s, drafts }
  }
  return { ...s, drafts: { ...s.drafts, [key]: next } }
}

/**
 * "New chat" at a place: its draft when that is still empty, else a new one
 * (`mint`), leaving the one with words in it as a row.
 */
export function freshDraft(s: DraftState, place: DraftPlace, temporary: boolean, mint: () => string): DraftState {
  const pk = placeKey(place, temporary)
  if (!hasContent(s.drafts[draftKeyAt(s, place, temporary)])) return s
  return { ...s, current: { ...s.current, [pk]: `new:${mint()}` } }
}

/** Show this new-chat draft in its place's composer. */
export function showDraft(s: DraftState, key: string): DraftState {
  const d = s.drafts[key]
  if (!d) return s
  const pk = placeKey(d.place, !!d.temporary)
  return s.current[pk] === key ? s : { ...s, current: { ...s.current, [pk]: key } }
}

/**
 * A new chat's draft moved to another place (`$` in the composer, "Start in"):
 * the same draft, now shown there; where it was gets a fresh composer. A key
 * named after its old place (`new:home`, `new:project:<id>`) is that place's
 * default, so the draft takes a minted one instead, or both places would show it.
 */
export function moveDraft(s: DraftState, key: string, place: DraftPlace, temporary: boolean, now: number, mint: () => string): DraftState {
  const d = s.drafts[key]
  const to = placeKey(place, temporary)
  const newKey = PLACE_NAMED.test(key) ? `new:${mint()}` : key
  const current = { ...s.current, [to]: newKey }
  for (const [pk, k] of Object.entries(current)) if (k === key && pk !== to) delete current[pk]
  const drafts = { ...s.drafts }
  delete drafts[key]
  if (d) {
    const moved: Draft = { ...d, key: newKey, place, updatedAt: after(d, now) }
    delete moved.temporary
    if (temporary && place.kind === 'home') moved.temporary = true
    drafts[newKey] = moved
  }
  return { drafts, current }
}

/**
 * Discard a draft. If its place's composer was showing it, that composer moves
 * to a fresh draft, so typing there again never brings the discarded one back.
 */
export function discardDraft(s: DraftState, key: string, mint: () => string): { state: DraftState; removed: Draft | null } {
  const r = removeDraft(s, key)
  const d = r.removed
  if (!d || !isNewChatKey(key) || draftKeyAt(s, d.place, !!d.temporary) !== key) return r
  return { ...r, state: { ...r.state, current: { ...r.state.current, [placeKey(d.place, !!d.temporary)]: `new:${mint()}` } } }
}

/** Take a draft out (a send on its way). */
export function removeDraft(s: DraftState, key: string): { state: DraftState; removed: Draft | null } {
  const removed = s.drafts[key] || null
  if (!removed) return { state: s, removed }
  const { [key]: _gone, ...drafts } = s.drafts
  return { state: { ...s, drafts }, removed }
}

/** Undo a discard: refused when the draft has had new words or files since. */
export function undoDiscard(s: DraftState, d: Draft): { state: DraftState; ok: boolean } {
  if (hasContent(s.drafts[d.key])) return { state: s, ok: false }
  return { state: { ...s, drafts: { ...s.drafts, [d.key]: d } }, ok: true }
}

/**
 * A send that failed goes back into its draft. Anything written there since
 * stays, after it, and the files of both are kept.
 */
export function returnDraft(s: DraftState, d: Draft, now: number): DraftState {
  const there = s.drafts[d.key]
  const at = Math.max(after(d, now), there ? after(there, now) : 0)
  if (!hasContent(there)) return { ...s, drafts: { ...s.drafts, [d.key]: { ...d, updatedAt: at, filesAt: at } } }
  const text = [d.text, there!.text].filter((t) => t.trim()).join('\n')
  const attachments = [...d.attachments, ...there!.attachments.filter((a) => !d.attachments.some((b) => b.id === a.id))]
  return { ...s, drafts: { ...s.drafts, [d.key]: { ...there!, text, attachments, updatedAt: at, filesAt: at } } }
}

/** New-chat drafts with something in them, newest first: the panel's rows. */
export function listDrafts(s: DraftState, keep: (d: Draft) => boolean = () => true): Draft[] {
  return Object.values(s.drafts)
    .filter((d) => isNewChatKey(d.key) && hasContent(d) && keep(d))
    .sort((a, b) => b.createdAt - a.createdAt || (a.key < b.key ? -1 : 1))
}

/** Every upload a draft holds, so the bridge keeps it past its orphan sweep. */
export function heldUploadIds(s: DraftState): string[] {
  const ids = new Set<string>()
  for (const d of Object.values(s.drafts)) for (const a of d.attachments) ids.add(a.id)
  return [...ids].sort()
}

/** The first line of a draft's words (a file named in them as its name), or how many files it holds. */
export function draftPreview(d: Pick<Draft, 'text' | 'attachments'>) {
  const line = plainRefs(d.text).trim().split('\n', 1)[0]?.trim()
  if (line) return line
  const n = d.attachments.length
  return `${n} ${n === 1 ? 'attachment' : 'attachments'}`
}

export interface DraftStorage {
  /** Saves the serialized drafts; may throw (a full or blocked store). */
  save: (json: string) => void
  /**
   * What storage holds now, when other tabs share it. Each save first takes in
   * anything saved since this store last knew it, so no save is ever blind.
   */
  read?: () => string | null
  now: () => number
  /** A new draft id (`new:<id>`). */
  mint: () => string
  /** Told once when saving fails; the drafts carry on in memory. */
  onSaveError?: (e: unknown) => void
  /** How long a burst of typing waits before it is saved. */
  delayMs?: number
}

export type DraftStore = ReturnType<typeof createDraftStore>

/**
 * The drafts in memory, saved a beat after each change (`flush` saves at once,
 * for a page closing). A save that throws leaves them working in memory.
 */
export function createDraftStore(initial: DraftState, io: DraftStorage) {
  let state = initial
  const subs = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let saveFailed = false
  // What this store last knew storage to hold: its own save, or another tab's it heard of.
  let seen = io.read?.() ?? null

  /** Take in what other tabs saved since `seen` (a save whose event has not arrived, or ones missed while frozen). */
  function catchUp() {
    const now = io.read?.() ?? null
    if (now === seen) return
    const incoming = readSaved(now)
    if (incoming) {
      const r = mergeDrafts(state, incoming, readSaved(seen) || emptyDrafts())
      if (r.state !== state) { state = r.state; subs.forEach((fn) => fn()) }
    }
    seen = now
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null }
    try {
      catchUp()
      const json = serializeDrafts(state)
      io.save(json)
      seen = json
      saveFailed = false
    } catch (e) {
      if (!saveFailed) io.onSaveError?.(e)
      saveFailed = true
    }
  }
  /** A new state; saved a beat later unless storage already holds it (another tab's save, taken whole). */
  function commit(next: DraftState, save = true) {
    if (next === state) return
    state = next
    if (save && !timer) timer = setTimeout(flush, io.delayMs ?? 300)
    subs.forEach((fn) => fn())
  }

  return {
    get: () => state,
    subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } },
    flush,
    keyAt: (place: DraftPlace, temporary = false) => draftKeyAt(state, place, temporary),
    write(key: string, patch: { text?: string; attachments?: Attachment[] }, at: { place: DraftPlace; temporary?: boolean }) {
      commit(writeDraft(state, key, patch, at, io.now()))
    },
    /** "New chat" at a place; returns the key its composer now shows. */
    fresh(place: DraftPlace, temporary = false) {
      commit(freshDraft(state, place, temporary, io.mint))
      return draftKeyAt(state, place, temporary)
    },
    show(key: string) { commit(showDraft(state, key)) },
    /** Returns the key the draft has at its new place. */
    move(key: string, place: DraftPlace, temporary = false) {
      commit(moveDraft(state, key, place, temporary, io.now(), io.mint))
      return draftKeyAt(state, place, temporary)
    },
    /** Another tab saved `json` over `was` (both v2 records, as a storage event has them). */
    merge(json: string | null, was: string | null) {
      const incoming = readSaved(json)
      if (!incoming) return
      const r = mergeDrafts(state, incoming, readSaved(was) || emptyDrafts())
      seen = json
      commit(r.state, !r.same)
    },
    catchUp,
    /** A tab on the old page wrote its text-only drafts (`json`) over `was`. */
    foldLegacy(json: string | null, was: string | null) { commit(foldLegacy(state, json, was, io.now())) },
    remove(key: string) {
      const r = removeDraft(state, key)
      commit(r.state)
      return r.removed
    },
    discard(key: string) {
      const r = discardDraft(state, key, io.mint)
      commit(r.state)
      return r.removed
    },
    undo(d: Draft) {
      const r = undoDiscard(state, d)
      commit(r.state)
      return r.ok
    },
    putBack(d: Draft) { commit(returnDraft(state, d, io.now())) },
  }
}
