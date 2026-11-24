// What the web and the iPhone app do with saved drafts beyond the store itself
// (drafts.ts): where a chat's draft lives, the uploads the bridge keeps for them,
// Discard with Undo, the chats that are gone, the panel's rows, and the chat
// view's draft on send, on a refusal and on arriving somewhere new. Each side
// keeps only its storage, how it shows Undo, and its React wiring
// (draftsWeb.ts and useChatDrafts.ts here; draftsApp.ts and the app's hook there).
//
// No DOM and no storage: the iPhone app copies this file byte for byte.
import {
  draftPreview, hasContent, heldUploadIds, isNewChatKey, listDrafts,
  type Draft, type DraftPlace, type DraftState, type DraftStore,
} from './drafts.ts'
import type { Attachment, ChatThread, Project } from './types'

type Places = Pick<Project, 'id' | 'parentId'>[]

/** Where a chat's draft would start again: its task, its project or folder, else Home. */
export function placeOfThread(t: Pick<ChatThread, 'projectId' | 'taskId'>, projects: Places): DraftPlace {
  const p = t.projectId ? projects.find((x) => x.id === t.projectId) : undefined
  if (t.taskId) return { kind: 'task', id: t.taskId, ...(p ? { projectId: p.id } : {}) }
  return p ? { kind: p.parentId ? 'folder' : 'project', id: p.id } : { kind: 'home' }
}

/** Where a new chat starts: for a task (in its folder), in a project or folder, else Home. */
export function placeFor(next: { taskId: string | null; projectId: string | null }, projects: Places): DraftPlace {
  if (next.taskId) return { kind: 'task', id: next.taskId, ...(next.projectId ? { projectId: next.projectId } : {}) }
  if (!next.projectId) return { kind: 'home' }
  return { kind: projects.find((p) => p.id === next.projectId)?.parentId ? 'folder' : 'project', id: next.projectId }
}

// --- uploads --------------------------------------------------------------------------
/**
 * The bridge deletes an upload no message uses a day after it was made, unless a
 * draft holds it: every id the drafts hold is named to the bridge at start and a
 * beat after that set changes, and an id the bridge no longer has is "missing".
 * A set that failed to reach the bridge is sent again on `renew` (the page or app
 * back in front), since nothing else would send it while the set stays the same.
 */
export function createUploadHolds(store: DraftStore, { hold, delayMs = 1000 }: {
  hold: (ids: string[]) => Promise<{ held: string[]; missing: string[] }>
  delayMs?: number
}) {
  let sent = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let missing = new Set<string>()
  const subs = new Set<() => void>()
  function sync(delay: number) {
    const ids = heldUploadIds(store.get())
    const sig = ids.join(',')
    if (timer) { clearTimeout(timer); timer = null }
    if (sig === sent) return
    timer = setTimeout(() => {
      timer = null
      if (!ids.length) { sent = sig; return }
      hold(ids).then((r) => {
        sent = sig
        const next = new Set([...missing, ...r.missing].filter((id) => ids.includes(id)))
        if (next.size !== missing.size || [...next].some((id) => !missing.has(id))) {
          missing = next
          subs.forEach((fn) => fn())
        }
      }).catch(() => {})
    }, delay)
  }
  return {
    /** Send now, then a beat after every change; returns what stops following changes. */
    start() {
      sync(0)
      return store.subscribe(() => sync(delayMs))
    },
    /** Send now if the last set never reached the bridge. */
    renew: () => sync(0),
    missing: () => missing,
    subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } },
  }
}

/**
 * Discard a draft, with Undo while `show`'s line or toast is up. Its uploads that no
 * other draft holds are deleted once that has gone without Undo (`gone`), or when
 * Undo is refused because the draft has new words or files since (`undo` answers
 * false). If its place's composer was showing it, that composer moves to a fresh
 * draft, and Undo moves it back while that one is still empty.
 */
export function discardWithUndo(store: DraftStore, key: string, { show, release }: {
  show: (line: { undo: () => boolean; gone: () => void }) => void
  release: (uploadId: string) => void
}) {
  const d = store.get().drafts[key]
  if (!d) return
  const shown = store.keyAt(d.place, !!d.temporary) === key
  const removed = store.discard(key)!
  const fresh = shown ? store.keyAt(d.place, !!d.temporary) : null
  let settled = false
  const releaseUnshared = () => {
    const still = new Set(heldUploadIds(store.get()))
    for (const a of removed.attachments) if (!still.has(a.id)) release(a.id)
  }
  show({
    undo() {
      if (settled) return true
      settled = true
      if (store.undo(removed)) {
        if (fresh && store.keyAt(removed.place, !!removed.temporary) === fresh && !hasContent(store.get().drafts[fresh])) store.show(removed.key)
        return true
      }
      releaseUnshared()
      return false
    },
    gone() {
      if (settled) return
      settled = true
      releaseUnshared()
    },
  })
}

