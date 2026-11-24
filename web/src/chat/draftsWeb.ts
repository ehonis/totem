// The web's side of the saved drafts (drafts.ts, and draftsShared.ts for what the
// app does the same way): localStorage, saving as the page closes and merging what
// other tabs save, Undo on a toast, and the React hooks. The iPhone app writes its own.
import { useSyncExternalStore } from 'react'
import { createDraftStore, loadDrafts, hasContent, DRAFTS_STORAGE_KEY, LEGACY_DRAFTS_KEY } from './drafts'
import { createUploadHolds, discardWithUndo, followChatList, openedDraft } from './draftsShared'
import { deleteUpload, holdUploads } from './api'
import { getState as chatState, subscribe as chatSubscribe, listAnswered, openProject, startTaskDraft } from './store'
import { taskHome } from '../work/state'
import { pushError, pushToast } from '../toast'

function readStored(): { v2: string | null; legacy: string | null } {
  try {
    return { v2: localStorage.getItem(DRAFTS_STORAGE_KEY), legacy: localStorage.getItem(LEGACY_DRAFTS_KEY) }
  } catch { return { v2: null, legacy: null } }
}

const stored = readStored()
let legacyLeft = stored.legacy !== null
// The last map a tab on the old page wrote: once this page has removed the key,
// that tab's next write arrives with no old value, and this is what it changed from.
// Kept per tab in sessionStorage, so a reload of this page still knows it.
const LAST_LEGACY_KEY = 'totem.chat.drafts.lastLegacy'
const session = {
  get: () => { try { return sessionStorage.getItem(LAST_LEGACY_KEY) } catch { return null } },
  set: (v: string) => { try { sessionStorage.setItem(LAST_LEGACY_KEY, v) } catch {} },
}
let lastLegacy = stored.legacy ?? session.get()
if (stored.legacy) session.set(stored.legacy)

export const drafts = createDraftStore(loadDrafts(stored.v2, stored.legacy, Date.now()), {
  read: () => readStored().v2,
  save(json) {
    localStorage.setItem(DRAFTS_STORAGE_KEY, json)
    if (legacyLeft) { localStorage.removeItem(LEGACY_DRAFTS_KEY); legacyLeft = false }
  },
  now: () => Date.now(),
  mint: () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`),
  onSaveError: () => pushToast('This browser won’t save drafts right now. They stay until you close the tab.', 'info'),
})
// The old map is folded in and removed, the v2 record written straight away.
if (legacyLeft) drafts.flush()

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', drafts.flush)
  window.addEventListener('beforeunload', drafts.flush)
  // Two tabs in one browser share the drafts: each takes in what the other saved
  // (against what that save replaced), and a tab still on the old page writing
  // the old key is folded in.
  window.addEventListener('storage', (e) => {
    if (e.key === DRAFTS_STORAGE_KEY) drafts.merge(e.newValue, e.oldValue)
    else if (e.key === LEGACY_DRAFTS_KEY && e.newValue) {
      legacyLeft = true
      drafts.foldLegacy(e.newValue, e.oldValue ?? lastLegacy)
      lastLegacy = e.newValue
      session.set(e.newValue)
    }
  })
  // Back from the back/forward cache, this tab missed every save made meanwhile:
  // show what storage holds now at once (its next save would take it in anyway).
  window.addEventListener('pageshow', (e) => { if (e.persisted) drafts.catchUp() })
}

export const useDraftState = () => useSyncExternalStore(drafts.subscribe, drafts.get, drafts.get)
export const useHasDraft = (key: string) => useSyncExternalStore(drafts.subscribe, () => hasContent(drafts.get().drafts[key]), () => false)

// --- the draft the composer shows ------------------------------------------------
// The chat view says which new-chat draft its composer shows, so its row is marked
// and keeps its place; opening a row says which one the view must not replace.
let shown: string | null = null
const shownSubs = new Set<() => void>()
export function setShownDraft(key: string | null) {
  if (shown === key) return
  shown = key
  shownSubs.forEach((fn) => fn())
}
export const useShownDraft = () => useSyncExternalStore((fn) => { shownSubs.add(fn); return () => { shownSubs.delete(fn) } }, () => shown, () => null)

const opened = openedDraft(drafts)
/** The draft a row just opened, once: the chat view arriving there shows it rather than a fresh one. */
export const takeOpenedDraft = opened.take

/** Open a new-chat draft in the composer at its place. */
export function openDraft(key: string) {
  const d = drafts.get().drafts[key]
  if (!d) return
  drafts.show(key)
  opened.set(key)
  window.dispatchEvent(new CustomEvent('totem:draft-opened', { detail: { key, temporary: !!d.temporary } }))
  if (d.place.kind === 'task') startTaskDraft(d.place.id, taskHome(d.place.id) ?? d.place.projectId ?? null)
  else openProject(d.place.kind === 'home' ? null : d.place.id)
}

/** "New chat" from outside the chat view (the panel, the rail, a phone's button): the view starts or reuses a fresh draft. */
export const requestNewChat = () => window.dispatchEvent(new Event('totem:new-chat'))

// --- uploads ------------------------------------------------------------------------
const holds = createUploadHolds(drafts, { hold: holdUploads })
/** Uploads a draft holds that the bridge no longer has. */
export const useMissingUploads = () => useSyncExternalStore(holds.subscribe, holds.missing, holds.missing)

/** Discard a draft, with Undo while the toast shows; its uploads go once the toast has. */
export function discardDraft(key: string) {
  discardWithUndo(drafts, key, {
    show: ({ undo, gone }) => pushToast('Draft discarded', 'info', {
      duration: 5000,
      action: { label: 'Undo', onClick: () => { if (!undo()) pushError('The draft has new content.') } },
      onExpire: gone,
    }),
    release: (id) => { void deleteUpload(id) },
  })
}

let started = false
/** Renew the drafts' uploads now and keep the drafts in step with the chats. Once the bridge is reachable. */
export function startDraftSync() {
  if (started) return
  started = true
  holds.start()
  // A set that never reached the bridge (it was restarting) goes again when the page is back in front.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') holds.renew() })
  followChatList(drafts, { subscribe: chatSubscribe, getState: chatState, listAnswered })
}
