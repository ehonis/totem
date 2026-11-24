// The app's saved drafts (lib/chat/draftsApp.ts for storage, draftsShared.ts for
// what the web does the same way): one store for the life of the app, kept per
// bridge in the phone's storage and saved as the app leaves the screen; the
// uploads they hold kept on the bridge; Discard with the drawer's Undo line; and
// which new-chat draft the chat screen shows.
import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { router } from 'expo-router'
import { hasContent } from '../../lib/chat/drafts'
import { createAppDrafts, renewWhenActive } from '../../lib/chat/draftsApp'
import { createUploadHolds, discardWithUndo, followChatList, openedDraft } from '../../lib/chat/draftsShared'
import { deleteUpload, holdUploads } from '../../lib/chat/api'
import { getState as chatState, subscribe as chatSubscribe, listAnswered, newId, openProject, startTaskDraft } from '../../lib/chat/store'
import { getBaseUrl, subscribeConnection } from '../../lib/connection'
import { pushError } from '../../lib/toast'
import { taskHome } from '../work/state'
import { showUndo } from '../work/undoDock'

export const drafts = createAppDrafts({
  storage: localStorage,
  appState: AppState,
  bridge: getBaseUrl,
  onBridgeChange: (fn) => { subscribeConnection(fn) },
  now: () => Date.now(),
  mint: newId,
  onSaveError: () => pushError('This phone won’t save drafts right now. They stay until the app is closed.'),
})

export const useDraftState = () => useSyncExternalStore(drafts.subscribe, drafts.get, drafts.get)
export const useHasDraft = (key: string) => useSyncExternalStore(drafts.subscribe, () => hasContent(drafts.get().drafts[key]), () => false)
/** Something derived from the drafts, re-rendering only when it changes (not on every keystroke). */
export const useDraftsSnapshot = (read: () => string) => useSyncExternalStore(drafts.subscribe, read, read)

// --- the draft the chat screen shows ------------------------------------------------
// The chat screen says which new-chat draft its composer shows, so its row is
// marked and keeps its place; opening a row says which one it must not replace.
let shown: string | null = null
const shownSubs = new Set<() => void>()
export function setShownDraft(key: string | null) {
  if (shown === key) return
  shown = key
  shownSubs.forEach((fn) => fn())
}
export const useShownDraft = () => useSyncExternalStore((fn) => { shownSubs.add(fn); return () => { shownSubs.delete(fn) } }, () => shown, () => null)

const opened = openedDraft(drafts)
/** The draft a row just opened, once: the chat screen arriving there shows it rather than a fresh one. */
export const takeOpenedDraft = opened.take
/** Whether that draft is a temporary chat's: the chat screen drawn for the first time (a cold start) starts there. */
export const openedIsTemporary = opened.temporary

// A row opened (temporary or not) and "New chat" from outside the chat screen.
const openedSubs = new Set<(temporary: boolean) => void>()
export const onDraftOpened = (fn: (temporary: boolean) => void) => { openedSubs.add(fn); return () => { openedSubs.delete(fn) } }
const newChatSubs = new Set<() => void>()
// Asked before the chat screen was first drawn (a home-screen quick action on a cold start).
let newChatWaiting = false
export function onNewChatRequest(fn: () => void) {
  newChatSubs.add(fn)
  if (newChatWaiting) { newChatWaiting = false; fn() }
  return () => { newChatSubs.delete(fn) }
}
/** "New chat" from the drawer or a top bar: the chat screen starts or reuses a fresh draft. */
export function requestNewChat() {
  if (!newChatSubs.size) newChatWaiting = true
  newChatSubs.forEach((fn) => fn())
}

/** Open a new-chat draft in the chat screen's composer, at its place. */
export function openDraft(key: string) {
  const d = drafts.get().drafts[key]
  if (!d) return
  drafts.show(key)
  opened.set(key)
  openedSubs.forEach((fn) => fn(!!d.temporary))
  if (d.place.kind === 'task') startTaskDraft(d.place.id, taskHome(d.place.id) ?? d.place.projectId ?? null)
  else openProject(d.place.kind === 'home' ? null : d.place.id)
  router.navigate('/chat')
}

// --- uploads ------------------------------------------------------------------------
const holds = createUploadHolds(drafts, { hold: holdUploads })
/** Uploads a draft holds that the bridge no longer has. */
export const useMissingUploads = () => useSyncExternalStore(holds.subscribe, holds.missing, holds.missing)

/** Discard a draft, with Undo in the drawer's foot; its uploads go once the line has. */
export function discardDraft(key: string) {
  discardWithUndo(drafts, key, {
    show: ({ undo, gone }) => showUndo({
      id: Date.now(),
      text: 'Draft discarded',
      action: { label: 'Undo', run: () => { if (!undo()) pushError('The draft has new content.') } },
      onGone: gone,
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
  renewWhenActive(AppState, holds)
  followChatList(drafts, { subscribe: chatSubscribe, getState: chatState, listAnswered })
}
