import { POWER_NAMES } from './models'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from '../components/Markdown'
import TotemProposal from './TotemProposal'
import WorkLog from './WorkLog'
import type { Attachment, ChatMessage, Part, ProviderRow, ToolPart } from './types'
import { TI, ProviderLogo, formatBytes, formatDuration } from './ui'
import { IconAlertCircle,
  IconCopy, IconCheck, IconRefresh, IconVolume, IconPencil, IconFileText, IconFileTypePdf, IconClipboardText,
  IconPlayerPause, IconBolt, IconDeviceDesktop, IconMicrophone, IconX,
} from './icons'
import { readMessageAloud, speechSupported } from './speech'
import { FileCard, ARTIFACT_PREVIEWABLE } from './ArtifactPanel'
import { openArtifact } from './store'
import { useSmoothText } from './smooth'
import { WorkingLine } from './Spark'

// --- attachments ---------------------------------------------------------------

export function AttachmentChip({ a, onOpen, onRemove, status, progress }: {
  a: { name: string; kind: string; mime: string; size: number; url?: string; preview?: string }
  onOpen?: () => void
  onRemove?: () => void
  status?: 'uploading' | 'ready' | 'error'
  progress?: number
}) {
  if (a.kind === 'image' && a.url) {
    return (
      <div className={`vc-thumb ${status || ''}`}>
        <button type="button" className="vc-thumb-img" onClick={onOpen} title={a.name}>
          <img src={a.url} alt={a.name} loading="lazy" />
        </button>
        {status === 'uploading' && <span className="vc-thumb-progress" style={{ ['--p' as any]: `${Math.round((progress || 0) * 100)}%` }} />}
        {onRemove && <button type="button" className="vc-chip-x" onClick={onRemove} aria-label={`Remove ${a.name}`}><TI icon={IconX} size={12} /></button>}
      </div>
    )
  }
  const icon = a.kind === 'text' ? IconClipboardText : /pdf/.test(a.mime) ? IconFileTypePdf : IconFileText
  const pasted = /^Pasted text/i.test(a.name)
  return (
    <div className={`vc-file ${status || ''}`}>
      <button type="button" className="vc-file-main" onClick={onOpen} title={a.name}>
        <span className="vc-file-icon"><TI icon={icon} size={18} /></span>
        <span className="vc-file-text">
          <span className="vc-file-name">{pasted ? (a.preview || 'Pasted text') : a.name}</span>
          <span className="vc-file-meta">{status === 'uploading' ? `Uploading ${Math.round((progress || 0) * 100)}%` : status === 'error' ? 'Upload failed' : pasted ? `Pasted · ${formatBytes(a.size)}` : `${(a.name.split('.').pop() || 'file').toUpperCase()} · ${formatBytes(a.size)}`}</span>
        </span>
      </button>
      {onRemove && <button type="button" className="vc-chip-x" onClick={onRemove} aria-label={`Remove ${a.name}`}><TI icon={IconX} size={12} /></button>}
    </div>
  )
}

export function Lightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="vc-lightbox" onClick={onClose} role="dialog" aria-label={alt || 'Image'}>
      <img src={src} alt={alt || ''} onClick={(e) => e.stopPropagation()} />
      <button type="button" className="vc-lightbox-close" onClick={onClose} aria-label="Close"><TI icon={IconX} size={20} /></button>
    </div>
  )
}

function openAttachment(a: Attachment, setLightbox: (s: { src: string; alt: string }) => void) {
  if (!a.url) return
  if (a.kind === 'image') setLightbox({ src: a.url, alt: a.name })
  // Documents open in the canvas beside the chat, like the ones Totem makes.
  else if (ARTIFACT_PREVIEWABLE.test(a.mime)) openArtifact({ uploadId: a.id, name: a.name, mime: a.mime, url: a.url, size: a.size })
  else window.open(a.url, '_blank', 'noopener')
}

// --- user ----------------------------------------------------------------------

const MODE_BADGE: Record<string, { icon: any; label: string }> = {
  task: { icon: IconBolt, label: 'Task' },
  computer: { icon: IconDeviceDesktop, label: 'Computer use' },
}

