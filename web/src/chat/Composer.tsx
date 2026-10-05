import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { Hi } from '../icons'
import { getChatCommands, subscribeChatCommands } from '../studio'
import { pushError } from '../toast'
import { deleteUpload, transcribe, uploadFile } from './api'
import { AttachmentChip } from './Message'
import { micUnavailableReason, openMic, closeMic, recordUntilStopped } from './recorder'
import type { Attachment, ChatMode, DraftAttachment } from './types'
import { TI, useDismiss } from './ui'
import {
  IconArrowUp, IconPlayerStopFilled, IconPlus, IconPaperclip, IconPhoto, IconMicrophone, IconWaveSine, IconBolt,
  IconDeviceDesktop, IconSparkles, IconX, IconCheck, IconLoader2, IconBrain, IconWorld, IconCornerUpRight,
} from './icons'

// A paste this long becomes a chip instead of filling the box. The text is sent
// in full either way; the chip is about being able to see your own question.
const PASTE_CHIP_CHARS = 1800
const PASTE_CHIP_LINES = 30

export interface ComposerHandle {
  addFiles: (files: File[] | FileList) => void
  /** An upload that already exists (Search's "Add to chat"). */
  addAttachment: (a: Attachment) => void
  focus: () => void
}

export interface ComposerProps {
  value: string
  onChange: (v: string) => void
  onSend: (payload: { text: string; attachments: Attachment[]; mode: ChatMode; browser?: boolean }) => void
  onStop: () => void
  /**
   * A message while the reply is still running steers it (T3 Code's follow-up):
   * the agent takes it in mid-turn. Resolves false when it could not be sent, and
   * the text goes back in the box.
   */
  onSteer?: (text: string) => Promise<boolean> | boolean
  onVoice?: () => void
  busy: boolean
  placeholder?: string
  autoFocus?: boolean
  compact?: boolean
  allowCommands?: boolean
  computerUse?: { available: boolean; reason?: string | null }
  maxUploadBytes?: number
  onAuthError?: () => void
  /** The model chip (T3-style), after the + button. */
  leftSlot?: React.ReactNode
  /** Thinking effort, beside the mic. */
  rightSlot?: React.ReactNode
  /** "Think longer" in the + menu, the way ChatGPT offers it. */
  onThinkLonger?: () => void
}

const coarse = () => window.matchMedia?.('(pointer: coarse)').matches

function commandQuery(value: string) {
  const m = /^([/$])(\S*)$/.exec(value)
  return m ? { prefix: m[1], term: m[2].toLowerCase() } : null
}

