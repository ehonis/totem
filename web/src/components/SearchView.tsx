import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AuthError, getSearchDoc, searchEverything, searchResultAsContext, type SearchHit, type SearchResponse } from '../api'
import { useChat, setActive, openProject, threadTitle } from '../chat/store'
import { queueContext } from '../chat/pendingContext'
import { useDismiss } from '../chat/ui'
import type { Attachment } from '../chat/types'
import type { NavTarget } from '../router'
import { pushError } from '../toast'
import Markdown from './Markdown'
import TotemsIcon from './TotemsIcon'
import {
  Hi, MagnifyingGlassIcon, BookOpenIcon, MicrophoneIcon, ChatBubbleLeftRightIcon, CheckCircleIcon, FlagIcon,
  ClipboardIcon, FolderIcon, ArrowTopRightOnSquareIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon, XMarkIcon,
} from '../icons'
import './search.css'

// Highlight markers from search/index.mjs.
const MARK_START = '\u0002'
const MARK_END = '\u0003'

type IconType = React.ComponentType<React.SVGProps<SVGSVGElement>>
const KINDS: { id: string; label: string; icon: IconType }[] = [
  { id: 'note', label: 'Memory', icon: BookOpenIcon },
  { id: 'chat', label: 'Chats', icon: ChatBubbleLeftRightIcon },
  { id: 'journal', label: 'Journal', icon: MicrophoneIcon },
  { id: 'task', label: 'Tasks', icon: CheckCircleIcon },
  { id: 'goal', label: 'Goals', icon: FlagIcon },
  { id: 'list', label: 'Lists', icon: ClipboardIcon },
  { id: 'project', label: 'Projects', icon: FolderIcon },
  { id: 'totem', label: 'Totems', icon: TotemsIcon },
]
const kindOf = (id: string) => KINDS.find((k) => k.id === id)

/** Text with search highlights as <mark>. */
function Marked({ text }: { text?: string }) {
  if (!text) return null
  const out: React.ReactNode[] = []
  text.split(MARK_START).forEach((chunk, i) => {
    if (i === 0) { out.push(chunk); return }
    const [hit, ...rest] = chunk.split(MARK_END)
    out.push(<mark key={i}>{hit}</mark>, rest.join(''))
  })
  return <>{out}</>
}

function readQuery() {
  return new URLSearchParams(window.location.search).get('q') || ''
}

interface SearchViewProps {
  onAuthError: () => void
  onNavigate: (target: NavTarget) => void
}

export default function SearchView({ onAuthError, onNavigate }: SearchViewProps) {
  const [query, setQuery] = useState(readQuery)
  const [kinds, setKinds] = useState<string[]>([])
  const [res, setRes] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  useEffect(() => { input.current?.focus() }, [])

  // Search as you type, a beat after the last key. A stale reply never
  // overwrites a newer one.
  useEffect(() => {
    const q = query.trim()
    const url = new URL(window.location.href)
    if (q) url.searchParams.set('q', q)
    else url.searchParams.delete('q')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    if (!q) { setRes(null); setLoading(false); return }
    const mine = ++seq.current
    setLoading(true)
    const t = setTimeout(() => {
      searchEverything(q, kinds)
        .then((r) => { if (mine === seq.current) setRes(r) })
        .catch((e) => { if (e instanceof AuthError) onAuthError(); else pushError(e.message) })
        .finally(() => { if (mine === seq.current) setLoading(false) })
    }, 140)
    return () => clearTimeout(t)
  }, [query, kinds, onAuthError])

  const toggleKind = (id: string) => setKinds((k) => (k.includes(id) ? k.filter((x) => x !== id) : [...k, id]))

  const open = useCallback((hit: SearchHit) => {
    const t = hit.target || {}
    if (t.tab === 'chat' && t.thread) { setActive(t.thread); onNavigate('chat'); return }
    if (t.tab === 'chat' && t.project) { openProject(t.project); onNavigate('chat'); return }
    if (t.tab === 'brain' && t.path) { onNavigate({ tab: 'brain', hash: t.path }); return }
    if (t.tab === 'totems' && t.totem) {
      window.history.replaceState(window.history.state, '', `/totems?totem=${encodeURIComponent(t.totem)}`)
      onNavigate('totems')
      return
    }
    onNavigate({ tab: t.tab, app: t.app })
  }, [onNavigate])

  // Save the result as a text attachment and hand it to the composer of the
  // chosen chat (null: a new chat on Home).
  const addToChat = useCallback(async (hit: SearchHit, threadId: string | null) => {
    try {
      const { attachment } = (await searchResultAsContext(hit.id)) as { attachment: Attachment }
      queueContext(attachment)
      if (threadId) setActive(threadId)
      else openProject(null)
      onNavigate('chat')
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError()
      else pushError(e.message)
    }
  }, [onAuthError, onNavigate])

  const q = query.trim()
  const results = res?.results || []

  return (
    <div className="view search-view">
      <div className="search-box">
        <Hi icon={MagnifyingGlassIcon} size={18} className="search-box-icon" />
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }}
          placeholder="Search memory, chats, journal, tasks, goals, lists…"
          aria-label="Search everything"
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button type="button" className="search-clear" onClick={() => { setQuery(''); input.current?.focus() }} aria-label="Clear">
            <Hi icon={XMarkIcon} size={16} />
          </button>
        )}
      </div>

      <div className="search-kinds" role="group" aria-label="Filter by kind">
        {KINDS.map((k) => {
          const n = res?.counts?.[k.id] || 0
          const on = kinds.includes(k.id)
          return (
            <button key={k.id} type="button" className={`search-kind${on ? ' on' : ''}${q && !n && !on ? ' zero' : ''}`} onClick={() => toggleKind(k.id)} aria-pressed={on}>
              <Hi icon={k.icon} size={14} />
              {k.label}
              {q && n > 0 && <span className="search-kind-n">{n}</span>}
            </button>
          )
        })}
      </div>

      {!q && (
        <p className="muted search-hint">
          Plain keyword search, with no AI involved: every word has to match, and "watch" also finds "watches". Open a result, or add it to a chat as context.
        </p>
      )}
      {q && res && !results.length && !loading && <p className="muted search-hint">Nothing matches “{q}”.</p>}
      {res?.loose && results.length > 0 && <p className="muted search-hint">Nothing has every word, so these match some of them.</p>}

      <ol className={`search-results${loading ? ' loading' : ''}`}>
        {results.map((hit) => (
          <ResultCard key={hit.id} hit={hit} onOpen={() => open(hit)} onAddToChat={(threadId) => addToChat(hit, threadId)} onAuthError={onAuthError} />
        ))}
      </ol>
      {res && res.total > results.length && <p className="muted search-hint">Showing the top {results.length} of {res.total}. Add a word or pick a kind to narrow it down.</p>}
    </div>
  )
}

