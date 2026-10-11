import React, { useEffect, useRef, useState } from 'react'
import { AuthError } from '../api'
import { Hi, ArrowUpIcon, XMarkIcon } from '../icons'
import { findContacts, sendMessage } from './api'
import { isSendKey, useAutosize } from './Thread'

interface Option { name: string; value: string; label: string }

/** A contact's numbers and addresses as pickable rows. */
function optionsFor(contacts: Awaited<ReturnType<typeof findContacts>>): Option[] {
  const out: Option[] = []
  for (const c of contacts) {
    for (const p of c.phones) out.push({ name: c.name, value: p.number, label: p.label || 'phone' })
    for (const e of c.emails) out.push({ name: c.name, value: e.address, label: e.label || 'email' })
  }
  return out.slice(0, 12)
}

interface Props {
  onSent: (chatId: number | null) => void
  onCancel: () => void
  onAuthError: () => void
}

export default function NewMessage({ onSent, onCancel, onAuthError }: Props) {
  const [to, setTo] = useState('')
  const [toName, setToName] = useState<string | null>(null)
  const [options, setOptions] = useState<Option[]>([])
  const [highlight, setHighlight] = useState(0)
  const [showOptions, setShowOptions] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const toRef = useRef<HTMLInputElement>(null)
  const textRef = useAutosize(text)

  useEffect(() => { toRef.current?.focus() }, [])

  // Look people up as the owner types, unless the field holds a picked contact.
  useEffect(() => {
    const q = to.trim()
    if (toName || q.length < 2) { setOptions([]); return }
    let live = true
    const t = setTimeout(() => {
      findContacts(q)
        .then((list) => { if (live) { setOptions(optionsFor(list)); setHighlight(0) } })
        .catch((e) => { if (e instanceof AuthError) onAuthError(); else if (live) setOptions([]) })
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [to, toName, onAuthError])

  const pick = (o: Option) => {
    setTo(o.value)
    setToName(o.name)
    setShowOptions(false)
    textRef.current?.focus()
  }

  const onToKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const open = showOptions && options.length > 0
    if (e.key === 'ArrowDown' && open) { e.preventDefault(); setHighlight((h) => (h + 1) % options.length) }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); setHighlight((h) => (h - 1 + options.length) % options.length) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (open) pick(options[highlight])
      else textRef.current?.focus()
    } else if (e.key === 'Escape') setShowOptions(false)
  }

  const send = async () => {
    const recipient = to.trim()
    const body = text.trim()
    if (!recipient || !body || sending) return
    setSending(true)
    setError(null)
    setNote(null)
    try {
      const out = await sendMessage({ to: recipient, text: body })
      setText('')
      if (out.chatId !== null && out.chatId !== undefined) onSent(out.chatId)
      else {
        setNote('Sent. It will show up in the list once Messages records it.')
        onSent(null)
      }
    } catch (e) {
      if (e instanceof AuthError) { onAuthError(); return }
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="msgs-thread msgs-new">
      <header className="msgs-thread-head">
        <div className="msgs-thread-title"><strong>New message</strong></div>
        <button type="button" className="msgs-icon-btn" onClick={onCancel} aria-label="Cancel new message" title="Cancel">
          <Hi icon={XMarkIcon} size={20} />
        </button>
      </header>
      <div className="msgs-to">
        <label htmlFor="msgs-to-input">To:</label>
        {toName ? (
          <span className="msgs-to-chip">
            {toName} <span className="muted">{to}</span>
            <button type="button" onClick={() => { setToName(null); setTo(''); setTimeout(() => toRef.current?.focus(), 0) }} aria-label="Remove recipient">
              <Hi icon={XMarkIcon} size={13} />
            </button>
          </span>
        ) : (
          <input
            id="msgs-to-input"
            ref={toRef}
            value={to}
            autoComplete="off"
            placeholder="Name, phone number or email"
            role="combobox"
            aria-expanded={showOptions && options.length > 0}
            aria-controls="msgs-to-options"
            onChange={(e) => { setTo(e.target.value); setShowOptions(true) }}
            onFocus={() => setShowOptions(true)}
            onBlur={() => setTimeout(() => setShowOptions(false), 120)}
            onKeyDown={onToKey}
          />
        )}
        {showOptions && options.length > 0 && !toName && (
          <ul className="msgs-to-options" id="msgs-to-options" role="listbox">
            {options.map((o, i) => (
              <li key={`${o.value}-${i}`} role="option" aria-selected={i === highlight}>
                <button
                  type="button" className={i === highlight ? 'on' : ''}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)} onMouseEnter={() => setHighlight(i)}
                >
                  <span>{o.name}</span>
                  <span className="muted">{o.label} · {o.value}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="msgs-scroll">
        <div className="msgs-log">
          {note && <p className="msgs-list-note">{note}</p>}
        </div>
      </div>
      <div className="msgs-compose">
        {error && <p className="msgs-send-error" role="alert">{error}</p>}
        <div className="msgs-compose-box">
          <textarea
            ref={textRef}
            rows={1}
            value={text}
            disabled={sending}
            placeholder="Message"
            aria-label="Message"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (isSendKey(e)) { e.preventDefault(); send() } }}
          />
          <button type="button" className="msgs-send" onClick={send} disabled={sending || !text.trim() || !to.trim()} aria-label="Send">
            <Hi icon={ArrowUpIcon} size={17} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </div>
  )
}
