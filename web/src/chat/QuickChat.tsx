import React, { useEffect, useRef, useState } from 'react'
import { useChat, send, stop, steer, keepThread, setActive, threadTitle, providerById } from './store'
import Composer from './Composer'
import { UserMessage, AssistantMessage } from './Message'
import { TI } from './ui'
import { useChatPresence } from './presence'
import { IconSparkles, IconX, IconChevronDown } from './icons'

// Ask Totem something without leaving the tab you're on. Desktop only (a phone
// has the Chat tab one thumb away). Each panel is a temporary chat on the
// default model; "Open in chat" moves it to the full view, and "Keep" saves it.

export default function QuickChat({ onOpenChat }: { onOpenChat: () => void }) {
  const [open, setOpen] = useState(false)
  const [id, setId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const thread = useChat((s) => (id ? s.threads.find((t) => t.id === id) || null : null))
  const runs = useChat((s) => s.runs)
  const caps = useChat((s) => s.caps)
  const busy = id ? !!runs[id] : false
  const logRef = useRef<HTMLDivElement>(null)
  // The quick panel counts as looking at its chat while it's open.
  useChatPresence(open ? id : null, open, 'quick')
  const messages = thread?.messages || []
  const last = messages[messages.length - 1]

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, last?.content.length, last?.parts?.length])

  // A thread deleted elsewhere (or expired at midnight) frees the panel.
  useEffect(() => { if (id && !thread && !busy) setId(null) }, [id, thread, busy])

  if (!open) {
    return (
      <button type="button" className="vc-quick-launch" onClick={() => setOpen(true)} title="Ask Totem without leaving this page">
        <TI icon={IconSparkles} size={20} stroke={2} />
        <span>Ask Totem</span>
      </button>
    )
  }

  return (
    <section className="vc vc-quick" aria-label="Quick chat">
      <header className="vc-quick-head">
        <span className="vc-quick-title">{thread ? threadTitle(thread) : 'Quick chat'}</span>
        {thread && (
          <>
            <button type="button" className="vc-btn sm ghost" onClick={() => { keepThread(thread.id); setActive(thread.id); onOpenChat(); setOpen(false); setId(null) }}>
              Open in chat
            </button>
          </>
        )}
        <button type="button" className="vc-icon-btn sm" onClick={() => setOpen(false)} aria-label="Minimise"><TI icon={IconChevronDown} size={16} /></button>
        {thread && (
          <button type="button" className="vc-icon-btn sm" onClick={() => { setId(null); setInput('') }} aria-label="Start over"><TI icon={IconX} size={16} /></button>
        )}
      </header>
      <div className="vc-quick-log" ref={logRef}>
        {!messages.length && <div className="vc-quick-empty">A temporary chat. It’s gone at midnight unless you open it in Chat.</div>}
        {messages.map((m, i) => (
          m.role === 'user'
            ? <UserMessage key={m.id} m={m} canEdit={false} onEdit={() => {}} />
            : <AssistantMessage key={m.id} m={m} live={busy && i === messages.length - 1} activity={id ? runs[id]?.activity : ''} provider={providerById(m.provider || '')} isLast={false} />
        ))}
      </div>
      <div className="vc-quick-dock">
        <Composer
          value={input}
          onChange={setInput}
          onSend={({ text, attachments, mode }) => {
            const next = send({ threadId: id, text, attachments, mode, kind: 'temporary' })
            setId(next)
            setInput('')
          }}
          onStop={() => id && stop(id)}
          onSteer={(text) => (id ? steer(id, text) : false)}
          busy={busy}
          compact
          autoFocus
          allowCommands={false}
          computerUse={Object.values(caps?.providers || {}).find((p) => p.computerUse?.available)?.computerUse}
          maxUploadBytes={caps?.maxUploadBytes}
          placeholder="Ask Totem"
        />
      </div>
    </section>
  )
}