/**
 * A chat that is gone (deleted, or a temporary one past midnight) takes its draft
 * with it, judged only against a list the bridge answered, never a failed one.
 * Its uploads are left alone: their hold lapses on its own.
 */
export function followChatList(store: DraftStore, chat: {
  subscribe: (fn: () => void) => () => void
  getState: () => { threads: Pick<ChatThread, 'id'>[]; runs: Record<string, unknown> }
  listAnswered: () => number
}) {
  let swept = 0
  const sweep = () => {
    const answered = chat.listAnswered()
    if (!answered || answered === swept) return
    swept = answered
    const s = chat.getState()
    const known = new Set(s.threads.map((t) => t.id))
    for (const d of Object.values(store.get().drafts)) {
      if (!isNewChatKey(d.key) && !known.has(d.key) && !s.runs[d.key]) store.remove(d.key)
    }
  }
  sweep()
  return chat.subscribe(sweep)
}

// --- the panel's rows -------------------------------------------------------------------
export interface DraftRow {
  key: string
  /** The first line of its words, or how many files it holds. */
  preview: string
  /** Where it will start: its project or folder, else Home or a temporary chat. */
  place: string
  icon: 'task' | 'project' | 'home' | 'temporary'
  project?: Project
  /** The draft in the composer on screen. */
  active: boolean
}

/** Whether a draft belongs in this list: Home lists every draft, a project its own and its folders'. */
function inScope(d: Draft, scope: Set<string> | null) {
  if (!scope) return true
  const id = d.place.kind === 'home' ? null : d.place.kind === 'task' ? d.place.projectId : d.place.id
  return !!id && scope.has(id)
}

/**
 * The drafts to list: new-chat drafts with something in them, newest first. The
 * one on screen (`shown`) is listed only if it already had words or files when it
 * was opened (`listedOnArrival`), so starting to type in a fresh one never adds a
 * row; rows keep their order (by when each was started) while he types.
 */
export function draftRows(s: DraftState, { projects, projectId, shown, listedOnArrival }: {
  projects: Project[]
  /** The list's project; null is Home. */
  projectId: string | null
  shown: string | null
  listedOnArrival: boolean
}): DraftRow[] {
  const scope = projectId ? new Set([projectId, ...projects.filter((p) => p.parentId === projectId).map((p) => p.id)]) : null
  const byId = new Map(projects.map((p) => [p.id, p]))
  return listDrafts(s, (d) => inScope(d, scope) && (d.key !== shown || listedOnArrival)).map((d) => {
    const pid = d.place.kind === 'home' ? undefined : d.place.kind === 'task' ? d.place.projectId : d.place.id
    const project = pid ? byId.get(pid) : undefined
    return {
      key: d.key,
      preview: draftPreview(d),
      place: project?.name || (d.temporary ? 'Temporary chat' : 'Home'),
      icon: d.place.kind === 'task' ? 'task' : project ? 'project' : d.temporary ? 'temporary' : 'home',
      ...(project ? { project } : {}),
      active: d.key === shown,
    }
  })
}

/** The rows' identity and words, for subscribing to the rows rather than to every keystroke's state. */
export const rowsSignature = (rows: DraftRow[]) => rows.map((r) => `${r.key}\u0000${r.preview}\u0000${r.place}\u0000${r.icon}\u0000${r.active}`).join('\u0001')

/** Each chat's unsent draft as its preview, by chat id. */
export function chatDraftPreviews(s: DraftState): Record<string, string> {
  const out: Record<string, string> = {}
  for (const d of Object.values(s.drafts)) if (!isNewChatKey(d.key) && hasContent(d)) out[d.key] = draftPreview(d)
  return out
}

// --- the chat view's draft ----------------------------------------------------------------
/** The draft a row just opened, held until the chat view arrives there and takes it. */
export function openedDraft(store: DraftStore) {
  let key: string | null = null
  return {
    set(k: string) { key = k },
    take() { const k = key; key = null; return k },
    /** Whether it is a temporary chat's: a chat view drawn for the first time starts on that composer. */
    temporary: () => !!(key && store.get().drafts[key]?.temporary),
  }
}

