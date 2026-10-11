import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AuthError } from '../api'
import {
  Hi, ArrowPathIcon, ChatBubbleOvalLeftIcon, LockClosedIcon, MagnifyingGlassIcon, PencilSquareIcon, XMarkIcon,
} from '../icons'
import { AppleError, appleEnabled, listChats, searchMessages, type AppleStatus, type ChatSummary, type SearchResult } from './api'
import { listTime, previewText } from './format'
import { usePoll } from './usePoll'
import Thread from './Thread'
import NewMessage from './NewMessage'
import Avatar from './Avatar'
import './messages.css'

// Messages from the Mac the bridge runs on: the owner's iMessage and SMS
// history, read from chat.db, and replies sent through the Messages app.
// Two panes on a desktop (conversations | thread), one on a phone, where
// opening a thread pushes a history entry so Back returns to the list.

const LIST_POLL_MS = 15_000

/** ?chat=<id> on /messages opens that conversation (kept by buildPath in router.ts). */
function chatFromUrl(): number | null {
  const v = new URLSearchParams(window.location.search).get('chat')
  return v && /^\d+$/.test(v) ? Number(v) : null
}

function writeChatToUrl(id: number | null, push: boolean) {
  const url = new URL(window.location.href)
  if (id === null) url.searchParams.delete('chat')
  else url.searchParams.set('chat', String(id))
  const path = url.pathname + url.search + url.hash
  if (path === window.location.pathname + window.location.search + window.location.hash) return
  if (push) window.history.pushState({ ...(window.history.state || {}), msgChat: id }, '', path)
  else window.history.replaceState(window.history.state, '', path)
}

interface Props {
  status: AppleStatus | null
  onRefreshStatus: () => Promise<void> | void
  onAuthError: () => void
  narrow: boolean
}

export default function MessagesView({ status, onRefreshStatus, onAuthError, narrow }: Props) {
  if (!status) return <div className="msgs-state"><p className="muted">Checking Messages on this Mac…</p></div>
  if (!appleEnabled(status)) {
    return (
      <StatePanel icon={ChatBubbleOvalLeftIcon} title="Messages is off">
        <p>Totem reads Messages only when it runs on a Mac with <code>APPLE_ENABLED=true</code> set.</p>
        {status.detail && <p className="muted">{status.detail}</p>}
      </StatePanel>
    )
  }
  const source = status.sources?.messages
  if (source?.state === 'no-access') return <NoAccess detail={source.detail} onRetry={onRefreshStatus} />
  if (source?.state === 'missing' || source?.state === 'error') {
    return (
      <StatePanel icon={ChatBubbleOvalLeftIcon} title="Messages isn't readable">
        <p>{source.detail || 'Totem could not open the Messages database on this Mac.'}</p>
        <RetryButton onRetry={onRefreshStatus} />
      </StatePanel>
    )
  }
  return <Messages onAuthError={onAuthError} narrow={narrow} onRefreshStatus={onRefreshStatus} />
}

function StatePanel({ icon, title, children }: { icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; title: string; children: React.ReactNode }) {
  return (
    <div className="msgs-state">
      <div className="msgs-state-card">
        <Hi icon={icon} size={26} className="msgs-state-icon" />
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

function RetryButton({ onRetry }: { onRetry: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false)
  return (
    <button type="button" className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await onRetry() } finally { setBusy(false) } }}>
      <Hi icon={ArrowPathIcon} size={15} />{busy ? 'Checking…' : 'Check again'}
    </button>
  )
}

function NoAccess({ detail, onRetry }: { detail?: string; onRetry: () => Promise<void> | void }) {
  return (
    <StatePanel icon={LockClosedIcon} title="Totem needs Full Disk Access">
      <p>macOS keeps Messages behind Full Disk Access, and the process running Totem doesn't have it yet.</p>
      {detail && <p className="msgs-state-fix">{detail}</p>}
      <RetryButton onRetry={onRetry} />
    </StatePanel>
  )
}

