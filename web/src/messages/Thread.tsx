import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AuthError } from '../api'
import { Hi, ArrowUpIcon, ChevronLeftIcon, DocumentIcon } from '../icons'
import { attachmentUrl, getThread, sendMessage, type ChatSummary, type Message, type MessageAttachment } from './api'
import { dividerTime, fileSize, isImage, isVideo, layoutThread, mergeLatest, prependOlder, reactionLabel } from './format'
import { usePoll } from './usePoll'
import Avatar from './Avatar'

const THREAD_POLL_MS = 5_000
/** Within this many pixels of the end counts as "reading the latest". */
const BOTTOM_SLACK = 48

interface Props {
  chatId: number
  /** The list's row for this chat, so the header shows before the thread loads. */
  summary: ChatSummary | null
  narrow: boolean
  onBack: () => void
  onAuthError: () => void
  /** Something changed that the conversation list should pick up (a send). */
  onChanged: () => void
}

export default function Thread({ chatId, summary, narrow, onBack, onAuthError, onChanged }: Props) {
  const [chat, setChat] = useState<ChatSummary | null>(summary)
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  // What the next render should do to the scroll position.
  const pending = useRef<{ kind: 'bottom' } | { kind: 'older'; height: number; top: number } | null>({ kind: 'bottom' })

  const handle = useCallback((e: unknown) => {
    if (e instanceof AuthError) { onAuthError(); return null }
    return e instanceof Error ? e.message : String(e)
  }, [onAuthError])

  const refresh = useCallback((first = false) => {
    return getThread(chatId)
      .then((page) => {
        setChat(page.chat)
        setMessages((prev) => (prev && !first ? mergeLatest(prev, page.messages) : page.messages))
        // A poll's page says nothing about what lies before the pages already loaded.
        if (first) setHasMore(page.hasMore)
        setLoadError(null)
      })
      .catch((e) => { const msg = handle(e); if (msg && first) setLoadError(msg) })
  }, [chatId, handle])

  useEffect(() => { refresh(true) }, [refresh])
  usePoll(() => { refresh() }, THREAD_POLL_MS, messages !== null)

  const loadOlder = () => {
    if (!messages?.length || loadingOlder) return
    setLoadingOlder(true)
    getThread(chatId, { before: messages[0].id })
      .then((page) => {
        const el = scroller.current
        pending.current = el ? { kind: 'older', height: el.scrollHeight, top: el.scrollTop } : null
        setMessages((prev) => prependOlder(prev || [], page.messages))
        setHasMore(page.hasMore)
      })
      .catch((e) => { const msg = handle(e); if (msg) setLoadError(msg) })
      .finally(() => setLoadingOlder(false))
  }

  // Keep the reader where they were: pinned to the end if they were at it,
  // anchored on the same message when older ones arrive above, untouched otherwise.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !messages) return
    const want = pending.current
    pending.current = null
    if (want?.kind === 'older') el.scrollTop = want.top + (el.scrollHeight - want.height)
    else if (want?.kind === 'bottom' || atBottom.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = () => {
    const el = scroller.current
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK
  }
  // An image finishing late grows the thread; follow it if the reader is at the end.
  const onMediaLoad = () => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }

  const items = useMemo(() => layoutThread(messages || [], !!chat?.isGroup), [messages, chat?.isGroup])
  const lastMine = useMemo(() => {
    for (let i = (messages?.length || 0) - 1; i >= 0; i--) if (messages![i].fromMe) return messages![i].id
    return null
  }, [messages])

  const title = chat?.title || summary?.title || 'Conversation'
  const isGroup = !!(chat?.isGroup ?? summary?.isGroup)
  const service = chat?.service || summary?.service
  const people = chat?.participants || summary?.participants || []
  const subtitle = isGroup
    ? people.map((p) => p.name || p.handle).join(', ')
    : (people[0] && people[0].name && people[0].handle !== title ? people[0].handle : '')

  return (
    <div className="msgs-thread">
      <header className="msgs-thread-head">
        {narrow && (
          <button type="button" className="msgs-icon-btn" onClick={onBack} aria-label="Back to conversations">
            <Hi icon={ChevronLeftIcon} size={22} />
          </button>
        )}
        <Avatar title={title} group={isGroup} size={34} />
        <div className="msgs-thread-title">
          <strong>{title}</strong>
          {(subtitle || service === 'SMS') && (
            <span className="muted">{[service === 'SMS' ? 'SMS' : '', subtitle].filter(Boolean).join(' · ')}</span>
          )}
        </div>
      </header>

      <div className="msgs-scroll" ref={scroller} onScroll={onScroll}>
        <div className="msgs-log">
          {loadError && !messages && <p className="msgs-inline-error" role="alert">{loadError}</p>}
          {!messages && !loadError && <p className="msgs-list-note">Loading…</p>}
          {hasMore && (
            <button type="button" className="msgs-older" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? 'Loading…' : 'Load older messages'}
            </button>
          )}
          {messages && messages.length === 0 && <p className="msgs-list-note">No messages in this conversation yet.</p>}
          {items.map(({ message: m, divider, showSender, first, last }) => (
            <React.Fragment key={m.id}>
              {divider && <div className="msgs-divider">{divider}</div>}
              <div className={`msgs-msg ${m.fromMe ? 'mine' : 'theirs'} ${first ? 'first' : ''} ${last ? 'last' : ''}`}>
                {showSender && <span className="msgs-sender">{m.senderName || m.sender}</span>}
                {m.attachments.map((a) => <Attachment key={a.id} a={a} onLoad={onMediaLoad} />)}
                {m.text && (
                  <div className="msgs-bubble" title={dividerTime(m.at)}><Linkified text={m.text} /></div>
                )}
                {m.reactions.length > 0 && (
                  <div className="msgs-reactions">
                    {m.reactions.map((r, i) => <span key={i} className="msgs-reaction">{reactionLabel(r)}</span>)}
                  </div>
                )}
                {m.failed && <span className="msgs-receipt failed">Not delivered</span>}
                {!m.failed && m.id === lastMine && m.readAt && (
                  <span className="msgs-receipt">Read {new Date(m.readAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                )}
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>

      <Composer
        chatId={chatId}
        sms={service === 'SMS'}
        onAuthError={onAuthError}
        onSent={() => {
          pending.current = { kind: 'bottom' }
          refresh()
          onChanged()
        }}
      />
    </div>
  )
}

function Attachment({ a, onLoad }: { a: MessageAttachment; onLoad: () => void }) {
  const url = attachmentUrl(a.id)
  if (isImage(a)) {
    return (
      <a className={`msgs-media ${a.sticker ? 'sticker' : ''}`} href={url} target="_blank" rel="noreferrer" title={a.name || 'Image'}>
        <img src={url} alt={a.name || 'Image'} loading="lazy" onLoad={onLoad} />
      </a>
    )
  }
  if (isVideo(a)) {
    return <video className="msgs-media msgs-video" src={url} controls preload="metadata" onLoadedMetadata={onLoad} />
  }
  return (
    <a className="msgs-file" href={url} target="_blank" rel="noreferrer">
      <Hi icon={DocumentIcon} size={18} />
      <span className="msgs-file-name">{a.name || 'Attachment'}</span>
      {a.bytes > 0 && <span className="msgs-file-size">{fileSize(a.bytes)}</span>}
    </a>
  )
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)"'\]])/g

/** Message text with its web links clickable. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE)
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1
        ? <a key={i} href={p} target="_blank" rel="noreferrer noopener">{p}</a>
        : <React.Fragment key={i}>{p}</React.Fragment>))}
    </>
  )
}

export function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [value])
  return ref
}

/** Enter sends, Shift+Enter is a new line; nothing fires mid-IME composition. */
export const isSendKey = (e: React.KeyboardEvent) => e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing

function Composer({ chatId, sms, onSent, onAuthError }: { chatId: number; sms: boolean; onSent: () => void; onAuthError: () => void }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useAutosize(text)

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    setError(null)
    try {
      await sendMessage({ chat: chatId, text: body })
      setText('')
      onSent()
    } catch (e) {
      if (e instanceof AuthError) { onAuthError(); return }
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
      // After the re-render that re-enables it; a disabled textarea won't take focus.
      setTimeout(() => ref.current?.focus(), 0)
    }
  }

  return (
    <div className="msgs-compose">
      {error && <p className="msgs-send-error" role="alert">{error}</p>}
      <div className="msgs-compose-box">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={sending}
          placeholder={sms ? 'Text Message' : 'iMessage'}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (isSendKey(e)) { e.preventDefault(); send() } }}
        />
        <button type="button" className={`msgs-send ${sms ? 'sms' : ''}`} onClick={send} disabled={sending || !text.trim()} aria-label="Send">
          <Hi icon={ArrowUpIcon} size={17} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  )
}