export interface ChatView { activeId: string | null; place: string | null; fresh: number }

/**
 * The chat view moved (another chat or place, or New chat asked for). Arriving at a
 * place from somewhere else, or New chat, shows that place's draft while it is
 * still empty, else a fresh one; a row that just opened a draft (`takeOpened`)
 * keeps that one. The first view takes any opened draft, already in the composer.
 */
export function arrive(was: ChatView | null, now: ChatView, { takeOpened, keyAt, fresh }: {
  takeOpened: () => string | null
  keyAt: () => string
  fresh: () => void
}) {
  if (!was) { takeOpened(); return }
  const asked = was.fresh !== now.fresh
  if (!asked && was.activeId === now.activeId && was.place === now.place) return
  const opened = takeOpened()
  if (now.activeId) return
  if (!asked && opened && opened === keyAt()) return
  fresh()
}

/**
 * The draft leaves the composer as it is sent: what puts it back if the bridge
 * refuses the message, and the files it held that the bridge had lost.
 */
export function takeForSend(store: DraftStore, key: string, missing: Set<string>): { putBack?: () => void; lost: Attachment[] } {
  const held = store.remove(key)
  return { ...(held ? { putBack: () => store.putBack(held) } : {}), lost: (held?.attachments || []).filter((a) => missing.has(a.id)) }
}

/** A follow-up (queue, steer) that failed after he moved to another chat goes back into the draft it came from. */
export function returnFollowUp(store: DraftStore, key: string, place: DraftPlace, p: { text: string; attachments: Attachment[] }, now: number) {
  store.putBack({ key, text: p.text, attachments: p.attachments, createdAt: now, updatedAt: now, place })
}

/**
 * A message that never reached the bridge, discarded or retried and refused
 * (`refusedIn`): its words and files go back into the chat's draft when the bridge
 * has the chat (`live` with messages of its own), else into a new-chat draft where
 * it would have started: a row of its own for a refusal, the place's composer for a
 * discard. Returns that draft's key, and whether it was the chat's own.
 */
export function returnUnsent(store: DraftStore, { thread, live, refusedIn, projects, text, attachments, now }: {
  thread: Pick<ChatThread, 'id' | 'kind' | 'projectId' | 'taskId'>
  live: Pick<ChatThread, 'messageCount' | 'messages'> | undefined
  refusedIn?: string
  projects: Places
  text: string
  attachments: Attachment[]
  now: number
}): { key: string; kept: boolean } {
  const place = placeOfThread(thread, projects)
  const temp = thread.kind === 'temporary'
  // A refused new chat lingers in the list until the next sync; only its own messages are local.
  const kept = !!live && (!refusedIn || !!live.messageCount || live.messages.some((m) => !m.id.startsWith('local-')))
  const key = kept ? thread.id : refusedIn ? `new:refused-${thread.id}` : store.fresh(place, temp)
  store.putBack({ key, text, attachments, createdAt: now, updatedAt: now, place, ...(temp && place.kind === 'home' ? { temporary: true as const } : {}) })
  return { key, kept }
}

/** The draft's files for the tray: those the bridge still has, and those it lost. */
export function trayOf(files: Attachment[], missing: Set<string>) {
  const lost = files.filter((a) => missing.has(a.id))
  return { tray: lost.length ? files.filter((a) => !missing.has(a.id)) : files, lost }
}

/** The tray changed: the draft's files are the tray's, plus the lost ones it still names. */
export function writeTray(store: DraftStore, key: string, tray: Attachment[], missing: Set<string>, at: { place: DraftPlace; temporary?: boolean }) {
  const kept = (store.get().drafts[key]?.attachments || []).filter((a) => missing.has(a.id) && !tray.some((b) => b.id === a.id))
  store.write(key, { attachments: [...tray, ...kept] }, at)
}

/** Files only this draft holds: removing one from the tray deletes it. */
export function ownedBy(s: DraftState, key: string): (a: Attachment) => boolean {
  const others = new Set(Object.values(s.drafts).filter((d) => d.key !== key).flatMap((d) => d.attachments.map((a) => a.id)))
  return (a) => !others.has(a.id)
}

/** A queued message's edit, kept as the chat's draft when the chat has none. */
export function keepEdit(store: DraftStore, threadId: string, text: string, files: Attachment[], at: { place: DraftPlace }) {
  if (hasContent(store.get().drafts[threadId])) return false
  store.write(threadId, { text, attachments: files }, at)
  return true
}
