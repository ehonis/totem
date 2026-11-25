import React, { Suspense, forwardRef, lazy, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Hi } from '../icons'
import { getChatCommands, subscribeChatCommands } from '../studio'
import { pushError } from '../toast'
import { useSettings } from '../settings'
import { cutSelection, listEnter, listIndentLines, messageText } from './editor/markdown'
import { deleteUpload, transcribe, uploadFile } from './api'
import { AttachmentChip, useMentionSet } from './Message'
import { insertMention, mentionAtCaret } from './mentions'
import { attachmentRef, editableRefs, formatSize, refIds, splitRefs } from './refs'
import type { ChipInfo } from './RefChip'
import type { PromptEditorHandle } from './editor/PromptEditor'
import { rankDestinations, stripToken, type Destination } from './destinations'
import { readNewTask, type NewTaskFields } from './newTask'
import NewTaskBar from './NewTaskBar'
import { folderNames } from '../todos/folders'
import ProjectIcon from './ProjectIcon'
import { ensureModels, useChat } from './store'
import { getWork, subscribeWork } from '../work/state'
import { dueLabel } from '../work/groups'
import { micUnavailableReason, openMic, closeMic, recordUntilStopped } from './recorder'
import type { Attachment, DraftAttachment, ModelRow, Project, ProviderRow } from './types'
import type { Answering } from './QuestionsPanel'
import { TI, ProviderLogo, useDismiss } from './ui'
import {
  IconArrowUp, IconPlayerStopFilled, IconPlus, IconPaperclip, IconPhoto, IconMicrophone, IconWaveSine,
  IconSparkles, IconX, IconCheck, IconLoader2, IconCornerUpRight, IconPuzzle, IconPlaylistAdd, IconPlayerPlayFilled,
  IconHome, IconChecklist, IconTable, IconFolder, IconFolderPlus, IconGhost2, IconPinned, IconZzz, IconArrowsDiagonalMinimize2, IconArrowsDiagonal, IconSquarePlus,
} from './icons'
import { formatContextTokens } from './context'
import type { ChatCommand } from '../studio'

// A paste this long becomes a chip instead of filling the box. The text is sent
// in full either way; the chip is about being able to see your own question.
const PASTE_CHIP_CHARS = 1800
const PASTE_CHIP_LINES = 30

// TipTap is the composer's largest dependency: its own chunk, fetched as soon as this file loads.
const editorChunk = import('./editor/PromptEditor')
const PromptEditor = lazy(() => editorChunk)

/** A tray item. `hidden`: its chip was deleted from the text, kept while undo can bring it back. */
type Draft = DraftAttachment & { progress?: number; hidden?: boolean }

export interface ComposerHandle {
  addFiles: (files: File[] | FileList) => void
  /** An upload that already exists (Search's "Add to chat"). */
  addAttachment: (a: Attachment) => void
  /** The box's finished uploads, taken out of it (not deleted): a queued edit stashes the draft. */
  takeAttachments: () => Attachment[]
  /**
   * Put uploads in the box in place of what is there (a queued message being edited, a draft opened).
   * Those `own` says are the draft's alone are deleted when removed, as a fresh upload is.
   */
  setAttachments: (list: Attachment[], own?: (a: Attachment) => boolean) => void
  focus: () => void
}

export type FollowUp = 'queue' | 'steer'
export interface FollowUpPayload { text: string; attachments: Attachment[] }

export interface ComposerProps {
  value: string
  onChange: (v: string) => void
  /**
   * The box's finished uploads changed, or how many are still uploading or failed
   * (not on mounting): they belong to the open draft (chat/drafts.ts).
   */
  onAttachmentsChange?: (attachments: Attachment[], unfinished: number) => void
  onSend: (payload: { text: string; attachments: Attachment[] }) => void
  onStop: () => void
  /**
   * A message while the reply is still running (T3 Code's follow-ups): it waits
   * its turn (`onQueue`) or the agent takes it in mid-turn (`onSteer`). Enter does
   * `followUp`, Ctrl/⌘ the other. Resolves false when it could not be sent, and
   * the words and files go back in the box.
   */
  onSteer?: (p: FollowUpPayload) => Promise<boolean> | boolean
  onQueue?: (p: FollowUpPayload) => Promise<boolean> | boolean
  followUp?: FollowUp
  /** A queued message is in the box being edited: sending saves it. */
  queueEdit?: { onSave: (p: FollowUpPayload) => Promise<boolean> | boolean }
  /** The queue is held (the last reply was stopped or failed): an empty box offers Resume. */
  onResume?: () => void
  onVoice?: () => void
  busy: boolean
  placeholder?: string
  autoFocus?: boolean
  compact?: boolean
  allowCommands?: boolean
  maxUploadBytes?: number
  onAuthError?: () => void
  /** The model chip and its effort and access menu (T3-style), before the mic and send. */
  rightSlot?: React.ReactNode
  /** After the plus button: how full the chat's context is (ContextMeter.tsx). */
  leftSlot?: React.ReactNode
  /**
   * The next send compacts the idle chat first (T3's Compact idle threads → When
   * you return): a Compact/Keep chip by the send button, and the button says so.
   * `keep` is the owner choosing full history for this send.
   */
  compactSend?: { tokens: number; keep: boolean; onToggle: () => void } | null
  /** Attached to the box's top edge: the queued messages (QueuedMessages.tsx). */
  above?: React.ReactNode
  /**
   * The agent's questions are open (QuestionsPanel.tsx): the box is the typed
   * answer to the one on screen, and the button moves through them.
   */
  answering?: Answering
  /**
   * A chat not started yet: `$` also offers where it goes (a project, a folder,
   * Home) and the tasks it can be for. Picking one takes the `$…` out of the
   * words and hands them over, since they move to the new place's draft.
   * With `onNewTask`, `$task` also turns the box into a task line: Enter makes
   * the task and resolves true once the chat for it has been started.
   */
  destinations?: {
    projectId: string | null
    taskId: string | null
    onPick: (d: Destination, text: string, caret: number) => void
    onNewTask?: (fields: NewTaskFields) => Promise<boolean>
    /** `$opus`: start on this model (the composer's model chip shows it). */
    onModel?: (d: Extract<Destination, { kind: 'model' }>) => void
    /** `$pin`, `$snooze`: how the chat starts, sent with its first message. */
    onStartOption?: (d: Extract<Destination, { kind: 'pin' | 'snooze' }>) => void
    /** Pinned by `$pin` already. */
    pinned?: boolean
    /** The draft on screen: a task line is that draft's, so another draft is a message again. */
    draftKey?: string
  }
}

