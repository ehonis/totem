import React, { useEffect, useRef, useState } from 'react'
import { useChat, showBrowser, closeBrowser, browserInput, answerHandoff } from './store'
import { TI } from './ui'
import { IconWorld, IconX, IconExternalLink, IconPlayerStopFilled, IconHandClick } from './icons'

// What the chat's agent is looking at, the way T3 Code shows its collaborative
// browser beside the thread: the page it has open, its address, and whether it
// is still driving. Frames arrive with every page change (bridge `browser`
// events); between them the last one stays up. The owner can drive it too:
// clicks, keys, paste and the wheel go to the page (useDriveBrowser), which is
// how he signs in to something the agent must not type a password into. While
// the agent is driving, the page is look-only so the two don't fight over it,
// unless it has handed the browser over (preview_handoff): then a banner says
// what it needs, and Done or Skip gives it back.

function host(url: string) {
  try { return new URL(url).host.replace(/^www\./, '') } catch { return url }
}

export function useChatBrowser(threadId: string | null) {
  return useChat((s) => (threadId ? s.browser[threadId] || null : null))
}

// Keys that mean something to the page rather than text to insert.
const PAGE_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

/**
 * Forward the owner's input to the chat's browser. Clicks map from the shown
 * frame to viewport pixels (the frame is the viewport at scale 1); keys go
 * through a hidden textarea so a phone raises its keyboard. Typed characters
 * are batched, and flushed before any key press so "password, Enter" lands in
 * order. A late look after each burst catches what the page did afterwards.
 */
function useDriveBrowser(threadId: string, shown: boolean, enabled: boolean) {
  const img = useRef<HTMLImageElement>(null)
  const keys = useRef<HTMLTextAreaElement>(null)
  const pending = useRef('')
  const typeTimer = useRef<number>()
  const lookTimer = useRef<number>()
  const wheel = useRef({ dx: 0, dy: 0, timer: 0 })
  const [typing, setTyping] = useState(false)

  const send = (input: Parameters<typeof browserInput>[1]) => {
    void browserInput(threadId, input)
    window.clearTimeout(lookTimer.current)
    lookTimer.current = window.setTimeout(() => void browserInput(threadId, { kind: 'look' }), 1200)
  }
  const flush = () => {
    window.clearTimeout(typeTimer.current)
    if (pending.current) { send({ kind: 'type', text: pending.current }); pending.current = '' }
  }
  const queueText = (text: string) => {
    pending.current += text
    window.clearTimeout(typeTimer.current)
    typeTimer.current = window.setTimeout(flush, 150)
  }

  useEffect(() => () => { window.clearTimeout(typeTimer.current); window.clearTimeout(lookTimer.current); window.clearTimeout(wheel.current.timer) }, [])

  // A native listener, since React's wheel handler is passive and the panel would scroll too.
  useEffect(() => {
    const el = img.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!enabled) return
      e.preventDefault()
      const w = wheel.current
      w.dx += e.deltaX
      w.dy += e.deltaY
      if (w.timer) return
      w.timer = window.setTimeout(() => {
        const { dx, dy } = w
        w.dx = 0; w.dy = 0; w.timer = 0
        if (dx || dy) send({ kind: 'scroll', deltaX: Math.round(dx), deltaY: Math.round(dy) })
      }, 120)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [threadId, shown, enabled])

  const onClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!enabled) return
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    if (!rect.width || !el.naturalWidth) return
    flush()
    send({ kind: 'click', x: Math.round((e.clientX - rect.left) * el.naturalWidth / rect.width), y: Math.round((e.clientY - rect.top) * el.naturalHeight / rect.height) })
    keys.current?.focus({ preventScroll: true })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    const chord = (e.ctrlKey || e.metaKey) && e.key.length === 1 && e.key.toLowerCase() !== 'v'
    if (!PAGE_KEYS.has(e.key) && !chord) return
    e.preventDefault()
    e.stopPropagation()
    flush()
    const modifiers = [e.altKey && 'Alt', e.ctrlKey && 'Control', e.metaKey && 'Meta', e.shiftKey && chord && 'Shift'].filter(Boolean) as string[]
    send({ kind: 'press', key: e.key.length === 1 ? e.key.toLowerCase() : e.key, modifiers })
  }

  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as InputEvent).isComposing) return
    const el = e.currentTarget
    if (el.value) queueText(el.value)
    el.value = ''
  }

  const textarea = (
    <textarea
      ref={keys}
      className="vc-browser-keys"
      aria-label="Type into the page"
      autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
      onKeyDown={onKeyDown}
      onInput={onInput}
      onCompositionEnd={(e) => { if (e.currentTarget.value) queueText(e.currentTarget.value); e.currentTarget.value = '' }}
      onFocus={() => setTyping(true)}
      onBlur={() => { flush(); setTyping(false) }}
    />
  )
  return { img, onClick, textarea, typing }
}

