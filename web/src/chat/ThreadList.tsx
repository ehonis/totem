import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useChat, groupThreads, threadTitle, renameThread, setPinned, keepThread, removeThread, regenerateTitle } from './store'
import type { ChatThread } from './types'
import { TI, useDismiss } from './ui'
import { IconDots, IconGhost2, IconPinned, IconPencil, IconTrash, IconSearch, IconX, IconCheck, IconSparkles } from './icons'
import { pushToast } from '../toast'
import ThreadIcon from './ThreadIcon'

function ThreadMenu({ t, onRename, onClose }: { t: ChatThread; onRename: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(true, ref, onClose)
  return (
    <div className="vc-menu vc-thread-menu" ref={ref} role="menu" onClick={(e) => e.stopPropagation()}>
      <button type="button" role="menuitem" onClick={() => { onClose(); onRename() }}><TI icon={IconPencil} size={16} /><span>Rename</span></button>
      {t.messages.some((m) => m.role === 'user') && (
        <button type="button" role="menuitem" onClick={() => { onClose(); regenerateTitle(t.id) }}><TI icon={IconSparkles} size={16} /><span>Regenerate title and icon</span></button>
      )}
      <button type="button" role="menuitem" onClick={() => { onClose(); setPinned(t.id, !t.pinned) }}><TI icon={IconPinned} size={16} /><span>{t.pinned ? 'Unpin' : 'Pin'}</span></button>
      {t.kind === 'temporary' && (
        <button type="button" role="menuitem" onClick={() => { onClose(); keepThread(t.id) }}><TI icon={IconCheck} size={16} /><span>Keep this chat</span></button>
      )}
      <div className="vc-menu-sep" />
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={() => {
          onClose()
          removeThread(t.id)
          pushToast(`Deleted “${threadTitle(t)}”`, 'info')
        }}
      >
        <TI icon={IconTrash} size={16} /><span>Delete</span>
      </button>
    </div>
  )
}

function ThreadItem({ t, active, live, onOpen }: { t: ChatThread; active: boolean; live: boolean; onOpen: (id: string) => void }) {
  const [menu, setMenu] = useState(false)
  const retitling = useChat((s) => !!s.retitling[t.id])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const close = useCallback(() => setMenu(false), [])
  const title = threadTitle(t)
  if (editing) {
    return (
      <div className="vc-thread editing">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (draft.trim() && draft.trim() !== title) renameThread(t.id, draft.trim()); setEditing(false) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') { setDraft(title); setEditing(false) }
          }}
          aria-label="Chat title"
        />
      </div>
    )
  }
  return (
    <div className={`vc-thread ${active ? 'active' : ''} ${menu ? 'menu-open' : ''}`}>
      <button type="button" className="vc-thread-main" onClick={() => onOpen(t.id)} title={title}>
        <ThreadIcon t={t} size={16} busy={retitling} />
        <span className={`vc-thread-title ${retitling ? 'vc-shimmer vc-retitling' : ''}`}>{title}</span>
        {live && <span className="vc-live-dot" aria-label="Answering" />}
      </button>
      <button type="button" className="vc-thread-more" onClick={(e) => { e.stopPropagation(); setMenu((m) => !m) }} aria-label={`Options for ${title}`}>
        <TI icon={IconDots} size={16} />
      </button>
      {menu && <ThreadMenu t={t} onRename={() => { setDraft(title); setEditing(true) }} onClose={close} />}
    </div>
  )
}

export default function ThreadList({ activeId, onOpen, limit, heading = 'Recents', searchSignal = 0 }: {
  activeId: string | null
  onOpen: (id: string) => void
  limit?: number
  heading?: string
  /** Bump to open and focus the search box (the panel's magnifier). */
  searchSignal?: number
}) {
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)
  const loaded = useChat((s) => s.loaded)
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  React.useEffect(() => { if (searchSignal) setSearching(true) }, [searchSignal])

  const filtered = useMemo(() => {
    // An empty chat (opened, never sent) is not history.
    const shown = threads.filter((t) => t.messages.length > 0 || t.id === activeId || runs[t.id])
    const term = q.trim().toLowerCase()
    if (!term) return shown
    return shown.filter((t) => threadTitle(t).toLowerCase().includes(term) || t.messages.some((m) => m.content.toLowerCase().includes(term)))
  }, [threads, q, activeId, runs])
  const groups = useMemo(() => groupThreads(limit && !q ? filtered.slice(0, limit) : filtered), [filtered, limit, q])

  return (
    <div className="vc-threads">
      <div className="vc-threads-head">
        <span>{heading}</span>
        <button type="button" className="vc-icon-btn sm" onClick={() => { setSearching((s) => !s); setQ('') }} aria-label="Search chats" title="Search chats">
          <TI icon={searching ? IconX : IconSearch} size={15} />
        </button>
      </div>
      {searching && (
        <input className="vc-threads-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
      )}
      <div className="vc-threads-list">
        {loaded && !threads.length && <div className="vc-threads-empty">Your chats will show up here.</div>}
        {q && !filtered.length && <div className="vc-threads-empty">No chats match “{q}”.</div>}
        {groups.map((g) => (
          <div key={g.label} className="vc-thread-group">
            <div className="vc-thread-group-label">{g.label}</div>
            {g.threads.map((t) => <ThreadItem key={t.id} t={t} active={t.id === activeId} live={!!runs[t.id]} onOpen={onOpen} />)}
          </div>
        ))}
      </div>
    </div>
  )
}
