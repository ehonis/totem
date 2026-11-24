// The chat screen's draft (web chat/useChatDrafts.ts; the logic is the shared
// lib/chat/draftsShared.ts): which draft the composer shows, its words, its files
// in the tray, and what happens to it on New chat, "Start in", send, a failed
// follow-up and a discarded unsent message.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { getState, openProject, useChat } from '../../lib/chat/store'
import { draftKeyAt, placeKey } from '../../lib/chat/drafts'
import {
  arrive, keepEdit as keepEditIn, ownedBy, placeFor, placeOfThread, returnFollowUp, returnUnsent, takeForSend as takeOut, trayOf, writeTray,
  type ChatView,
} from '../../lib/chat/draftsShared'
import { pushError } from '../../lib/toast'
import { drafts, useDraftState, useMissingUploads, setShownDraft, takeOpenedDraft, openDraft, onDraftOpened, onNewChatRequest } from './appDrafts'
import type { ComposerHandle, FollowUpPayload } from './Composer'
import type { Attachment, ChatThread, Project } from '../../lib/chat/types'

const NO_FILES: Attachment[] = []
const sameFiles = (a: Attachment[], b: Attachment[]) => a.length === b.length && a.every((x, i) => x.id === b[i].id)
export const fileNames = (list: Attachment[]) => list.map((a) => a.name).join(', ')

export function useChatDrafts({ activeId, active, scopeProject, draftTaskId, draftKind, setDraftKind, composer, focused, editing, onEditFiles, onNewChat }: {
  activeId: string | null
  active: ChatThread | null
  /** The project or folder the drawer is in: a new chat starts there. */
  scopeProject: Project | undefined
  draftTaskId: string | null
  draftKind: 'regular' | 'temporary'
  setDraftKind: (k: 'regular' | 'temporary') => void
  composer: React.RefObject<ComposerHandle | null>
  focused: boolean
  /** A queued message is being edited in the composer: the tray is its files, not the draft's. */
  editing: boolean
  onEditFiles: (list: Attachment[]) => void
  /** "New chat" asked for from outside the screen (the drawer). */
  onNewChat: () => void
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
  // in it stays a row in the drawer. A row opened shows its own draft instead.
  const [freshAsked, setFreshAsked] = useState(0)
  const askFresh = useCallback(() => setFreshAsked((n) => n + 1), [])
  const viewPlace = activeId ? null : placeKey(newPlace, newTemporary)
  const lastView = useRef<ChatView | null>(null)
  useLayoutEffect(() => {
    const was = lastView.current
    lastView.current = { activeId, place: viewPlace, fresh: freshAsked }
    arrive(was, lastView.current, { takeOpened: takeOpenedDraft, keyAt: () => drafts.keyAt(newPlace, newTemporary), fresh: () => drafts.fresh(newPlace, newTemporary) })
  }, [activeId, viewPlace, freshAsked]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onDraftOpened((temporary) => setDraftKind(temporary ? 'temporary' : 'regular')), [setDraftKind])
  const onNewChatRef = useRef(onNewChat)
  onNewChatRef.current = onNewChat
  useEffect(() => onNewChatRequest(() => onNewChatRef.current()), [])
  // The drawer marks the new-chat draft on screen and keeps its row in place.
  useEffect(() => { setShownDraft(focused && !activeId ? draftKey : null) }, [focused, activeId, draftKey])

  /** "Start in" a project: the same draft, words and files, now at that project. */
  function startIn(id: string) {
    setDraftKind('regular')
    const key = drafts.move(draftKey, placeFor({ taskId: null, projectId: id }, getState().projects))
    if (drafts.get().drafts[key]) { openDraft(key); return }
    openProject(id)
  }

  // --- sending ---------------------------------------------------------------
  /**
   * The draft leaves the composer as it is sent. Returns what puts it back if the
   * bridge refuses the message. Files the bridge had lost were not in the tray; say so.
   */
  function takeForSend(): (() => void) | undefined {
    const { putBack, lost } = takeOut(drafts, draftKey, missing)
    if (lost.length) pushError(`Sent without ${fileNames(lost)}: no longer on the server.`)
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
  /**
   * A message that never reached the bridge, discarded (in the open chat) or
   * retried and refused (`refusedIn`): its words and files go back into the chat's
   * draft, or, for a new chat the bridge never had, into a new-chat draft where it
   * would have started; a discard opens that one.
   */
  const onDiscarded = (text: string, attachments: Attachment[] = [], refusedIn?: string) => {
    const t = refusedIn ? getState().threads.find((x) => x.id === refusedIn) : active
    if (!t) return
    const live = getState().threads.find((x) => x.id === t.id)
    const { key, kept } = returnUnsent(drafts, { thread: t, live, refusedIn, projects: getState().projects, text, attachments, now: Date.now() })
    if (refusedIn) return
    if (!kept) openDraft(key)
    requestAnimationFrame(() => composer.current?.focus())
  }

  // --- the tray --------------------------------------------------------------
  // The tray is the open draft's files (or a queued message's, while it is
  // edited). The composer says when they change; they go back in whenever the
  // draft or its files change under it (another chat, Undo, a refused send).
  // Files the bridge no longer has never enter it.
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
  const shownKey = useRef(draftKey)
  useLayoutEffect(() => {
    const moved = shownKey.current !== draftKey
    shownKey.current = draftKey
    if (editing) return
    if (!moved && sameFiles(trayFiles, trayRef.current)) return
    if (moved && unfinishedRef.current) pushError('A file that hadn’t finished uploading wasn’t kept with that draft.')
    trayRef.current = trayFiles
    unfinishedRef.current = 0
    // A file only this draft holds is deleted when he removes it from the tray.
    composer.current?.setAttachments(trayFiles, ownedBy(drafts.get(), draftKey))
  }, [draftKey, trayFiles, editing]) // eslint-disable-line react-hooks/exhaustive-deps
  const removeMissing = () => drafts.write(draftKey, { attachments: draftFiles.filter((a) => !missing.has(a.id)) }, at)

  /** Keep a queued message's edit as the chat's draft, unless the chat has one. */
  const keepEdit = (threadId: string, text: string, files: Attachment[]) => keepEditIn(drafts, threadId, text, files, atRef.current)

  return {
    draftKey, input: rec?.text || '', setInput, askFresh, startIn, takeForSend, fromDraft, onDiscarded,
    onAttachmentsChange, showEditFiles, missingFiles, removeMissing, keepEdit,
  }
}