export function UserMessage({ m, canEdit, onEdit, onRetry, onDiscard }: { m: ChatMessage; canEdit: boolean; onEdit: (text: string) => void; onRetry?: () => void; onDiscard?: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.content)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      ref.current.style.height = 'auto'
      ref.current.style.height = `${ref.current.scrollHeight}px`
    }
  }, [editing])
  const badge = m.mode ? MODE_BADGE[m.mode] : null
  return (
    <div className={`vc-row vc-user ${m.unsent ? 'unsent' : ''}`}>
      {!!m.attachments?.length && (
        <div className="vc-user-attachments">
          {m.attachments.map((a) => <AttachmentChip key={a.id} a={a} onOpen={() => openAttachment(a, setLightbox)} />)}
        </div>
      )}
      {editing ? (
        <div className="vc-edit">
          <textarea
            ref={ref}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px` }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setEditing(false); setDraft(m.content) }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (draft.trim()) { setEditing(false); onEdit(draft.trim()) } }
            }}
          />
          <div className="vc-edit-actions">
            <button type="button" className="vc-btn ghost" onClick={() => { setEditing(false); setDraft(m.content) }}>Cancel</button>
            <button type="button" className="vc-btn primary" disabled={!draft.trim()} onClick={() => { setEditing(false); onEdit(draft.trim()) }}>Send</button>
          </div>
        </div>
      ) : m.content ? (
        <div className="vc-bubble">
          {(badge || m.voice) && (
            <span className="vc-bubble-badge">
              {badge && <><TI icon={badge.icon} size={13} />{badge.label}</>}
              {m.voice && <><TI icon={IconMicrophone} size={13} />Voice</>}
            </span>
          )}
          {m.content}
        </div>
      ) : null}
      {m.unsent && (
        <div className="vc-unsent" role="status">
          <TI icon={IconAlertCircle} size={15} />
          <span>Not sent{m.sendError && m.sendError !== 'Not sent' ? ` · ${m.sendError}` : ''}. Saved on this device.</span>
          {onRetry && <button type="button" className="vc-btn sm primary" onClick={onRetry}>Try again</button>}
          {onDiscard && <button type="button" className="vc-btn sm ghost" onClick={onDiscard}>Edit</button>}
        </div>
      )}
      {!editing && m.content && !m.unsent && (
        <div className="vc-actions vc-actions-user">
          <button type="button" className="vc-act" title={copied ? 'Copied' : 'Copy'} onClick={() => { navigator.clipboard?.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>
            <TI icon={copied ? IconCheck : IconCopy} size={15} />
          </button>
          {canEdit && <button type="button" className="vc-act" title="Edit" onClick={() => { setDraft(m.content); setEditing(true) }}><TI icon={IconPencil} size={15} /></button>}
        </div>
      )}
      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}

// --- assistant -------------------------------------------------------------------

type Block = { kind: 'text'; text: string; key: string } | { kind: 'tools'; tools: ToolPart[]; key: string } | { kind: 'image'; part: any; key: string } | { kind: 'file'; part: any; key: string } | { kind: 'proposal'; part: any; key: string }

// A totem proposal arrives as a fenced block while streaming; the bridge turns it
// into a card when the reply settles. Until then, don't show the raw JSON.
const PROPOSAL_FENCE = /```totem-proposal[\s\S]*?(```|$)/g

function blocks(parts: Part[]): Block[] {
  const out: Block[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.type === 'tool') {
      const last = out[out.length - 1]
      if (last?.kind === 'tools') last.tools.push(p)
      else out.push({ kind: 'tools', tools: [p], key: `w${i}` })
    } else if (p.type === 'image') out.push({ kind: 'image', part: p, key: `i${i}` })
    else if (p.type === 'file') out.push({ kind: 'file', part: p, key: `f${i}` })
    else if (p.type === 'totem-proposal') out.push({ kind: 'proposal', part: p, key: `p${i}` })
    else if (p.text) {
      const last = out[out.length - 1]
      // Two text parts with no tool between them are one paragraph run.
      if (last?.kind === 'text') last.text += p.text
      else out.push({ kind: 'text', text: p.text, key: `t${i}` })
    }
  }
  for (const b of out) if (b.kind === 'text') b.text = b.text.replace(PROPOSAL_FENCE, '')
  return out
}

/** True once `signature` has stopped changing for QUIET_MS while `live`. */
const QUIET_MS = 700
function useQuiet(live: boolean, signature: string) {
  const [quiet, setQuiet] = useState(false)
  useEffect(() => {
    setQuiet(false)
    if (!live) return
    const t = setTimeout(() => setQuiet(true), QUIET_MS)
    return () => clearTimeout(t)
  }, [live, signature])
  return live && quiet
}

/** The reply's last text block while it streams: released word by word. */
function StreamingText({ text }: { text: string }) {
  const shown = useSmoothText(text, true)
  return <Markdown text={shown} className="vc-streaming" />
}

export function AssistantMessage({ m, live, activity, provider, modelName, isLast, onRegenerate }: {
  m: ChatMessage
  live: boolean
  activity?: string
  provider?: ProviderRow
  /** The model's display name, when the provider has a picker. */
  modelName?: string
  isLast: boolean
  onRegenerate?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [speaking, setSpeaking] = useState<null | (() => void)>(null)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const list = useMemo(() => (m.parts?.length ? blocks(m.parts) : m.content ? [{ kind: 'text', text: m.content, key: 'c' } as Block] : []), [m.parts, m.content])
  useEffect(() => () => speaking?.(), []) // eslint-disable-line react-hooks/exhaustive-deps
  const thinking = live && !list.length
  // Mid-reply silence — between tools, or the model thinking before its next
  // sentence — gets the working line too, so a live reply never looks stalled.
  const toolRunning = !!m.parts?.some((p) => p.type === 'tool' && p.status === 'running')
  const quiet = useQuiet(live, `${m.content.length}:${m.parts?.length || 0}`)
  // Auto/Instant/Thinking say which lane answered: "Thought for 14s" reads the
  // way ChatGPT's does and tells you the slower answer was deliberate.
  const secs = m.durationMs && m.durationMs > 2000 ? formatDuration(m.durationMs) : null
  const lane = m.power ? [POWER_NAMES[String(m.power)], m.route === 'thinking' && secs ? `thought for ${secs}` : null].filter(Boolean).join(', ')
    : m.route === 'thinking' ? (secs ? `Thought for ${secs}` : 'Thinking') : m.route === 'instant' ? 'Instant' : null
  const meta = [lane, provider?.name, modelName, lane ? null : secs].filter(Boolean).join(' · ')

  return (
    <div className={`vc-row vc-assistant ${live ? 'live' : ''}`}>
      <div className="vc-assistant-body">
        {list.map((b, i) => {
          if (b.kind === 'tools') return <WorkLog key={b.key} tools={b.tools} live={live && i === list.length - 1} />
          if (b.kind === 'proposal') return <TotemProposal key={b.key} part={b.part} messageId={m.id} />
          if (b.kind === 'file') return <FileCard key={b.key} file={b.part} onOpen={() => openArtifact(b.part)} />
          if (b.kind === 'image') {
            const src = b.part.url || `/api/chat/uploads/${b.part.uploadId}`
            return (
              <button key={b.key} type="button" className="vc-shot" onClick={() => setLightbox({ src, alt: b.part.alt || 'Screenshot' })}>
                <img src={src} alt={b.part.alt || 'Screenshot'} loading="lazy" />
              </button>
            )
          }
          if (live && i === list.length - 1) return <StreamingText key={b.key} text={b.text} />
          return <Markdown key={b.key} text={b.text} />
        })}
        {thinking && <WorkingLine text={activity ? activity.split('\n')[0].replace(/^(Working|Running|Done):\s*/, '') : m.route === 'thinking' ? 'Thinking longer for a better answer' : 'Thinking'} />}
        {live && !thinking && quiet && !toolRunning && <WorkingLine text={activity && !/^Done:/.test(activity) ? activity.split('\n')[0].replace(/^(Working|Running):\s*/, '') : 'Working'} />}
        {m.status === 'error' && (
          <div className="vc-error">
            <div>{m.error || 'Something went wrong before the reply finished.'}</div>
            {isLast && onRegenerate && <button type="button" className="vc-btn" onClick={onRegenerate}><TI icon={IconRefresh} size={14} />Try again</button>}
          </div>
        )}
        {m.status === 'stopped' && <div className="vc-note">Stopped</div>}
      </div>
      {!live && (m.content || m.status === 'error') && (
        <div className="vc-actions">
          {m.content && (
            <button type="button" className="vc-act" title={copied ? 'Copied' : 'Copy'} onClick={() => { navigator.clipboard?.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>
              <TI icon={copied ? IconCheck : IconCopy} size={15} />
            </button>
          )}
          {m.content && speechSupported() && (
            <button
              type="button"
              className={`vc-act ${speaking ? 'on' : ''}`}
              title={speaking ? 'Stop reading' : 'Read aloud'}
              onClick={() => {
                if (speaking) { speaking(); setSpeaking(null); return }
                const cancel = readMessageAloud(m.content, () => setSpeaking(null))
                setSpeaking(() => cancel)
              }}
            >
              <TI icon={speaking ? IconPlayerPause : IconVolume} size={15} />
            </button>
          )}
          {isLast && onRegenerate && <button type="button" className="vc-act" title="Regenerate" onClick={onRegenerate}><TI icon={IconRefresh} size={15} /></button>}
          {meta && (
            <span className="vc-meta">
              {provider && <ProviderLogo driver={provider.driver} name={provider.name} size={12} />}
              {meta}
            </span>
          )}
        </div>
      )}
      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