export default function BrowserPanel({ threadId }: { threadId: string | null }) {
  const frame = useChatBrowser(threadId)
  const open = useChat((s) => s.browserOpen)
  const handoff = useChat((s) => (threadId ? s.handoffs[threadId] || null : null))
  const yours = !!frame && (!frame.live || !!handoff)
  const drive = useDriveBrowser(threadId || '', open && !!frame, yours)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') showBrowser(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open || !frame || !threadId) return null
  const web = /^https?:/i.test(frame.url)
  return (
    <aside className="vc vc-artifact vc-browser" aria-label="Browser">
      <header className="vc-art-head">
        <div className="vc-browser-bar" title={frame.url}>
          <TI icon={IconWorld} size={16} />
          <span className="vc-browser-host">{web ? host(frame.url) : frame.url || 'about:blank'}</span>
          {web && <span className="vc-browser-path">{frame.url.replace(/^https?:\/\/[^/]+/, '')}</span>}
          {frame.live && <span className="vc-browser-live"><i />Live</span>}
        </div>
        <div className="vc-art-actions">
          {web && (
            <a className="vc-icon-btn" href={frame.url} target="_blank" rel="noreferrer noopener" aria-label="Open this page in a new tab" title="Open in a new tab">
              <TI icon={IconExternalLink} size={17} />
            </a>
          )}
          {!frame.live && (
            <button type="button" className="vc-icon-btn" onClick={() => closeBrowser(threadId)} aria-label="Close the browser" title="Close the browser (tabs and sign-ins)">
              <TI icon={IconPlayerStopFilled} size={15} />
            </button>
          )}
          <button type="button" className="vc-icon-btn" onClick={() => showBrowser(false)} aria-label="Hide" title="Hide">
            <TI icon={IconX} size={17} />
          </button>
        </div>
      </header>
      <div className="vc-art-body vc-browser-body">
        {handoff && (
          <div className="vc-browser-handoff" role="status">
            <TI icon={IconHandClick} size={18} />
            <span><b>Your turn:</b> {handoff.reason}</span>
            <button type="button" className="vc-browser-handoff-skip" onClick={() => answerHandoff(threadId, 'skip')}>Skip</button>
            <button type="button" className="vc-browser-handoff-done" onClick={() => answerHandoff(threadId, 'done')}>Done</button>
          </div>
        )}
        <figure className={`vc-browser-frame ${frame.live ? 'live' : ''} ${drive.typing ? 'typing' : ''} ${yours ? 'yours' : ''}`}>
          <img ref={drive.img} src={frame.image} alt={frame.title ? `Screenshot of ${frame.title}` : 'What the browser is showing'} onClick={drive.onClick} draggable={false} />
          {yours && drive.textarea}
          <figcaption>
            {!yours ? 'The agent is driving' : drive.typing ? 'Your keys go to the page' : 'Click to use this page yourself'}
            {frame.title && <> · {frame.title}</>}
          </figcaption>
        </figure>
      </div>
    </aside>
  )
}

/** The chip that brings the browser back: in the header, or above the composer on a phone. */
export function BrowserChip({ threadId, className = '' }: { threadId: string | null; className?: string }) {
  const frame = useChatBrowser(threadId)
  const open = useChat((s) => s.browserOpen)
  const waiting = useChat((s) => !!(threadId && s.handoffs[threadId]))
  if (!frame || open) return null
  return (
    <button type="button" className={`vc-browser-chip ${frame.live ? 'live' : ''} ${waiting ? 'waiting' : ''} ${className}`} onClick={() => showBrowser(true)} title={frame.url}>
      <img src={frame.image} alt="" />
      <span>{waiting ? 'Your turn' : frame.live ? 'Browsing' : 'Browser'} · {host(frame.url) || 'blank'}</span>
    </button>
  )
}