function Messages({ onAuthError, narrow, onRefreshStatus }: { onAuthError: () => void; narrow: boolean; onRefreshStatus: () => Promise<void> | void }) {
  const [selected, setSelected] = useState<number | null>(chatFromUrl)
  const [composing, setComposing] = useState(false)
  const [query, setQuery] = useState('')
  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const [found, setFound] = useState<SearchResult[]>([])
  const [listError, setListError] = useState<AppleError | Error | null>(null)
  const seq = useRef(0)

  const fail = useCallback((e: unknown) => {
    if (e instanceof AuthError) { onAuthError(); return true }
    return false
  }, [onAuthError])

  const loadList = useCallback((q: string) => {
    const mine = ++seq.current
    listChats(q)
      .then((list) => { if (mine === seq.current) { setChats(list); setListError(null) } })
      .catch((e) => { if (!fail(e) && mine === seq.current) setListError(e) })
    if (q.trim().length >= 2) {
      searchMessages(q)
        .then((r) => { if (mine === seq.current) setFound(r.slice(0, 30)) })
        .catch(() => { if (mine === seq.current) setFound([]) })
    } else {
      setFound([])
    }
  }, [fail])

  // Search a beat after the last key; the first load is immediate.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; loadList(query); return }
    const t = setTimeout(() => loadList(query), 250)
    return () => clearTimeout(t)
  }, [query, loadList])

  usePoll(() => loadList(query), LIST_POLL_MS)

  // Back/Forward (and a phone's swipe back) move between list and thread.
  useEffect(() => {
    const onPop = () => { setSelected(chatFromUrl()); setComposing(false) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // A desktop with nothing chosen opens the newest conversation, as Messages does.
  useEffect(() => {
    if (!narrow && selected === null && !composing && !query && chats?.length) {
      setSelected(chats[0].id)
      writeChatToUrl(chats[0].id, false)
    }
  }, [narrow, selected, composing, query, chats])

  const open = (id: number) => {
    setComposing(false)
    setSelected(id)
    writeChatToUrl(id, narrow && selected === null)
  }
  const back = () => {
    if (window.history.state?.msgChat) { window.history.back(); return }
    setSelected(null)
    setComposing(false)
    writeChatToUrl(null, false)
  }
  const startNew = () => {
    setComposing(true)
    if (narrow) { setSelected(null); writeChatToUrl(null, false) }
  }
  // The phone's top bar asks for a new message this way (App.tsx).
  const startNewRef = useRef(startNew)
  startNewRef.current = startNew
  useEffect(() => {
    const on = () => startNewRef.current()
    window.addEventListener('totem:new-message', on)
    return () => window.removeEventListener('totem:new-message', on)
  }, [])

  if (listError instanceof AppleError && listError.code === 'no_access') {
    return <NoAccess detail={listError.message} onRetry={async () => { await onRefreshStatus(); loadList(query) }} />
  }

  const summary = chats?.find((c) => c.id === selected) || null
  const showingDetail = composing || selected !== null

  return (
    <div className={`msgs ${showingDetail ? 'has-detail' : ''}`}>
      <section className="msgs-list" aria-label="Conversations">
        <header className="msgs-list-head">
          <h1>Messages</h1>
          <button type="button" className="msgs-icon-btn" onClick={startNew} title="New message" aria-label="New message">
            <Hi icon={PencilSquareIcon} size={20} />
          </button>
        </header>
        <div className="msgs-search">
          <Hi icon={MagnifyingGlassIcon} size={16} />
          <input
            type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search" aria-label="Search conversations and messages"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><Hi icon={XMarkIcon} size={15} /></button>
          )}
        </div>
        <div className="msgs-list-scroll">
          {listError && <p className="msgs-inline-error" role="alert">{listError.message}</p>}
          {chats === null && !listError && <p className="msgs-list-note">Loading conversations…</p>}
          {chats && chats.length === 0 && !query && (
            <p className="msgs-list-note">
              No conversations on this Mac yet. Turn on Messages in iCloud (Messages → Settings → iMessage) to bring your history over.
            </p>
          )}
          {chats && chats.length === 0 && query && !found.length && <p className="msgs-list-note">Nothing matches “{query.trim()}”.</p>}
          {chats && chats.length > 0 && (
            <ul className="msgs-rows">
              {chats.map((c) => <ChatRow key={c.id} chat={c} active={c.id === selected && !composing} onOpen={() => open(c.id)} />)}
            </ul>
          )}
          {found.length > 0 && (
            <>
              <h2 className="msgs-section">In messages</h2>
              <ul className="msgs-rows">
                {found.map((r) => (
                  <li key={r.messageId}>
                    <button type="button" className="msgs-row msgs-hit" onClick={() => open(r.chatId)}>
                      <span className="msgs-row-main">
                        <span className="msgs-row-top">
                          <span className="msgs-row-title">{r.chat}</span>
                          <span className="msgs-row-time">{listTime(r.at)}</span>
                        </span>
                        <span className="msgs-row-preview">{r.fromMe ? `You: ${r.text}` : r.text}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
      <section className="msgs-detail" aria-label={composing ? 'New message' : 'Conversation'}>
        {composing ? (
          <NewMessage
            onAuthError={onAuthError}
            onCancel={narrow ? back : () => setComposing(false)}
            onSent={(chatId) => {
              loadList(query)
              if (chatId !== null) open(chatId)
            }}
          />
        ) : selected !== null ? (
          <Thread
            key={selected}
            chatId={selected}
            summary={summary}
            narrow={narrow}
            onBack={back}
            onAuthError={onAuthError}
            onChanged={() => loadList(query)}
          />
        ) : (
          <div className="msgs-detail-empty muted">Choose a conversation.</div>
        )}
      </section>
    </div>
  )
}

function ChatRow({ chat, active, onOpen }: { chat: ChatSummary; active: boolean; onOpen: () => void }) {
  const unread = chat.unread > 0
  return (
    <li>
      <button type="button" className={`msgs-row ${active ? 'on' : ''} ${unread ? 'unread' : ''}`} onClick={onOpen} aria-current={active ? 'true' : undefined}>
        <Avatar title={chat.title} group={chat.isGroup} />
        <span className="msgs-row-main">
          <span className="msgs-row-top">
            <span className="msgs-row-title">{chat.title}</span>
            {chat.service === 'SMS' && <span className="msgs-sms" title="SMS">SMS</span>}
            <span className="msgs-row-time">{listTime(chat.last?.at)}</span>
          </span>
          <span className="msgs-row-bottom">
            <span className="msgs-row-preview">{previewText(chat.last)}</span>
            {unread && <span className="msgs-unread" aria-label={`${chat.unread} unread`}>{chat.unread > 99 ? '99+' : chat.unread}</span>}
          </span>
        </span>
      </button>
    </li>
  )
}