const coarse = () => window.matchMedia?.('(pointer: coarse)').matches
const modKey = () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+')

/** Whether Ctrl or ⌘ is held, so the follow-up button shows what a click will do. */
function useModifierHeld(on: boolean) {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!on) { setHeld(false); return }
    const read = (e: KeyboardEvent) => setHeld(e.metaKey || e.ctrlKey)
    const clear = () => setHeld(false)
    window.addEventListener('keydown', read)
    window.addEventListener('keyup', read)
    window.addEventListener('blur', clear)
    return () => { window.removeEventListener('keydown', read); window.removeEventListener('keyup', read); window.removeEventListener('blur', clear) }
  }, [on])
  return held
}

let pasteCount = 0

// The tasks are read only while the `$` menu is open (work/state.ts polls while watched).
const noSubscribe = () => () => {}

type MenuItem = { kind: 'dest'; d: Destination } | { kind: 'cmd'; c: ChatCommand }
const itemKey = (it: MenuItem) => (it.kind === 'dest' ? it.d.key : it.c.cmd)
const NO_PROVIDERS: ProviderRow[] = []
const NO_CATALOGS: Record<string, ModelRow[]> = {}
const QUICK = new Set(['new-task', 'ghost', 'pin'])
/** Picks that leave the draft where it is, so a file still uploading doesn't hold them. */
const STAYS = new Set(['new-task', 'model', 'pin', 'snooze'])
const itemGroup = (it: MenuItem) => (it.kind === 'dest' ? (QUICK.has(it.d.kind) ? 'Quick actions' : it.d.kind === 'snooze' ? 'Send it, back later' : it.d.kind === 'model' ? 'Start on a model' : it.d.kind === 'new-folder' ? 'Make a folder' : it.d.kind === 'task' ? 'Start it for a task' : 'Start it in')
  : it.c.kind === 'agent' ? 'Your agent skills' : 'Totem skills')

function destDesc(d: Destination, sheetName: string, here?: Project, forTask = false) {
  if (d.kind === 'new-task') return here ? `Type it here, filed in ${here.name}, then chat about it` : 'Type it here, then start a chat for it'
  if (d.kind === 'ghost') return here || forTask ? 'Not kept: moves to Home, gone at midnight' : 'Not kept: gone at midnight, or as soon as you settle it'
  if (d.kind === 'new-folder') return d.parent ? `New folder in ${d.parent.name}, then start the chat in it` : 'New project, then start the chat in it'
  if (d.kind === 'model') return d.note ? `${d.provider.name} · ${d.note}` : d.provider.name
  if (d.kind === 'pin') return 'Pinned to the top of your chats once it starts'
  if (d.kind === 'snooze') return `Sends now; stays in Snoozed until ${d.when}, even once answered`
  if (d.kind === 'home') return 'Chats in no project'
  if (d.kind === 'project') return d.parent ? `Folder in ${d.parent.name}` : 'Project'
  const due = d.task.dueDate ? dueLabel(d.task.dueDate, new Date()) : null
  const where = d.task.kind === 'sheet' ? sheetName || 'Shared sheet' : 'Task'
  return due ? `${where} · ${due.text}` : where
}

function DestIcon({ d }: { d: Destination }) {
  if (d.kind === 'home') return <TI icon={IconHome} size={16} />
  if (d.kind === 'new-task') return <TI icon={IconSquarePlus} size={16} />
  if (d.kind === 'ghost') return <TI icon={IconGhost2} size={16} />
  if (d.kind === 'new-folder') return <TI icon={IconFolderPlus} size={16} />
  if (d.kind === 'model') return <ProviderLogo driver={d.provider.driver} name={d.provider.name} size={16} />
  if (d.kind === 'pin') return <TI icon={IconPinned} size={16} />
  if (d.kind === 'snooze') return <TI icon={IconZzz} size={16} />
  if (d.kind === 'project') return d.project.icon || d.project.imageUrl ? <ProjectIcon p={d.project} size={16} /> : <TI icon={IconFolder} size={16} />
  return <TI icon={d.task.kind === 'sheet' ? IconTable : IconChecklist} size={16} />
}

/**
 * The menu for a `/` or `$` token: Totem's skills with that prefix, then (for `/`)
 * the owner's agent skills. Names that start with the term come first.
 */
function rankCommands(catalog: ChatCommand[], prefix: string, term: string, alone: boolean) {
  const score = (c: ChatCommand) => {
    const name = c.cmd.slice(1)
    if (name.startsWith(term)) return 0
    if (name.includes(term) || c.title.toLowerCase().includes(term)) return 1
    return -1
  }
  const pick = (list: ChatCommand[]) => list
    .map((c) => ({ c, s: score(c) })).filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s).map((x) => x.c)
  const own = pick(catalog.filter((c) => c.kind !== 'agent' && c.cmd.startsWith(prefix) && (alone || c.mode !== 'fill')))
  const agent = prefix === '/' ? pick(catalog.filter((c) => c.kind === 'agent')) : []
  return [...own, ...agent].slice(0, 40)
}

/**
 * The plain box's selection (message offsets), whether it has focus, whether an IME
 * word is in progress there, and a caret to put it at.
 */
type PlainState = { caret: number; end: number; focused: boolean; want: number | null }

/**
 * The box until the editor is up (its chunk on a cold load or a slow link): a plain
 * textarea on the same value, so nothing typed is lost. Attached files show as
 * `[name]` (refs.ts `editableRefs`). It keeps `state` current on every focus,
 * select, input and blur, for the editor to carry on from when it takes over, and
 * says when an IME word is in progress, so the switch waits for it.
 */
