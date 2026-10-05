import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Markdown from '../components/Markdown'
import { useChat, openArtifact, type Artifact } from './store'
import { TI, useDismiss, formatBytes } from './ui'
import { IconChevronDown, IconX, IconArrowDown, IconFileText, IconFileTypePdf, IconWorld, IconClipboardText, IconCopy, IconCheck, IconLayoutSidebar } from './icons'

// The canvas beside the chat — ChatGPT's document panel. A file the agent made
// (or one the owner attached) opens here rendered, not as a download:
//   Markdown → the chat's own reading styles
//   HTML     → a sandboxed frame. `allow-scripts` without `allow-same-origin`
//              gives the page an opaque origin, so a generated page can run its
//              own JavaScript but cannot read Totem's storage or call its API.
//   CSV      → a table;  PDF → the browser's viewer;  SVG/images → as images;
//   other text → a code block.

export const ARTIFACT_PREVIEWABLE = /^(text\/|application\/(json|xml|pdf)|image\/svg)/

export function artifactKind(mime: string, name = '') {
  if (/markdown/.test(mime) || /\.(md|markdown)$/i.test(name)) return 'markdown'
  if (/html/.test(mime) || /\.html?$/i.test(name)) return 'html'
  if (/csv|tab-separated/.test(mime) || /\.(csv|tsv)$/i.test(name)) return 'table'
  if (/pdf/.test(mime)) return 'pdf'
  if (/^image\//.test(mime)) return 'image'
  return 'text'
}

export function artifactLabel(mime: string, name = '') {
  const k = artifactKind(mime, name)
  return k === 'markdown' ? 'Document' : k === 'html' ? 'Web page' : k === 'table' ? 'Table' : k === 'pdf' ? 'PDF' : k === 'image' ? 'Image' : 'File'
}

export function artifactIcon(mime: string, name = '') {
  const k = artifactKind(mime, name)
  return k === 'html' ? IconWorld : k === 'pdf' ? IconFileTypePdf : k === 'table' ? IconClipboardText : IconFileText
}

// Small CSV reader: quoted fields, escaped quotes, commas or tabs.
function parseDelimited(text: string, sep: string) {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === sep) { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.slice(0, 2000)
}

const LANG: Record<string, string> = { json: 'json', yml: 'yaml', yaml: 'yaml', xml: 'xml', ics: 'text', txt: 'text' }

function Body({ a, text }: { a: Artifact; text: string | null }) {
  const kind = artifactKind(a.mime, a.name)
  if (kind === 'pdf') return <iframe className="vc-art-frame" src={a.url} title={a.name} />
  if (kind === 'image') return <div className="vc-art-image"><img src={a.url} alt={a.name} /></div>
  if (text === null) return <div className="vc-art-loading">Loading…</div>
  if (kind === 'markdown') return <div className="vc-art-doc"><Markdown text={text} /></div>
  if (kind === 'html') return <iframe className="vc-art-frame" sandbox="allow-scripts allow-forms allow-popups allow-modals" srcDoc={text} title={a.name} />
  if (kind === 'table') {
    const rows = parseDelimited(text, /\.tsv$/i.test(a.name) || /tab-separated/.test(a.mime) ? '\t' : ',')
    const [head, ...body] = rows
    return (
      <div className="vc-art-table">
        <table>
          {head && <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>}
          <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    )
  }
  const ext = (a.name.split('.').pop() || '').toLowerCase()
  return <div className="vc-art-doc"><Markdown text={`\`\`\`${LANG[ext] || ext}\n${text}\n\`\`\``} /></div>
}

/** Every previewable file in the open thread, newest last, for the switcher. */
export function useThreadArtifacts(threadId: string | null): Artifact[] {
  const thread = useChat((s) => s.threads.find((t) => t.id === threadId))
  return useMemo(() => {
    const out: Artifact[] = []
    for (const m of thread?.messages || []) {
      for (const a of m.attachments || []) if (a.url && ARTIFACT_PREVIEWABLE.test(a.mime) && a.kind !== 'image') out.push({ uploadId: a.id, name: a.name, mime: a.mime, url: a.url, size: a.size })
      for (const p of m.parts || []) if (p.type === 'file') out.push({ uploadId: p.uploadId, name: p.name, mime: p.mime, url: p.url, size: p.size, path: p.path })
    }
    return out
  }, [thread])
}

export default function ArtifactPanel({ threadId, expanded, onExpand }: { threadId: string | null; expanded: boolean; onExpand: (v: boolean) => void }) {
  const a = useChat((s) => s.artifact)
  const files = useThreadArtifacts(threadId)
  const [text, setText] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useDismiss(menu, menuRef, useCallback(() => setMenu(false), []))

  useEffect(() => {
    if (!a?.url) return
    const kind = artifactKind(a.mime, a.name)
    if (kind === 'pdf' || kind === 'image') return
    let alive = true
    setText(null)
    fetch(a.url).then((r) => r.text()).then((t) => { if (alive) setText(t) }).catch(() => { if (alive) setText('Couldn’t load this file.') })
    return () => { alive = false }
  }, [a?.url, a?.mime, a?.name])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !menu) openArtifact(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  if (!a) return null
  const canCopy = text !== null && !['pdf', 'image'].includes(artifactKind(a.mime, a.name))
  return (
    <aside className="vc vc-artifact" aria-label={a.name}>
      <header className="vc-art-head">
        <div className="vc-art-switch" ref={menuRef}>
          <button type="button" className="vc-art-title" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} title={a.path || a.name}>
            <TI icon={artifactIcon(a.mime, a.name)} size={17} />
            <span>{a.name}</span>
            {files.length > 1 && <TI icon={IconChevronDown} size={15} className="vc-chip-caret" />}
          </button>
          {menu && files.length > 1 && (
            <div className="vc-menu vc-art-menu" role="menu">
              {files.slice().reverse().map((f) => (
                <button key={f.uploadId} type="button" role="menuitemradio" aria-checked={f.uploadId === a.uploadId} onClick={() => { openArtifact(f); setMenu(false) }}>
                  <TI icon={artifactIcon(f.mime, f.name)} size={16} />
                  <span className="vc-menu-text"><span>{f.name}</span><small>{artifactLabel(f.mime, f.name)}{f.size ? ` · ${formatBytes(f.size)}` : ''}</small></span>
                  {f.uploadId === a.uploadId && <TI icon={IconCheck} size={16} className="vc-menu-check" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="vc-art-actions">
          {canCopy && (
            <button type="button" className="vc-icon-btn" onClick={() => { navigator.clipboard?.writeText(text || ''); setCopied(true); setTimeout(() => setCopied(false), 1200) }} title={copied ? 'Copied' : 'Copy contents'} aria-label="Copy contents">
              <TI icon={copied ? IconCheck : IconCopy} size={18} />
            </button>
          )}
          <a className="vc-icon-btn" href={`${a.url}${a.url?.includes('?') ? '&' : '?'}download=1`} download={a.name} title="Download" aria-label="Download">
            <TI icon={IconArrowDown} size={18} />
          </a>
          <button type="button" className={`vc-icon-btn vc-art-expand ${expanded ? 'on' : ''}`} onClick={() => onExpand(!expanded)} title={expanded ? 'Show the chat' : 'Full width'} aria-label={expanded ? 'Show the chat' : 'Full width'}>
            <TI icon={IconLayoutSidebar} size={18} />
          </button>
          <button type="button" className="vc-icon-btn" onClick={() => openArtifact(null)} title="Close" aria-label="Close"><TI icon={IconX} size={19} /></button>
        </div>
      </header>
      <div className="vc-art-body"><Body a={a} text={text} /></div>
    </aside>
  )
}

/** The card a file gets in the reply (and that opens it in the panel). */
export function FileCard({ file, onOpen }: { file: Artifact; onOpen: () => void }) {
  return (
    <button type="button" className="vc-filecard" onClick={onOpen} title={file.path || file.name}>
      <span className="vc-filecard-icon"><TI icon={artifactIcon(file.mime, file.name)} size={22} /></span>
      <span className="vc-filecard-text">
        <span className="vc-filecard-name">{file.name}</span>
        <span className="vc-filecard-kind">{artifactLabel(file.mime, file.name)}</span>
      </span>
    </button>
  )
}
