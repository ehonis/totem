import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { Hi } from '../icons'
import { getChatCommands, subscribeChatCommands } from '../studio'
import { pushError } from '../toast'
import { deleteUpload, transcribe, uploadFile } from './api'
import { AttachmentChip, useMentionSet } from './Message'
import { insertMention, mentionAtCaret, splitMentions } from './mentions'
import { micUnavailableReason, openMic, closeMic, recordUntilStopped } from './recorder'
import type { Attachment, DraftAttachment } from './types'
import type { Answering } from './QuestionsPanel'
import { TI, useDismiss } from './ui'
import {
  IconArrowUp, IconPlayerStopFilled, IconPlus, IconPaperclip, IconPhoto, IconMicrophone, IconWaveSine,
  IconSparkles, IconX, IconCheck, IconLoader2, IconCornerUpRight, IconPuzzle, IconPlaylistAdd, IconPlayerPlayFilled,
} from './icons'
import type { ChatCommand } from '../studio'

// A paste this long becomes a chip instead of filling the box. The text is sent
// in full either way; the chip is about being able to see your own question.
const PASTE_CHIP_CHARS = 1800
const PASTE_CHIP_LINES = 30

export interface ComposerHandle {
  addFiles: (files: File[] | FileList) => void
  /** An upload that already exists (Search's "Add to chat"). */
  addAttachment: (a: Attachment) => void
  /** The box's finished uploads, taken out of it (not deleted): a queued edit stashes the draft. */
  takeAttachments: () => Attachment[]
  /** Put uploads in the box in place of what is there (a queued message being edited, a stashed draft). */
  setAttachments: (list: Attachment[]) => void
  focus: () => void
}

export type FollowUp = 'queue' | 'steer'
export interface FollowUpPayload { text: string; attachments: Attachment[] }

export interface ComposerProps {
  value: string
  onChange: (v: string) => void
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
  /** Attached to the box's top edge: the queued messages (QueuedMessages.tsx). */
  above?: React.ReactNode
  /**
   * The agent's questions are open (QuestionsPanel.tsx): the box is the typed
   * answer to the one on screen, and the button moves through them.
   */
  answering?: Answering
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

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { value, onChange, onSend, onStop, onSteer, onQueue, followUp = 'queue', queueEdit, onResume, onVoice, busy, placeholder: idlePlaceholder = 'Ask Totem anything', autoFocus, compact, allowCommands = true, maxUploadBytes = 25 * 1024 * 1024, rightSlot, answering, above } = props
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const marksRef = useRef<HTMLDivElement>(null)
  const cmdMenuRef = useRef<HTMLDivElement>(null)
  // Where the caret is, so "/" opens the skills menu mid-sentence, not only at the start.
  const [caret, setCaret] = useState(0)
  // The token whose menu Escape closed (its start), so it stays closed while you type on.
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<(DraftAttachment & { progress?: number })[]>([])
  const [menu, setMenu] = useState(false)
  const [sel, setSel] = useState(0)
  const [dictation, setDictation] = useState<null | { state: 'recording' | 'transcribing'; startedAt: number; level: number }>(null)
  const dictRef = useRef<{ stop: () => Promise<Blob>; cancel: () => void; stream: MediaStream } | null>(null)
  const [, tick] = useState(0)