const PlainBox = forwardRef<HTMLTextAreaElement, {
  value: string
  onChange: (v: string) => void
  placeholder: string
  autoFocus: boolean
  state: React.MutableRefObject<PlainState>
  onCaret: (pos: number) => void
  onComposing: (on: boolean) => void
  onKeyDown: (e: KeyboardEvent) => boolean
  onPaste: (e: ClipboardEvent) => boolean
}>(function PlainBox({ value, onChange, placeholder, autoFocus, state, onCaret, onComposing, onKeyDown, onPaste }, ref) {
  const box = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => box.current!, [])
  const shown = useMemo(() => editableRefs(value), [value])
  const record = (el: HTMLTextAreaElement, from = shown) => {
    const caret = from.toValue(el.selectionStart)
    state.current = { ...state.current, caret, end: from.toValue(el.selectionEnd), focused: document.activeElement === el }
    onCaret(caret)
  }
  // A caret the composer asked for (a skill picked from the menu, dictation).
  useLayoutEffect(() => {
    const el = box.current
    const want = state.current.want
    if (!el || want == null) return
    state.current = { ...state.current, want: null }
    const at = shown.toShown(want)
    el.focus()
    el.setSelectionRange(at, at)
  }, [shown, state])
  return (
    <textarea ref={box} className="vc-ed vc-ed-plain" rows={1} aria-label="Message" value={shown.text} placeholder={placeholder} autoFocus={autoFocus}
      onChange={(e) => {
        const next = shown.restore(e.target.value, e.target.selectionStart)
        record(e.target, editableRefs(next))
        onChange(next)
      }}
      onSelect={(e) => record(e.currentTarget)}
      onFocus={(e) => record(e.currentTarget)}
      // Taking the box off the page blurs it too; that one is the handover, not him leaving.
      onBlur={(e) => { if (e.currentTarget.isConnected) state.current = { ...state.current, focused: false } }}
      onCompositionStart={() => onComposing(true)}
      onCompositionEnd={() => onComposing(false)}
      onKeyDown={(e) => {
        // Return that commits an IME word never sends.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (onKeyDown(e.nativeEvent)) e.preventDefault()
      }}
      onPaste={(e) => { if (onPaste(e.nativeEvent)) e.preventDefault() }} />
  )
})

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { value, onChange, onAttachmentsChange, onSend, onStop, onSteer, onQueue, followUp = 'queue', queueEdit, onResume, onVoice, busy, placeholder: idlePlaceholder = 'Ask Totem anything', autoFocus, compact, allowCommands = true, maxUploadBytes = 25 * 1024 * 1024, rightSlot, leftSlot, compactSend, answering, above, destinations } = props
  const ed = useRef<PromptEditorHandle>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const cmdMenuRef = useRef<HTMLDivElement>(null)
  // Where the caret is, so "/" opens the skills menu mid-sentence, not only at the start.
  const [caret, setCaret] = useState(0)
  // The token whose menu Escape closed (its start), so it stays closed while you type on.
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  // The tray item whose × asked first, because the text refers to it.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [sel, setSel] = useState(0)
  // `$task`: the box is a new task's line until Enter makes it (newTask.ts).
  const [taskMode, setTaskMode] = useState(false)
  const [taskIgnore, setTaskIgnore] = useState<string[]>([])
  const [taskBusy, setTaskBusy] = useState(false)
  const projects = useChat((s) => s.projects)
  const canMakeTask = !!destinations?.onNewTask && allowCommands
  const inTask = taskMode && canMakeTask && !answering && !queueEdit
  // Another draft on screen, or the chat started: the box is a message again.
  useEffect(() => { setTaskMode(false); setTaskIgnore([]) }, [destinations?.draftKey, canMakeTask])
  const [dictation, setDictation] = useState<null | { state: 'recording' | 'transcribing'; startedAt: number; level: number }>(null)
  const dictRef = useRef<{ stop: () => Promise<Blob>; cancel: () => void; stream: MediaStream } | null>(null)
  const [, tick] = useState(0)
  const { formatMarkdown } = useSettings()

  useDismiss(menu, menuRef, useCallback(() => setMenu(false), []))
  // The plain box stays on screen, with the editor mounted hidden behind it, until the
  // editor is up and no IME word is in progress there; then the editor carries on
  // from its selection and focus, after the commit that shows it.
  const plainBox = useRef<HTMLTextAreaElement>(null)
  const plain = useRef<PlainState>({ caret: value.length, end: value.length, focused: false, want: null })
  const [editorUp, setEditorUp] = useState(false)
  const [plainComposing, setPlainComposing] = useState(false)
  const onReady = useCallback(() => setEditorUp(true), [])
  const swapped = editorUp && !plainComposing
  const live = useRef(false)
  live.current = swapped
  useLayoutEffect(() => {
    if (!swapped || !plain.current.focused) return
    plain.current = { ...plain.current, focused: false }
    ed.current?.setText(valueRef.current, plain.current.caret, plain.current.end)
  }, [swapped])
  useEffect(() => {
    if (dictation?.state !== 'recording') return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [dictation?.state])

  const valueRef = useRef(value)
  valueRef.current = value
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  // Answers to the agent's questions go by their own path, which reads no chips: files stay in the tray.
  const chipsOff = useRef(false)
  chipsOff.current = !!answering

  /**
   * Upload one file into the tray. With `chip`, a chip for it goes where the caret
   * was (T3 Code's rule: a file always, an image only once there is text to sit in).
   */
  const upload = useCallback((file: Blob, name: string, kind?: 'text', textPreview?: string) => {
    if (file.size > maxUploadBytes) { pushError(`${name} is larger than ${Math.round(maxUploadBytes / 1e6)} MB`); return }
    const key = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const isImage = /^image\//.test(file.type)
    const chip = !chipsOff.current && (!isImage || !!valueRef.current.trim())
    const capture = chip && live.current ? ed.current?.capture() : undefined
    const draft: Draft = {
      key, name, mime: file.type || 'application/octet-stream', size: file.size,
      kind: kind === 'text' ? 'text' : isImage ? 'image' : 'file',
      previewUrl: isImage ? URL.createObjectURL(file) : undefined,
      textPreview, status: 'uploading', progress: 0,
    }
    setDrafts((d) => [...d, draft])
    uploadFile(file, name, { kind, onProgress: (p) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, progress: p } : x))) })
      .then((uploaded) => {
        // Removed from the tray (×, or taken out for a queued edit) while it uploaded: it goes.
        if (!draftsRef.current.some((x) => x.key === key)) {
          capture?.dispose()
          deleteUpload(uploaded.id)
          return
        }
        setDrafts((d) => d.map((x) => (x.key === key ? { ...x, status: 'ready', uploaded } : x)))
        capture?.insert([attachmentRef(uploaded)])
      }, (e) => {
        capture?.dispose()
        setDrafts((d) => d.map((x) => (x.key === key ? { ...x, status: 'error', error: e.message } : x)))
        pushError(e.message)
      })
  }, [maxUploadBytes])

  const addFiles = useCallback((files: File[] | FileList) => {
    for (const f of Array.from(files)) upload(f, f.name || (f.type.startsWith('image/') ? 'image.png' : 'file'))
  }, [upload])

  const addAttachment = useCallback((a: Attachment, own = false) => {
    setDrafts((d) => d.some((x) => x.uploaded?.id === a.id) ? d : [...d, {
      key: `${own ? 'own' : 'ctx'}-${a.id}`, name: a.name, mime: a.mime, size: a.size, kind: a.kind,
      previewUrl: a.kind === 'image' ? a.url : undefined, textPreview: a.preview, status: 'ready', uploaded: a,
    }])
  }, [])

  /**
   * Let tray items go: object URLs freed, and their uploads deleted when `drop`, or
   * when their chip was deleted and no undo can bring it back now.
   */
  const release = useCallback((list: Draft[], drop = false) => {
    for (const d of list) {
      if (d.previewUrl) URL.revokeObjectURL(d.previewUrl)
      // One that was already an upload (Search's, a queued message's) may still be in use there.
      if ((drop || d.hidden) && d.uploaded && !d.key.startsWith('ctx-')) deleteUpload(d.uploaded.id)
    }
  }, [])
  useEffect(() => () => release(draftsRef.current), [release])
  const takeAttachments = useCallback(() => {
    const taken = draftsRef.current.filter((d) => d.status === 'ready' && d.uploaded && !d.hidden).map((d) => d.uploaded!)
    release(draftsRef.current)
    setDrafts([])
    return taken
  }, [release])
  const setAttachments = useCallback((list: Attachment[], own?: (a: Attachment) => boolean) => {
    release(draftsRef.current)
    setDrafts([])
    list.forEach((a) => addAttachment(a, !!own?.(a)))
  }, [addAttachment, release])

  const focusBox = useCallback(() => { if (live.current) ed.current?.focus(); else plainBox.current?.focus() }, [])
  useImperativeHandle(ref, () => ({
    addFiles, addAttachment: (a: Attachment) => addAttachment(a), takeAttachments, setAttachments,
    focus: focusBox,
  }), [addFiles, addAttachment, takeAttachments, setAttachments, focusBox])

  function removeDraft(key: string) {
    setDrafts((d) => {
      const gone = d.find((x) => x.key === key)
      if (gone) release([gone], true)
      return d.filter((x) => x.key !== key)
    })
  }

  /** × on a tray item: one the text names asks first, then takes every chip for it out too. */
  function askRemove(d: Draft) {
    if (d.uploaded && refIds(value).includes(d.uploaded.id)) { setConfirmRemove(d.key); return }
    removeDraft(d.key)
  }
  function confirmRemoval() {
    const d = drafts.find((x) => x.key === confirmRemove)
    setConfirmRemove(null)
    if (!d) return
    const id = d.uploaded?.id
    if (id && live.current && ed.current) ed.current.removeRefs(id)
    else if (id) onChange(splitRefs(value).filter((p) => p.ref?.id !== id).map((p) => p.text).join(''))
    removeDraft(d.key)
  }

  // Deleting a file's chip takes the file out of the tray, and undo brings it back. An image stays.
  const onRefsEdited = useCallback(({ removed, added }: { removed: string[]; added: string[] }) => {
    setDrafts((list) => list.map((d) => {
      const id = d.uploaded?.id
      if (!id || d.kind === 'image') return d
      if (removed.includes(id)) return { ...d, hidden: true }
      if (added.includes(id)) return { ...d, hidden: false }
      return d
    }))
  }, [])

  // The chips' look; the ones for the file × is asking about are marked, as its tile is.
  const lookup = useMemo(() => {
    const byId = new Map<string, ChipInfo>()
    for (const d of drafts) {
      if (d.uploaded) byId.set(d.uploaded.id, { kind: d.kind, name: d.name, size: d.size, mime: d.mime, thumb: d.previewUrl || d.uploaded.url, asking: d.key === confirmRemove })
    }
    return (id: string) => byId.get(id)
  }, [drafts, confirmRemove])

  function onPaste(e: ClipboardEvent) {
    const data = e.clipboardData
    const files = Array.from(data?.files || [])
    if (files.length) {
      addFiles(files)
      return true
    }
    const text = data?.getData('text/plain') || ''
    if (text.length > PASTE_CHIP_CHARS || text.split('\n').length > PASTE_CHIP_LINES) {
      pasteCount += 1
      const firstLine = text.trim().split('\n')[0].slice(0, 80)
      upload(new Blob([text], { type: 'text/plain' }), `Pasted text ${pasteCount}.txt`, 'text', firstLine)
      return true
    }
    return false
  }

  const tray = drafts.filter((d) => !d.hidden)
  const uploading = tray.some((d) => d.status === 'uploading')
  const failed = tray.some((d) => d.status === 'error')
  const ready = tray.filter((d) => d.status === 'ready' && d.uploaded).map((d) => d.uploaded!)
  // A file whose chip was deleted is out of the draft too (it comes back only with undo).
  const unfinished = tray.length - ready.length
  const trayState = `${ready.map((a) => a.id).join(',')}|${unfinished}`
  const reported = useRef(trayState)
  useEffect(() => {
    if (reported.current === trayState) return
    reported.current = trayState
    onAttachmentsChange?.(ready, unfinished)
  }, [trayState]) // eslint-disable-line react-hooks/exhaustive-deps
  const hasContent = value.trim().length > 0 || tray.length > 0
  // Only finished files can move with a chat to its new place, so a pick waits for the rest.
  const placeHeld = uploading ? 'Waiting for uploads' : failed ? 'Retry or remove failed uploads first' : ''
  const sendable = !uploading && !failed && (value.trim().length > 0 || ready.length > 0)
  const canSend = !busy && sendable
  // While a reply runs, a message waits its turn or steers it (T3 Code). Enter
  // does the chosen one, Ctrl/⌘ the other; with only one on offer, always that one.
  const followUps = busy && !!(onQueue || onSteer)
  const actionFor = (alternate: boolean): FollowUp => {
    if (!onSteer) return 'queue'
    if (!onQueue) return 'steer'
    return alternate ? (followUp === 'queue' ? 'steer' : 'queue') : followUp
  }
  const action = actionFor(useModifierHeld(followUps))
  const here = destinations?.projectId ? projects.find((p) => p.id === destinations.projectId) : undefined
  const placeholder = answering ? answering.placeholder
    : inTask ? (here ? `A task for ${here.name}, e.g. “Renew passport fri p1”` : 'A task, e.g. “Renew passport fri p1 #folder”')
    : followUps ? (actionFor(false) === 'steer' ? 'Steer this reply: add context or change course' : 'Queue a message for when this reply finishes')
    : idlePlaceholder
  const handing = useRef(false)

  /** Empty the box into a follow-up (or a queued edit); put it all back if that fails. */
  async function hand(fn: (p: FollowUpPayload) => Promise<boolean> | boolean) {
    if (!sendable || handing.current) return
    handing.current = true
    const text = messageText(value)
    const attachments = ready
    // With the text out of the box no undo can bring a deleted chip back: those files go now.
    release(drafts.filter((d) => d.hidden))
    const kept = tray
    onChange('')
    setDrafts([])
    try {
      if (await fn({ text, attachments })) { release(kept); return }
      // Not sent: give it back, unless he has started on something else.
      if (!valueRef.current.trim()) onChange(text)
      setDrafts((d) => (d.length ? d : kept))
    } finally {
      handing.current = false
    }
  }

  function followUpNow(alternate: boolean) {
    const fn = actionFor(alternate) === 'queue' ? onQueue : onSteer
    if (fn) void hand(fn)
  }

  function clearTray() {
    release(drafts)
    setDrafts([])
  }

  function send() {
    if (queueEdit) { void hand(queueEdit.onSave); return }
    if (!canSend) return
    onSend({ text: messageText(value), attachments: ready })
    clearTray()
  }

  // Answering a question: the tray's files go with the answer on screen.
  const canAnswer = !!answering && !answering.submitting && !uploading && (answering.answered || ready.length > 0)
  function answerNow() {
    if (!answering || !canAnswer) return
    if (answering.onSubmit(ready)) clearTray()
  }

  // --- skills menu ("/" or "$" anywhere) -----------------------------------
  // Picking a skill puts `/name` in the message where you typed it, so you can say
  // what to use it on; the bridge sends the skill's instructions with your words.
  // A message that is only a Totem command still runs that skill on its own.
  const catalog = useSyncExternalStore(subscribeChatCommands, getChatCommands, getChatCommands)
  const known = useMentionSet()
  const token = allowCommands && !dictation && !inTask ? mentionAtCaret(value, caret) : null
  const query = token && token.start !== dismissed ? token : null
  // Only the token in an otherwise empty box can take a fill-mode skill's prefix.
  const alone = !!query && query.start === 0 && !value.slice(query.end).trim()
  const matches: ChatCommand[] = query ? rankCommands(catalog, query.prefix, query.term, alone) : []
  // `$` in a chat not started yet: where it goes and which task it is for, before the `$` skills.
  const dollar = !!query && query.prefix === '$' && !!destinations
  const work = useSyncExternalStore(dollar ? subscribeWork : noSubscribe, getWork, getWork)
  const providers = useChat((s) => s.providers) || NO_PROVIDERS
  const catalogs = useChat((s) => s.models) || NO_CATALOGS
  const wantModels = dollar && !!destinations?.onModel && query!.term.length >= 2
  // Every account's models, so `$opus` finds a model on any of them (the picker loads them the same way).
  useEffect(() => { if (wantModels) for (const p of providers) ensureModels(p.id) }, [wantModels, providers])
  const accounts = useMemo(() => providers.map((provider) => ({ provider, models: catalogs[provider.id] || [] })), [providers, catalogs])
  const places = dollar && destinations
    ? rankDestinations({
      projects, tasks: work.tasks, projectId: destinations.projectId, taskId: destinations.taskId,
      models: destinations.onModel ? accounts : [], startOptions: !!destinations.onStartOption, pinned: destinations.pinned,
    }, query!.term, value.slice(query!.start + 1, query!.end))
      .filter((d) => d.kind !== 'new-task' || canMakeTask)
    : []
  const items: MenuItem[] = [...places.map((d): MenuItem => ({ kind: 'dest', d })), ...matches.map((c): MenuItem => ({ kind: 'cmd', c }))]
  useEffect(() => { setSel(0) }, [value])
  useEffect(() => { if (!token) setDismissed(null) }, [token?.start])
  useEffect(() => {
    cmdMenuRef.current?.querySelector('.vc-cmd.active')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  function placeCaret(next: string, pos: number) {
    if (live.current && ed.current) ed.current.setText(next, pos)
    else {
      plain.current = { ...plain.current, want: pos }
      onChange(next)
    }
    setCaret(pos)
  }

  function chooseCommand(c: ChatCommand) {
    if (!query) return
    if (c.mode === 'fill' && alone) { placeCaret(c.text, c.text.length); return }
    const { value: next, caret: pos } = insertMention(value, query.start, query.end, c.cmd)
    placeCaret(next, pos)
  }

  function chooseItem(it: MenuItem) {
    if (it.kind === 'cmd') { chooseCommand(it.c); return }
    if (!query || !destinations) return
    // Only a move waits for uploads: a model, pin or snooze leaves the files where they are.
    if (placeHeld && !STAYS.has(it.d.kind)) return
    const { value: next, caret: pos } = stripToken(value, query.start, query.end)
    setDismissed(null)
    if (it.d.kind === 'new-task') { placeCaret(next, pos); startTask(); return }
    // These change how the chat starts, not where: the words stay in this draft.
    if (it.d.kind === 'model') { placeCaret(next, pos); destinations.onModel?.(it.d); return }
    if (it.d.kind === 'pin' || it.d.kind === 'snooze') { placeCaret(next, pos); destinations.onStartOption?.(it.d); return }
    destinations.onPick(it.d, next, pos)
  }

  // --- `$task`: a new task typed in the box ---------------------------------
  // Whatever is in the box already is the start of its title. Enter makes the task
  // where the chat is being started (or its #folder) and the chat view moves this
  // draft to a new chat for it, files and all; the box is then the chat's first message.
  const task = useMemo(() => (inTask
    ? readNewTask(value, { now: new Date(), folders: folderNames(projects), ignore: taskIgnore, projectId: destinations?.projectId ?? null })
    : null), [inTask, value, projects, taskIgnore, destinations?.projectId])
  const taskHeld = placeHeld || (taskBusy ? 'Adding the task' : '')
  const taskReady = !!task?.fields && !taskHeld

  function startTask() {
    setTaskIgnore([])
    setTaskMode(true)
    requestAnimationFrame(() => focusBox())
  }

  function leaveTask() {
    setTaskMode(false)
    setTaskIgnore([])
    focusBox()
  }

  async function submitTask() {
    if (!task?.fields || !destinations?.onNewTask) return
    if (taskHeld) { if (placeHeld) pushError(`${placeHeld}, then add the task.`); return }
    setTaskBusy(true)
    try {
      if (await destinations.onNewTask(task.fields)) { setTaskMode(false); setTaskIgnore([]) }
    } finally {
      setTaskBusy(false)
    }
  }

  function startMention(prefix: '/' | '$' = '/') {
    const sep = value && !/\s$/.test(value) ? ' ' : ''
    const next = `${value}${sep}${prefix}`
    setDismissed(null)
    placeCaret(next, next.length)
  }

  /** Return and Tab in a list while the plain box stands in for the editor, through the same string edits. */
  function plainListKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'Enter' && e.key !== 'Tab')) return false
    const { caret: from, end: to } = plain.current
    const result = e.key === 'Tab'
      ? listIndentLines(value, from, to, e.shiftKey)
      : (() => { const cut = cutSelection(value, from, to); return listEnter(cut.value, cut.caret, e.shiftKey) })()
    if (!result) return false
    placeCaret(result.value, result.caret)
    return true
  }

  /** The editor's keys first; true when the composer used the key. */
  function onKeyDown(e: KeyboardEvent) {
    if (inTask) {
      // One line: Return adds it, on a phone too. Escape, or Backspace in an empty box, makes it a message again.
      if (e.key === 'Enter' && !e.shiftKey) { void submitTask(); return true }
      if (e.key === 'Escape') { leaveTask(); return true }
      if (e.key === 'Backspace' && !value && !taskBusy) { leaveTask(); return true }
    }
    if (items.length) {
      if (e.key === 'ArrowDown') { setSel((s) => (s + 1) % items.length); return true }
      if (e.key === 'ArrowUp') { setSel((s) => (s - 1 + items.length) % items.length); return true }
      if (e.key === 'Enter' || e.key === 'Tab') { chooseItem(items[Math.min(sel, items.length - 1)]); return true }
      if (e.key === 'Escape') { setDismissed(query!.start); return true }
    }
    // In a list or a code block, Return and Tab edit it; ⌘/Ctrl+Return still sends.
    if (live.current && ed.current ? ed.current.formatKey(e) : plainListKey(e)) return true
    // On a phone, Return is a newline and the button sends — the way every
    // messaging app on it behaves.
    const mod = e.metaKey || e.ctrlKey
    if (e.key !== 'Enter' || e.shiftKey || (coarse() && !mod)) return false
    if (answering) answerNow()
    else if (queueEdit) send()
    else if (followUps) followUpNow(mod)
    else if (!busy) send()
    return true
  }

  // --- dictation -------------------------------------------------------------
  async function startDictation() {
    const why = micUnavailableReason()
    if (why) { pushError(why); return }
    try {
      const stream = await openMic()
      const rec = recordUntilStopped(stream, (level) => setDictation((d) => (d ? { ...d, level } : d)))
      dictRef.current = { ...rec, stream }
      setDictation({ state: 'recording', startedAt: Date.now(), level: 0 })
    } catch (e: any) {
      pushError(e?.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser settings.' : e.message)
    }
  }

  async function finishDictation() {
    const rec = dictRef.current
    if (!rec) return
    setDictation((d) => (d ? { ...d, state: 'transcribing' } : d))
    try {
      const blob = await rec.stop()
      closeMic(rec.stream)
      const text = await transcribe(blob)
      if (text) {
        const current = valueRef.current
        const { from, to } = (live.current && ed.current?.selection()) || { from: plain.current.caret, to: plain.current.end }
        const before = current.slice(0, from)
        const joiner = before && !/\s$/.test(before) ? ' ' : ''
        placeCaret(before + joiner + text + current.slice(to), from + joiner.length + text.length)
      }
    } catch (e: any) {
      pushError(e.message)
    } finally {
      dictRef.current = null
      setDictation(null)
    }
  }

  function cancelDictation() {
    dictRef.current?.cancel()
    closeMic(dictRef.current?.stream || null)
    dictRef.current = null
    setDictation(null)
  }

  const secs = dictation ? Math.floor((Date.now() - dictation.startedAt) / 1000) : 0
  const compacting = !!compactSend && !compactSend.keep
  const showVoice = !!onVoice && !busy && !value.trim() && !tray.length && !dictation && !onResume && !inTask
  const removing = drafts.find((d) => d.key === confirmRemove)

  return (
    <div className={`vc-composer ${compact ? 'compact' : ''}`}>
      {above}
      {items.length > 0 && (
        <div className="vc-cmd-menu" role="listbox" ref={cmdMenuRef}>
          {items.map((it, i) => {
            const group = itemGroup(it)
            const prev = i > 0 ? itemGroup(items[i - 1]) : ''
            return (
              <React.Fragment key={itemKey(it)}>
                {group !== prev && <div className="vc-menu-label">{group}</div>}
                <button type="button" role="option" aria-selected={i === sel} aria-disabled={it.kind === 'dest' && !STAYS.has(it.d.kind) && !!placeHeld} className={`vc-cmd ${i === sel ? 'active' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); chooseItem(it) }} onMouseEnter={() => setSel(i)}>
                  {it.kind === 'dest' ? (
                    <>
                      <span className="vc-cmd-icon"><DestIcon d={it.d} /></span>
                      <span className="vc-cmd-text">
                        <span className="vc-cmd-place">{it.d.kind === 'new-folder' ? `New ${it.d.parent ? 'folder' : 'project'} “${it.d.name}”` : it.d.kind === 'snooze' ? `Snooze · ${it.d.name}` : it.d.name}</span>
                        <span className="vc-cmd-desc">{(!STAYS.has(it.d.kind) && placeHeld) || destDesc(it.d, work.sheetName, here, !!destinations?.taskId)}</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="vc-cmd-icon">{it.c.kind === 'agent' ? <TI icon={IconPuzzle} size={16} /> : <Hi icon={it.c.icon} size={16} />}</span>
                      <span className="vc-cmd-text">
                        <span className="vc-cmd-name">{it.c.cmd}{it.c.source && <span className="vc-cmd-source">{it.c.source}</span>}</span>
                        <span className="vc-cmd-desc">{it.c.desc}</span>
                      </span>
                    </>
                  )}
                </button>
              </React.Fragment>
            )
          })}
        </div>
      )}
      <div className={`vc-box${inTask ? ' is-task' : ''}`}>
        {inTask && (
          <NewTaskBar hints={task?.parsed.hints ?? []} folderId={task?.fields?.folderId ?? destinations?.projectId ?? null}
            typedFolder={!!task?.parsed.folderId} projects={projects} now={new Date()} busy={taskBusy}
            onIgnore={(k) => setTaskIgnore((list) => [...list, k])} onLeave={leaveTask} />
        )}
        {tray.length > 0 && (
          <div className="vc-tray">
            {tray.map((d) => (
              <AttachmentChip
                key={d.key}
                a={{ name: d.name, kind: d.kind, mime: d.mime, size: d.size, url: d.previewUrl, preview: d.textPreview }}
                status={d.status}
                progress={d.progress}
                onRemove={() => askRemove(d)}
                asking={d.key === confirmRemove}
              />
            ))}
          </div>
        )}
        {removing && (
          <div className="vc-tray-confirm" role="alertdialog" aria-label={`Remove ${removing.name}?`}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setConfirmRemove(null); focusBox() } }}>
            <span><strong>{removing.name}</strong> ({formatSize(removing.size)}) is referenced in your message; removing it removes every reference.</span>
            <span className="vc-tray-confirm-actions">
              <button type="button" className="vc-btn sm ghost" onClick={() => { setConfirmRemove(null); focusBox() }}>Keep</button>
              <button type="button" className="vc-btn sm danger" onClick={confirmRemoval} autoFocus>Remove</button>
            </span>
          </div>
        )}
        {dictation && (
          <div className="vc-dictation">
            <span className="vc-rec-dot" style={{ transform: `scale(${1 + Math.min(dictation.level * 6, 0.8)})` }} />
            <span className="vc-dictation-label">
              {dictation.state === 'recording' ? `Listening · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : 'Transcribing…'}
            </span>
          </div>
        )}
        {/* Hidden, not unmounted, while dictating: the words land at its caret, and undo keeps its history. */}
        <div className="vc-input" hidden={!!dictation}>
          {!swapped && (
            <PlainBox ref={plainBox} value={value} onChange={onChange} placeholder={placeholder} autoFocus={!!autoFocus && !coarse()} state={plain}
              onCaret={setCaret} onComposing={setPlainComposing} onKeyDown={onKeyDown} onPaste={onPaste} />
          )}
          <div hidden={!swapped}>
          <Suspense fallback={null}>
            <PromptEditor
              ref={ed}
              value={value}
              onChange={onChange}
              lookup={lookup}
              known={known}
              placeholder={placeholder}
              label="Message"
              enterKeyHint={coarse() ? 'enter' : 'send'}
              autoFocus={autoFocus && !coarse()}
              onCaret={setCaret}
              onRefsEdited={onRefsEdited}
              onReady={onReady}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              markdown={formatMarkdown}
            />
          </Suspense>
          </div>
        </div>
        <div className={`vc-box-bar ${compactSend && !busy ? 'has-compact' : ''}`}>
          <div className="vc-box-left">
            {!dictation && (
              <div className="vc-plus-wrap" ref={menuRef}>
                <button type="button" className={`vc-icon-btn ${menu ? 'on' : ''}`} onClick={() => setMenu((m) => !m)} aria-label="Add files and more" title="Add files and more">
                  <TI icon={IconPlus} size={19} />
                </button>
                {menu && (
                  <div className="vc-menu vc-plus-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setMenu(false); fileInput.current?.click() }}>
                      <TI icon={IconPaperclip} size={17} /><span>Add photos and files</span>
                    </button>
                    {coarse() && (
                      <button type="button" role="menuitem" onClick={() => { setMenu(false); photoInput.current?.click() }}>
                        <TI icon={IconPhoto} size={17} /><span>Take a photo</span>
                      </button>
                    )}
                    {allowCommands && (catalog.length > 0 || destinations) && <div className="vc-menu-sep" />}
                    {canMakeTask && !inTask && (
                      <button type="button" role="menuitem" onClick={() => { setMenu(false); startTask() }}>
                        <TI icon={IconSquarePlus} size={17} /><span>New task, then chat about it</span>
                      </button>
                    )}
                    {allowCommands && catalog.length > 0 && (
                      <button type="button" role="menuitem" onClick={() => { setMenu(false); startMention() }}>
                        <TI icon={IconSparkles} size={17} /><span>Use a skill</span>
                      </button>
                    )}
                    {allowCommands && destinations && (
                      <button type="button" role="menuitem" onClick={() => { setMenu(false); startMention('$') }}>
                        <TI icon={IconFolder} size={17} /><span>Put it in a folder or task</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {!dictation && leftSlot}
          </div>
          <div className="vc-box-right">
            {dictation ? (
              <>
                <button type="button" className="vc-icon-btn" onClick={cancelDictation} aria-label="Cancel dictation" title="Cancel"><TI icon={IconX} size={18} /></button>
                <button type="button" className="vc-send" onClick={finishDictation} disabled={dictation.state !== 'recording'} aria-label="Finish dictation" title="Done">
                  {dictation.state === 'recording' ? <TI icon={IconCheck} size={18} stroke={2.25} /> : <TI icon={IconLoader2} size={18} className="vc-spin" />}
                </button>
              </>
            ) : (
              <>
                {rightSlot}
                {compactSend && !busy && !answering && !queueEdit && (
                  // T3's Compact chip: the next send summarises the idle chat first, unless he keeps the full history.
                  <span className="vc-compact-wrap">
                    <button type="button" className={`vc-compact-chip ${compactSend.keep ? '' : 'on'}`} aria-pressed={!compactSend.keep}
                      aria-label={`Compact ${formatContextTokens(compactSend.tokens)} tokens of history before sending`} onClick={compactSend.onToggle}>
                      {/* Keep shows the full-size arrows, so the state reads without the word on a phone. */}
                      <TI icon={compactSend.keep ? IconArrowsDiagonal : IconArrowsDiagonalMinimize2} size={15} />
                      <span className="vc-compact-word">{compactSend.keep ? 'Keep' : 'Compact'}</span>
                      <span className="vc-compact-n">{formatContextTokens(compactSend.tokens)}</span>
                    </button>
                    <span className="vc-compact-tip" role="tooltip">
                      <span>{compactSend.keep ? `Next send keeps all ${formatContextTokens(compactSend.tokens)} tokens.` : `Next send compacts ${formatContextTokens(compactSend.tokens)} tokens first.`}</span>
                      <span>{compactSend.keep ? 'Click to compact first' : 'Click to keep full history'}</span>
                    </span>
                  </span>
                )}
                {(!busy || followUps) && (
                  <button type="button" className="vc-icon-btn" onClick={startDictation} aria-label="Dictate" title="Dictate">
                    <TI icon={IconMicrophone} size={19} />
                  </button>
                )}
                {answering ? (
                  <>
                    {answering.onBack && <button type="button" className="vc-btn sm ghost" onClick={answering.onBack}>Previous</button>}
                    {busy && <button type="button" className="vc-icon-btn" onClick={onStop} aria-label="Stop" title="Stop the reply"><TI icon={IconPlayerStopFilled} size={14} /></button>}
                    <button type="button" className="vc-btn sm vc-answer-btn" onClick={answerNow} disabled={!canAnswer} title={uploading ? 'Waiting for uploads' : undefined}>
                      {(answering.submitting || uploading) && <TI icon={IconLoader2} size={14} className="vc-spin" />}{answering.submitLabel}
                    </button>
                  </>
                ) : queueEdit ? (
                  <button type="button" className="vc-send" onClick={send} disabled={!sendable} aria-label="Update queued message" title={uploading ? 'Waiting for uploads' : 'Update queued message'}>
                    {uploading ? <TI icon={IconLoader2} size={18} className="vc-spin" /> : <TI icon={IconCheck} size={18} stroke={2.25} />}
                  </button>
                ) : followUps && hasContent ? (
                  // T3 Code's follow-up button: what Enter does, and the other with Ctrl/⌘ (held, or on the click).
                  <button type="button" className="vc-send" onClick={(e) => followUpNow(e.metaKey || e.ctrlKey)} disabled={!sendable}
                    aria-label={action === 'queue' ? 'Queue message' : 'Steer message'}
                    title={uploading ? 'Waiting for uploads' : failed ? 'Retry or remove failed uploads before sending'
                      : onQueue && onSteer ? `Click to ${followUp}, Ctrl/⌘-click or ${modKey()}↵ to ${followUp === 'queue' ? 'steer' : 'queue'}`
                      : action === 'queue' ? 'Queue message' : 'Steer message'}>
                    {uploading ? <TI icon={IconLoader2} size={18} className="vc-spin" />
                      : <span className="vc-morph" key={action}><TI icon={action === 'queue' ? IconPlaylistAdd : IconCornerUpRight} size={18} stroke={2.25} /></span>}
                  </button>
                ) : inTask ? (
                  <button type="button" className="vc-send" onClick={() => void submitTask()} disabled={!taskReady}
                    aria-label="Add the task and start a chat" title={taskHeld || 'Add the task and start a chat for it'}>
                    {uploading || taskBusy ? <TI icon={IconLoader2} size={18} className="vc-spin" /> : <TI icon={IconCheck} size={18} stroke={2.25} />}
                  </button>
                ) : busy ? (
                  <button type="button" className="vc-send stop" onClick={onStop} aria-label="Stop" title="Stop"><TI icon={IconPlayerStopFilled} size={14} /></button>
                ) : onResume && !hasContent ? (
                  <button type="button" className="vc-send" onClick={onResume} aria-label="Resume thread" title="Resume thread"><TI icon={IconPlayerPlayFilled} size={16} /></button>
                ) : showVoice ? (
                  <button type="button" className="vc-send voice" onClick={onVoice} aria-label="Start voice mode" title="Voice mode"><TI icon={IconWaveSine} size={19} stroke={2} /></button>
                ) : (
                  <button type="button" className="vc-send" onClick={send} disabled={!canSend}
                    aria-label={compacting ? 'Compact and send' : 'Send'}
                    title={uploading ? 'Waiting for uploads' : compacting ? `Summarize ${formatContextTokens(compactSend!.tokens)} tokens of history, then send` : 'Send'}>
                    {uploading ? <TI icon={IconLoader2} size={18} className="vc-spin" /> : <TI icon={IconArrowUp} size={18} stroke={2.25} />}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
      <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
    </div>
  )
})

export default Composer
