import React, { useEffect, useMemo, useState } from 'react'
import { useChat, showFiles, loadFiles, openArtifact, fileArtifact, type FileEntry } from './store'
import { TI, formatBytes } from './ui'
import { IconX, IconFolder, IconFolderOpen, IconChevronRight, IconChevronDown, IconArrowDown, IconRefresh } from './icons'
import { artifactIcon, downloadUrl } from './ArtifactPanel'

// T3 Code's files viewer, for a chat: the folder its agent saves into on the box
// (data/chat-outputs/<thread>/, listed by chat/files.mjs), beside the chat in the
// canvas slot. A file opens in the canvas; every row downloads, so whatever the
// agent made reaches the owner on whichever device he is reading from.

interface Row { entry: FileEntry; depth: number }

function visibleRows(entries: FileEntry[], closed: Set<string>): Row[] {
  const out: Row[] = []
  for (const entry of entries) {
    const parts = entry.rel.split('/')
    // Hidden when any folder above it is folded.
    let hidden = false
    for (let i = 1; i < parts.length && !hidden; i++) hidden = closed.has(parts.slice(0, i).join('/'))
    if (!hidden) out.push({ entry, depth: parts.length - 1 })
  }
  return out
}

export const useThreadFiles = (threadId: string | null) => useChat((s) => (threadId ? s.files[threadId] : undefined))

export default function FilesPanel({ threadId }: { threadId: string | null }) {
  const open = useChat((s) => s.filesOpen)
  const listing = useThreadFiles(threadId)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const rows = useMemo(() => visibleRows(listing?.entries || [], closed), [listing, closed])
  const count = listing?.entries.filter((e) => !e.dir).length || 0

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') showFiles(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open || !threadId) return null
  const toggle = (rel: string) => setClosed((c) => { const n = new Set(c); if (n.has(rel)) n.delete(rel); else n.add(rel); return n })
  return (
    <aside className="vc vc-artifact vc-files" aria-label="Files">
      <header className="vc-art-head">
        <div className="vc-agents-title">
          <TI icon={IconFolder} size={18} />
          <span>Files</span>
          {count > 0 && <span className="vc-agents-count">{count} file{count === 1 ? '' : 's'}</span>}
        </div>
        <div className="vc-art-actions">
          <button type="button" className="vc-icon-btn" onClick={() => loadFiles(threadId)} aria-label="Refresh" title="Refresh"><TI icon={IconRefresh} size={17} /></button>
          <button type="button" className="vc-icon-btn" onClick={() => showFiles(false)} aria-label="Hide" title="Hide"><TI icon={IconX} size={17} /></button>
        </div>
      </header>
      <div className="vc-art-body vc-files-body">
        {!listing ? <div className="vc-art-loading">Loading…</div> : !rows.length ? (
          <div className="vc-agents-empty">
            <TI icon={IconFolder} size={26} />
            <p className="vc-agents-empty-title">No files yet</p>
            <p>Spreadsheets, documents and pages this chat's agent makes are saved here, ready to open or download from any device.</p>
          </div>
        ) : (
          <ul className="vc-files-tree" role="tree">
            {rows.map(({ entry, depth }) => (
              <li key={entry.path} role="treeitem" aria-expanded={entry.dir ? !closed.has(entry.rel) : undefined} style={{ '--depth': depth } as React.CSSProperties}>
                {entry.dir ? (
                  <button type="button" className="vc-file-row" onClick={() => toggle(entry.rel)} title={entry.path}>
                    <TI icon={closed.has(entry.rel) ? IconChevronRight : IconChevronDown} size={14} className="vc-chev" />
                    <TI icon={closed.has(entry.rel) ? IconFolder : IconFolderOpen} size={17} />
                    <span className="vc-file-name">{entry.name}</span>
                  </button>
                ) : (
                  <div className="vc-file-row">
                    <button type="button" className="vc-file-open" onClick={() => openArtifact(fileArtifact(entry.path, entry.size))} title={entry.path}>
                      <TI icon={artifactIcon(entry.mime || '', entry.name)} size={17} />
                      <span className="vc-file-name">{entry.name}</span>
                      {entry.size != null && <span className="vc-file-size">{formatBytes(entry.size)}</span>}
                    </button>
                    <a className="vc-icon-btn" href={downloadUrl(fileArtifact(entry.path).url)} download={entry.name} title="Download" aria-label={`Download ${entry.name}`}>
                      <TI icon={IconArrowDown} size={16} />
                    </a>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {listing?.truncated && <p className="vc-files-note">Showing the first {listing.entries.length} entries.</p>}
        {listing && <p className="vc-files-note" title={listing.root}>{listing.root}</p>}
      </div>
    </aside>
  )
}

/** The header chip that opens the panel, once the chat has saved something. */
export function FilesChip({ threadId }: { threadId: string | null }) {
  const listing = useThreadFiles(threadId)
  const open = useChat((s) => s.filesOpen)
  const count = listing?.entries.filter((e) => !e.dir).length || 0
  if (!count || open) return null
  return (
    <button type="button" className="vc-agents-chip" onClick={() => showFiles(true)} title="Files this chat saved">
      <TI icon={IconFolder} size={15} />
      <span>{count} file{count === 1 ? '' : 's'}</span>
    </button>
  )
}