let pasteCount = 0

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { value, onChange, onSend, onStop, onSteer, onVoice, busy, placeholder: idlePlaceholder = 'Ask Totem anything', autoFocus, compact, allowCommands = true, computerUse, maxUploadBytes = 25 * 1024 * 1024, leftSlot, rightSlot, onThinkLonger } = props
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [drafts, setDrafts] = useState<(DraftAttachment & { progress?: number })[]>([])
  const [mode, setMode] = useState<ChatMode>('chat')
  // The browser is opt-in per message: off unless he turns it on (or asks in words).
  const [browser, setBrowser] = useState(false)
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
      textPreview: a.preview, status: 'ready', uploaded: a,
    }])
  }, [])

  useImperativeHandle(ref, () => ({ addFiles, addAttachment, focus: () => ta.current?.focus() }), [addFiles, addAttachment])

  function removeDraft(key: string) {
    setDrafts((d) => {
      const gone = d.find((x) => x.key === key)
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
      if (gone?.uploaded) deleteUpload(gone.uploaded.id)
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
  const ready = drafts.filter((d) => d.status === 'ready' && d.uploaded).map((d) => d.uploaded!)
  const canSend = !busy && !uploading && (value.trim().length > 0 || ready.length > 0)
  // Steering is words only; files wait in the box for the next message.
  const steerable = busy && !!onSteer
  const canSteer = steerable && value.trim().length > 0 && !drafts.length
  const placeholder = steerable ? 'Steer this reply: add context or change course' : idlePlaceholder
  const valueRef = useRef(value)
  valueRef.current = value

  async function steerNow() {
    if (!canSteer || !onSteer) return
    const text = value.trim()
    onChange('')
    const ok = await onSteer(text)
    // Not sent: give the words back, unless he has started typing something else.
    if (!ok && !valueRef.current.trim()) onChange(text)
  }

  function send() {
    if (!canSend) return
    onSend({ text: value.trim(), attachments: ready, mode, ...(browser ? { browser: true } : {}) })
    setBrowser(false)
    drafts.forEach((d) => d.previewUrl && URL.revokeObjectURL(d.previewUrl))
    setDrafts([])
    if (mode === 'computer') setMode('chat')
  }

  // --- skills menu ("/" or "$" at the start) -------------------------------
  const catalog = useSyncExternalStore(subscribeChatCommands, getChatCommands, getChatCommands)
  const query = allowCommands ? commandQuery(value) : null
  const matches = query
    ? catalog.filter((c) => c.cmd.startsWith(query.prefix) && (c.cmd.slice(1).startsWith(query.term) || c.title.toLowerCase().includes(query.term))).slice(0, 8)
    : []
  useEffect(() => { setSel(0) }, [value])

  function chooseCommand(c: any) {
    if (c.mode === 'fill') {
      onChange(c.text)
      requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(c.text.length, c.text.length) })
    } else {
      onSend({ text: c.text, attachments: [], mode: 'chat' })
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseCommand(matches[sel]); return }
      if (e.key === 'Escape') { e.preventDefault(); onChange(''); return }
    }
    // On a phone, Return is a newline and the button sends — the way every
    // messaging app on it behaves.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) { e.preventDefault(); if (busy) steerNow(); else send() }
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
  const showVoice = !!onVoice && !busy && !value.trim() && !drafts.length && !dictation

  return (
    <div className={`vc-composer ${compact ? 'compact' : ''}`}>
      {matches.length > 0 && (
        <div className="vc-cmd-menu" role="listbox">
          <div className="vc-menu-label">Skills</div>
          {matches.map((c, i) => (
            <button key={c.cmd} type="button" role="option" aria-selected={i === sel} className={`vc-cmd ${i === sel ? 'active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); chooseCommand(c) }} onMouseEnter={() => setSel(i)}>
              <span className="vc-cmd-icon"><Hi icon={c.icon} size={16} /></span>
              <span className="vc-cmd-text"><span className="vc-cmd-name">{c.cmd}</span><span className="vc-cmd-desc">{c.desc}</span></span>
            </button>
          ))}
        </div>
      )}
      <div className={`vc-box ${mode !== 'chat' ? `mode-${mode}` : ''}`}>
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
          <textarea
            ref={ta}
            rows={1}
            value={value}
            placeholder={placeholder}
            onChange={(e) => { onChange(e.target.value); grow() }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            enterKeyHint={coarse() ? 'enter' : 'send'}
          />
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
                    {onThinkLonger && (
                      <button type="button" role="menuitem" onClick={() => { setMenu(false); onThinkLonger() }}>
                        <TI icon={IconBrain} size={17} /><span>Think longer</span>
                      </button>
                    )}
                    <div className="vc-menu-sep" />
                    <button type="button" role="menuitemcheckbox" aria-checked={mode === 'task'} onClick={() => { setMenu(false); setMode((m) => (m === 'task' ? 'chat' : 'task')) }}>
                      <TI icon={IconBolt} size={17} />
                      <span className="vc-menu-text"><span>Task mode</span><small>Hand off a job; it can run for up to an hour</small></span>
                      {mode === 'task' && <TI icon={IconCheck} size={16} className="vc-menu-check" />}
                    </button>
                    <button type="button" role="menuitemcheckbox" aria-checked={browser} onClick={() => { setMenu(false); setBrowser((b) => !b) }}>
                      <TI icon={IconWorld} size={17} />
                      <span className="vc-menu-text"><span>Use the browser</span><small>Totem opens pages and shows you what it sees</small></span>
                      {browser && <TI icon={IconCheck} size={16} className="vc-menu-check" />}
                    </button>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={mode === 'computer'}
                      disabled={!computerUse?.available}
                      title={computerUse?.available ? undefined : computerUse?.reason || undefined}
                      onClick={() => { setMenu(false); setMode((m) => (m === 'computer' ? 'chat' : 'computer')) }}
                    >
                      <TI icon={IconDeviceDesktop} size={17} />
                      <span className="vc-menu-text">
                        <span>Use this computer</span>
                        <small>{computerUse?.available ? 'Codex drives the desktop: apps, sites, your logins' : (computerUse?.reason || 'Not available on this machine')}</small>
                      </span>
                      {mode === 'computer' && <TI icon={IconCheck} size={16} className="vc-menu-check" />}
                    </button>
                    {allowCommands && catalog.length > 0 && (
                      <>
                        <div className="vc-menu-sep" />
                        <button type="button" role="menuitem" onClick={() => { setMenu(false); onChange('/'); requestAnimationFrame(() => ta.current?.focus()) }}>
                          <TI icon={IconSparkles} size={17} /><span>Run a skill</span>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {!dictation && leftSlot}
            {browser && !dictation && (
              <button type="button" className="vc-mode-chip mode-browser" onClick={() => setBrowser(false)} title="Turn off">
                <TI icon={IconWorld} size={14} />
                Browser
                <TI icon={IconX} size={12} />
              </button>
            )}
            {mode !== 'chat' && !dictation && (
              <button type="button" className={`vc-mode-chip mode-${mode}`} onClick={() => setMode('chat')} title="Turn off">
                <TI icon={mode === 'task' ? IconBolt : IconDeviceDesktop} size={14} />
                {mode === 'task' ? 'Task' : 'Computer'}
                <TI icon={IconX} size={12} />
              </button>
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
                {(!busy || steerable) && (
                  <button type="button" className="vc-icon-btn" onClick={startDictation} aria-label="Dictate" title="Dictate">
                    <TI icon={IconMicrophone} size={19} />
                  </button>
                )}
                {busy && steerable && value.trim() ? (
                  <>
                    <button type="button" className="vc-icon-btn" onClick={onStop} aria-label="Stop" title="Stop the reply"><TI icon={IconPlayerStopFilled} size={14} /></button>
                    <button type="button" className="vc-send" onClick={steerNow} disabled={!canSteer} aria-label="Steer" title={drafts.length ? 'Files go with the next message, once this reply finishes' : 'Steer: send this into the running reply'}>
                      <TI icon={IconCornerUpRight} size={18} stroke={2.25} />
                    </button>
                  </>
                ) : busy ? (
                  <button type="button" className="vc-send stop" onClick={onStop} aria-label="Stop" title="Stop"><TI icon={IconPlayerStopFilled} size={14} /></button>
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
