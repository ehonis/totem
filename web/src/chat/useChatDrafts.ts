// The chat view's draft (drafts.ts): which draft the composer shows, its words,
// its files in the tray, and what happens to it on New chat, `$`, send, a failed
// follow-up and a discarded unsent message.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { getState, openProject, startTaskDraft, useChat } from './store'
import { draftKeyAt, placeKey } from './drafts'
import {
  arrive, keepEdit as keepEditIn, ownedBy, placeFor, placeOfThread, returnFollowUp, returnUnsent, takeForSend as takeOut, trayOf, writeTray,
  type ChatView,
} from './draftsShared'
import { drafts, useDraftState, useMissingUploads, setShownDraft, takeOpenedDraft, openDraft } from './draftsWeb'
import { placeAfter, type Destination } from './destinations'
import { taskHome } from '../work/state'
import { pushToast } from '../toast'
import type { ComposerHandle, FollowUpPayload } from './Composer'
import type { Attachment, ChatThread, Project } from './types'

const NO_FILES: Attachment[] = []
const sameFiles = (a: Attachment[], b: Attachment[]) => a.length === b.length && a.every((x, i) => x.id === b[i].id)
export const fileNames = (list: Attachment[]) => list.map((a) => a.name).join(', ')

export function useChatDrafts({ activeId, active, scopeProject, draftTaskId, draftKind, setDraftKind, composer, slot, visible, editing, onEditFiles }: {
  activeId: string | null
  active: ChatThread | null
  /** The project or folder the panel is in: a new chat starts there. */
  scopeProject: Project | undefined
  draftTaskId: string | null
  draftKind: 'regular' | 'temporary'
  setDraftKind: (k: 'regular' | 'temporary') => void
  composer: React.RefObject<ComposerHandle>
  /** Where the composer is mounted ('' when not), so a remounted one gets its files back. */
  slot: string
  visible: boolean
  /** A queued message is being edited in the composer: the tray is its files, not the draft's. */
  editing: boolean
  onEditFiles: (list: Attachment[]) => void
}) {
  const state = useDraftState()
  const missing = useMissingUploads()
  const projects = useChat((s) => s.projects)
  const newPlace = useMemo(() => placeFor({ taskId: draftTaskId, projectId: scopeProject?.id ?? null }, projects), [draftTaskId, scopeProject?.id, scopeProject?.parentId]) // eslint-disable-line react-hooks/exhaustive-deps
  const newTemporary = !scopeProject && !draftTaskId && draftKind === 'temporary'
  const draftKey = activeId || draftKeyAt(state, newPlace, newTemporary)
  const rec = state.drafts[draftKey]
  const at = useMemo(() => (active ? { place: placeOfThread(active, projects) } : { place: newPlace, temporary: newTemporary }), [active?.id, active?.projectId, active?.taskId, projects, newPlace, newTemporary]) // eslint-disable-line react-hooks/exhaustive-deps
  const keyRef = useRef(draftKey)
  keyRef.current = draftKey
  const atRef = useRef(at)
  atRef.current = at

  const setInput = useCallback((v: string) => drafts.write(keyRef.current, { text: v }, atRef.current), [])

  // --- New chat --------------------------------------------------------------
  // "New chat" (anywhere) and arriving at a place from a chat or another place show
  // that place's draft if it is still empty, else a fresh one; the draft with words
  // in it stays a row in the panel. A row opened shows its own draft instead.
  const [freshAsked, setFreshAsked] = useState(0)
  const askFresh = useCallback(() => setFreshAsked((n) => n + 1), [])
  const viewPlace = activeId ? null : placeKey(newPlace, newTemporary)
  const lastView = useRef<ChatView | null>(null)
  useLayoutEffect(() => {
    const was = lastView.current
    lastView.current = { activeId, place: viewPlace, fresh: freshAsked }
    arrive(was, lastView.current, { takeOpened: takeOpenedDraft, keyAt: () => drafts.keyAt(newPlace, newTemporary), fresh: () => drafts.fresh(newPlace, newTemporary) })
  }, [activeId, viewPlace, freshAsked]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onOpened = (e: Event) => setDraftKind((e as CustomEvent<{ temporary: boolean }>).detail.temporary ? 'temporary' : 'regular')
    window.addEventListener('totem:draft-opened', onOpened)
    return () => window.removeEventListener('totem:draft-opened', onOpened)
  }, [setDraftKind])
  // The panel marks the new-chat draft on screen and keeps its row in place.
  useEffect(() => { setShownDraft(visible && !activeId ? draftKey : null) }, [visible, activeId, draftKey])

  // --- moving a new chat's draft (`$`, "Start in") -----------------------------
  function placeDraft(next: { taskId: string | null; projectId: string | null }) {
    setDraftKind('regular')
    const key = drafts.move(draftKey, placeFor(next, getState().projects))
    if (drafts.get().drafts[key]) { openDraft(key); return }
    if (next.taskId) startTaskDraft(next.taskId, next.projectId)
    else openProject(next.projectId)
  }
  const startIn = (id: string) => placeDraft({ taskId: null, projectId: id })
  /** A task picked in the chats panel: what he has typed in a new chat goes with it, as with `$`. */
  const startForTask = (ref: string) => {
    // Beside an open chat (the side panel) the composer holds that chat's own draft, which stays with it.
    if (activeId) { startTaskDraft(ref, taskHome(ref)); return }
    placeDraft({ taskId: ref, projectId: taskHome(ref) })
  }
  /** `$`: the words, less the `$…`, and the tray's files go to the picked place. */
  const pickDestination = (d: Destination, text: string) => {
    drafts.write(draftKey, { text }, at)
    placeDraft(placeAfter(d, { taskId: draftTaskId, projectId: scopeProject?.id ?? null }, taskHome))
    requestAnimationFrame(() => composer.current?.focus())
  }

  // --- sending ---------------------------------------------------------------
  /**
   * The draft leaves the composer as it is sent. Returns what puts it back if the
   * bridge refuses the message. Files the bridge had lost were not in the tray; say so.
   */
  function takeForSend(): (() => void) | undefined {
    const { putBack, lost } = takeOut(drafts, draftKey, missing)
    if (lost.length) pushToast(`Sent without ${fileNames(lost)}: no longer on the server.`, 'info')
    return putBack
  }
  /** A follow-up (queue, steer) that fails after he moved to another chat goes back into the draft it came from. */
  const fromDraft = (fn: (p: FollowUpPayload) => Promise<boolean> | boolean) => async (p: FollowUpPayload) => {
    const key = keyRef.current
    const place = atRef.current.place
    const ok = await fn(p)
    if (ok || keyRef.current === key) return ok
    returnFollowUp(drafts, key, place, p, Date.now())
    return true
  }
  // A message that never reached the bridge, discarded (in the open chat) or
  // retried and refused (`refusedIn`): its words and files go back into the chat's
  // draft, or, for a new chat the bridge never had, into a new-chat draft where it
  // would have started; a discard opens that one. Stable, so the message log stays memoized.
  const activeRef = useRef(active)
  activeRef.current = active
  const onDiscarded = useCallback((text: string, attachments: Attachment[] = [], refusedIn?: string) => {
    const t = refusedIn ? getState().threads.find((x) => x.id === refusedIn) : activeRef.current
    if (!t) return
    const live = getState().threads.find((x) => x.id === t.id)
    const { key, kept } = returnUnsent(drafts, { thread: t, live, refusedIn, projects: getState().projects, text, attachments, now: Date.now() })
    if (refusedIn) return
    if (!kept) openDraft(key)
    requestAnimationFrame(() => composer.current?.focus())
  }, [composer])

  // --- the tray --------------------------------------------------------------
  // The tray is the open draft's files (or a queued message's, while it is
  // edited). The composer says when they change; they go back in whenever the
  // draft, its files or the composer itself change under it (another chat, a
  // remount, Undo). Files the bridge no longer has never enter it.
  const trayRef = useRef<Attachment[]>(NO_FILES)
  const unfinishedRef = useRef(0)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const missingRef = useRef(missing)
  missingRef.current = missing
  const onEditFilesRef = useRef(onEditFiles)
  onEditFilesRef.current = onEditFiles
  const onAttachmentsChange = useCallback((list: Attachment[], unfinished: number) => {
    trayRef.current = list
    unfinishedRef.current = unfinished
    if (editingRef.current) { onEditFilesRef.current(list); return }
    writeTray(drafts, keyRef.current, list, missingRef.current, atRef.current)
  }, [])
  /** Put a queued message's files in the tray for editing. */
  const showEditFiles = (files: Attachment[]) => {
    trayRef.current = files
    composer.current?.setAttachments(files)
  }
  const draftFiles = rec?.attachments || NO_FILES
  const { tray: trayFiles, lost: missingFiles } = useMemo(() => trayOf(draftFiles, missing), [draftFiles, missing])
  const shownIn = useRef({ slot: '', key: draftKey })
  useLayoutEffect(() => {
    const was = shownIn.current
    shownIn.current = { slot, key: draftKey }
    if (was.slot !== slot) { trayRef.current = NO_FILES; unfinishedRef.current = 0 }
    if (!slot || editing) return
    const moved = was.key !== draftKey
    if (!moved && sameFiles(trayFiles, trayRef.current)) return
    if (moved && unfinishedRef.current) pushToast('A file that hadn’t finished uploading wasn’t kept with that draft.', 'info')
    trayRef.current = trayFiles
    unfinishedRef.current = 0
    // A file only this draft holds is deleted when he removes it from the tray.
    composer.current?.setAttachments(trayFiles, ownedBy(drafts.get(), draftKey))
  }, [draftKey, trayFiles, slot, editing]) // eslint-disable-line react-hooks/exhaustive-deps
  const removeMissing = () => drafts.write(draftKey, { attachments: draftFiles.filter((a) => !missing.has(a.id)) }, at)

  /** Keep a queued message's edit as the chat's draft, unless the chat has one. */
  const keepEdit = (threadId: string, text: string, files: Attachment[]) => keepEditIn(drafts, threadId, text, files, atRef.current)

  return {
    draftKey, input: rec?.text || '', setInput, askFresh, startIn, startForTask, pickDestination, takeForSend, fromDraft, onDiscarded,
    onAttachmentsChange, showEditFiles, missingFiles, removeMissing, keepEdit,
  }
}