  useDismiss(menu, menuRef, useCallback(() => setMenu(false), []))
  useEffect(() => { if (autoFocus && !coarse()) ta.current?.focus() }, [autoFocus])
  // Snap back to one row once cleared (after sending).
  useEffect(() => { if (!value && ta.current) ta.current.style.height = 'auto' }, [value])
  useEffect(() => {
    if (dictation?.state !== 'recording') return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [dictation?.state])

  const grow = () => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, compact ? 160 : Math.round(window.innerHeight * 0.4))}px`
  }

  const upload = useCallback((file: Blob, name: string, kind?: 'text', textPreview?: string) => {
    if (file.size > maxUploadBytes) { pushError(`${name} is larger than ${Math.round(maxUploadBytes / 1e6)} MB`); return }
    const key = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const isImage = /^image\//.test(file.type)
    const draft: DraftAttachment & { progress?: number } = {
      key, name, mime: file.type || 'application/octet-stream', size: file.size,
      kind: kind === 'text' ? 'text' : isImage ? 'image' : 'file',
      previewUrl: isImage ? URL.createObjectURL(file) : undefined,
      textPreview, status: 'uploading', progress: 0,
    }
    setDrafts((d) => [...d, draft])
    uploadFile(file, name, { kind, onProgress: (p) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, progress: p } : x))) })
      .then((uploaded) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, status: 'ready', uploaded } : x))))
      .catch((e) => {
        setDrafts((d) => d.map((x) => (x.key === key ? { ...x, status: 'error', error: e.message } : x)))
        pushError(e.message)
      })
  }, [maxUploadBytes])

  const addFiles = useCallback((files: File[] | FileList) => {
    for (const f of Array.from(files)) upload(f, f.name || (f.type.startsWith('image/') ? 'image.png' : 'file'))
  }, [upload])

  const addAttachment = useCallback((a: Attachment) => {
    setDrafts((d) => d.some((x) => x.uploaded?.id === a.id) ? d : [...d, {
      key: `ctx-${a.id}`, name: a.name, mime: a.mime, size: a.size, kind: a.kind,
      previewUrl: a.kind === 'image' ? a.url : undefined, textPreview: a.preview, status: 'ready', uploaded: a,
    }])
  }, [])

  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const takeAttachments = useCallback(() => {
    const taken = draftsRef.current.filter((d) => d.status === 'ready' && d.uploaded).map((d) => d.uploaded!)
    draftsRef.current.forEach((d) => d.previewUrl && URL.revokeObjectURL(d.previewUrl))
    setDrafts([])
    return taken
  }, [])
  const setAttachments = useCallback((list: Attachment[]) => {
    draftsRef.current.forEach((d) => d.previewUrl && URL.revokeObjectURL(d.previewUrl))
    setDrafts([])
    list.forEach(addAttachment)
  }, [addAttachment])

  useImperativeHandle(ref, () => ({ addFiles, addAttachment, takeAttachments, setAttachments, focus: () => ta.current?.focus() }), [addFiles, addAttachment, takeAttachments, setAttachments])

  function removeDraft(key: string) {
    setDrafts((d) => {
      const gone = d.find((x) => x.key === key)
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
      // One that was already an upload (Search's, a queued message's) may still be in use there.
      if (gone?.uploaded && !gone.key.startsWith('ctx-')) deleteUpload(gone.uploaded.id)
      return d.filter((x) => x.key !== key)
    })
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files || [])
    if (files.length) {
      e.preventDefault()
      addFiles(files)
      return
    }
    const text = e.clipboardData.getData('text/plain')
    if (text && (text.length > PASTE_CHIP_CHARS || text.split('\n').length > PASTE_CHIP_LINES)) {
      e.preventDefault()
      pasteCount += 1
      const firstLine = text.trim().split('\n')[0].slice(0, 80)
      upload(new Blob([text], { type: 'text/plain' }), `Pasted text ${pasteCount}.txt`, 'text', firstLine)
    }
  }

  const uploading = drafts.some((d) => d.status === 'uploading')
  const failed = drafts.some((d) => d.status === 'error')
  const ready = drafts.filter((d) => d.status === 'ready' && d.uploaded).map((d) => d.uploaded!)
  const hasContent = value.trim().length > 0 || drafts.length > 0
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
  const placeholder = answering ? answering.placeholder
    : followUps ? (actionFor(false) === 'steer' ? 'Steer this reply: add context or change course' : 'Queue a message for when this reply finishes')
    : idlePlaceholder
  const valueRef = useRef(value)
  valueRef.current = value
  const handing = useRef(false)

  /** Empty the box into a follow-up (or a queued edit); put it all back if that fails. */
  async function hand(fn: (p: FollowUpPayload) => Promise<boolean> | boolean) {
    if (!sendable || handing.current) return
    handing.current = true
    const text = value.trim()
    const attachments = ready
    const kept = drafts
    onChange('')
    setDrafts([])
    try {
      if (await fn({ text, attachments })) { kept.forEach((d) => d.previewUrl && URL.revokeObjectURL(d.previewUrl)); return }
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
    drafts.forEach((d) => d.previewUrl && URL.revokeObjectURL(d.previewUrl))
    setDrafts([])
  }

  function send() {
    if (queueEdit) { void hand(queueEdit.onSave); return }
    if (!canSend) return
    onSend({ text: value.trim(), attachments: ready })
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
  const token = allowCommands && !dictation ? mentionAtCaret(value, caret) : null
  const query = token && token.start !== dismissed ? token : null
  // Only the token in an otherwise empty box can take a fill-mode skill's prefix.
  const alone = !!query && query.start === 0 && !value.slice(query.end).trim()
  const matches: ChatCommand[] = query ? rankCommands(catalog, query.prefix, query.term, alone) : []
  useEffect(() => { setSel(0) }, [value])
  useEffect(() => { if (!token) setDismissed(null) }, [token?.start])
  useEffect(() => {
    cmdMenuRef.current?.querySelector('.vc-cmd.active')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  function placeCaret(next: string, pos: number) {
    onChange(next)
    setCaret(pos)
    requestAnimationFrame(() => { grow(); ta.current?.focus(); ta.current?.setSelectionRange(pos, pos) })
  }

  function chooseCommand(c: ChatCommand) {
    if (!query) return
    if (c.mode === 'fill' && alone) { placeCaret(c.text, c.text.length); return }
    const { value: next, caret: pos } = insertMention(value, query.start, query.end, c.cmd)
    placeCaret(next, pos)
  }

  function startMention() {
    const sep = value && !/\s$/.test(value) ? ' ' : ''
    const next = `${value}${sep}/`
    setDismissed(null)
    placeCaret(next, next.length)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseCommand(matches[sel]); return }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(query!.start); return }
    }
    // On a phone, Return is a newline and the button sends — the way every
    // messaging app on it behaves.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) {
      e.preventDefault()
      if (answering) answerNow()
      else if (queueEdit) send()
      else if (followUps) followUpNow(e.metaKey || e.ctrlKey)
      else if (!busy) send()
    }
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
        const el = ta.current
        const start = el?.selectionStart ?? value.length
        const end = el?.selectionEnd ?? value.length
        const before = value.slice(0, start)
        const joiner = before && !/\s$/.test(before) ? ' ' : ''
        const next = before + joiner + text + value.slice(end)
        onChange(next)
        requestAnimationFrame(() => { grow(); el?.focus() })
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
  const showVoice = !!onVoice && !busy && !value.trim() && !drafts.length && !dictation && !onResume

  return (
    <div className={`vc-composer ${compact ? 'compact' : ''}`}>
      {above}
      {matches.length > 0 && (
        <div className="vc-cmd-menu" role="listbox" ref={cmdMenuRef}>
          {matches.map((c, i) => {
            const group = c.kind === 'agent' ? 'Your agent skills' : 'Totem skills'
            const prev = i > 0 ? (matches[i - 1].kind === 'agent' ? 'Your agent skills' : 'Totem skills') : ''
            return (
              <React.Fragment key={c.cmd}>
                {group !== prev && <div className="vc-menu-label">{group}</div>}
                <button type="button" role="option" aria-selected={i === sel} className={`vc-cmd ${i === sel ? 'active' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); chooseCommand(c) }} onMouseEnter={() => setSel(i)}>
                  <span className="vc-cmd-icon">{c.kind === 'agent' ? <TI icon={IconPuzzle} size={16} /> : <Hi icon={c.icon} size={16} />}</span>
                  <span className="vc-cmd-text">
                    <span className="vc-cmd-name">{c.cmd}{c.source && <span className="vc-cmd-source">{c.source}</span>}</span>
                    <span className="vc-cmd-desc">{c.desc}</span>
                  </span>
                </button>
              </React.Fragment>
            )
          })}
        </div>
      )}
      <div className="vc-box">
        {drafts.length > 0 && (
          <div className="vc-tray">
            {drafts.map((d) => (
              <AttachmentChip
                key={d.key}
                a={{ name: d.name, kind: d.kind, mime: d.mime, size: d.size, url: d.previewUrl, preview: d.textPreview }}
                status={d.status}
                progress={d.progress}
                onRemove={() => removeDraft(d.key)}
              />
            ))}
          </div>
        )}
        {dictation ? (
          <div className="vc-dictation">
            <span className="vc-rec-dot" style={{ transform: `scale(${1 + Math.min(dictation.level * 6, 0.8)})` }} />
            <span className="vc-dictation-label">
              {dictation.state === 'recording' ? `Listening · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : 'Transcribing…'}
            </span>
          </div>
        ) : (
          <div className="vc-input">
            {/* The cited skills, highlighted behind the textarea's own text. */}
            <div className="vc-input-marks" ref={marksRef} aria-hidden>
              {splitMentions(value, known).map((p, i) => (p.mention ? <mark key={i}>{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}
              {'\n'}
            </div>
            <textarea
              ref={ta}
              rows={1}
              value={value}
              placeholder={placeholder}
              onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); grow() }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onScroll={(e) => { if (marksRef.current) marksRef.current.scrollTop = e.currentTarget.scrollTop }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              enterKeyHint={coarse() ? 'enter' : 'send'}
            />
          </div>
        )}
        <div className="vc-box-bar">
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
                    {allowCommands && catalog.length > 0 && (
                      <>
                        <div className="vc-menu-sep" />
                        <button type="button" role="menuitem" onClick={() => { setMenu(false); startMention() }}>
                          <TI icon={IconSparkles} size={17} /><span>Use a skill</span>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
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
                ) : busy ? (
                  <button type="button" className="vc-send stop" onClick={onStop} aria-label="Stop" title="Stop"><TI icon={IconPlayerStopFilled} size={14} /></button>
                ) : onResume && !hasContent ? (
                  <button type="button" className="vc-send" onClick={onResume} aria-label="Resume thread" title="Resume thread"><TI icon={IconPlayerPlayFilled} size={16} /></button>
                ) : showVoice ? (
                  <button type="button" className="vc-send voice" onClick={onVoice} aria-label="Start voice mode" title="Voice mode"><TI icon={IconWaveSine} size={19} stroke={2} /></button>
                ) : (
                  <button type="button" className="vc-send" onClick={send} disabled={!canSend} aria-label="Send" title={uploading ? 'Waiting for uploads' : 'Send'}>
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