function ResultCard({ hit, onOpen, onAddToChat, onAuthError }: {
  hit: SearchHit
  onOpen: () => void
  onAddToChat: (threadId: string | null) => void
  onAuthError: () => void
}) {
  const kind = kindOf(hit.kind)
  const [expanded, setExpanded] = useState(false)
  const [full, setFull] = useState<{ body: string; location: string } | null>(null)

  async function toggle() {
    if (!expanded && !full) {
      try { setFull(await getSearchDoc(hit.id)) }
      catch (e: any) { if (e instanceof AuthError) return onAuthError(); pushError(e.message); return }
    }
    setExpanded((x) => !x)
  }

  return (
    <li className="search-hit">
      <div className="search-hit-head">
        <span className="search-hit-kind" title={kind?.label}>{kind && <Hi icon={kind.icon} size={14} />}{kind?.label || hit.kind}</span>
        <button type="button" className="search-hit-title" onClick={toggle}>
          <Marked text={hit.titleMarked || hit.title} />
        </button>
        {hit.date && <span className="search-hit-date">{hit.date}</span>}
      </div>
      {!expanded && hit.snippet && <p className="search-hit-snippet"><Marked text={hit.snippet} /></p>}
      {expanded && full && (
        <div className="search-hit-full">
          <div className="search-hit-loc">{full.location}</div>
          <Markdown text={full.body} />
        </div>
      )}
      <div className="search-hit-actions">
        <button type="button" className="btn ghost sm" onClick={toggle}>
          <Hi icon={expanded ? ChevronDownIcon : ChevronRightIcon} size={14} /> {expanded ? 'Less' : 'Full text'}
        </button>
        <button type="button" className="btn ghost sm" onClick={onOpen}>
          <Hi icon={ArrowTopRightOnSquareIcon} size={14} /> Open
        </button>
        <AddToChat onPick={onAddToChat} />
      </div>
    </li>
  )
}

/** "Add to chat": a new chat, or one of the recent ones. */
function AddToChat({ onPick }: { onPick: (threadId: string | null) => void }) {
  const threads = useChat((s) => s.threads)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, useCallback(() => setOpen(false), []))

  const f = filter.trim().toLowerCase()
  const recent = threads
    .filter((t) => t.kind !== 'temporary' && t.messages?.length)
    .filter((t) => !f || threadTitle(t).toLowerCase().includes(f))
    .slice(0, 8)
  const pick = (id: string | null) => { setOpen(false); setFilter(''); onPick(id) }

  return (
    <div className="search-add" ref={ref}>
      <button type="button" className="btn sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Hi icon={PlusIcon} size={14} /> Add to chat
      </button>
      {open && (
        <div className="search-add-menu" role="menu">
          <button type="button" role="menuitem" className="search-add-new" onClick={() => pick(null)}>
            <Hi icon={PlusIcon} size={14} /> New chat
          </button>
          {threads.length > 0 && (
            <input
              className="search-add-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a chat…"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); if (e.key === 'Enter' && recent[0]) pick(recent[0].id) }}
            />
          )}
          {recent.map((t) => (
            <button key={t.id} type="button" role="menuitem" onClick={() => pick(t.id)}>
              <Hi icon={ChatBubbleLeftRightIcon} size={14} /> <span>{threadTitle(t)}</span>
            </button>
          ))}
          {f && !recent.length && <div className="muted search-add-none">No chat called that</div>}
        </div>
      )}
    </div>
  )
}
