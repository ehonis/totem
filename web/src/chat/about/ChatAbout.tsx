// "Chat about this" on a card or page. Dropped inside the card, it takes the
// card (its parent, or the nearest `host` above it) and adds: a small button
// that shows while the pointer is over the card, a right-click menu, and a
// long-press menu on a touch screen. Shift+right-click keeps the browser's own
// menu, and so does right-clicking a link, a field or selected text.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AuthError } from '../../api'
import { Hi, ChatBubbleLeftRightIcon, ClipboardDocumentIcon } from '../../icons'
import { pushError, pushSuccess } from '../../toast'
import type { ChatContext } from './context'
import { chatAboutAuthError, copyChatAbout, startChatAbout } from './start'
import './about.css'

const LONG_PRESS_MS = 500
const MOVE_SLOP = 10
// After a long press opens the menu, the presses the lift may still produce
// (the compatibility mousedown and click) belong to the press, not to the menu
// or the card. Real browsers drop them once touchend is cancelled; this covers
// the ones that don't.
const LIFT_GUARD_MS = 400
const NATIVE = 'input, textarea, select, a[href], [contenteditable="true"], .chat-about-menu'
// A touch the card's own handler claimed, so the card around it leaves it alone.
const CLAIMED = Symbol('chatAbout')

type Menu = { x: number; y: number; guardUntil: number }

export default function ChatAbout({ of, host, button = true }: {
  /** The card's context, read when it is used (so never stale), from the card's element. */
  of: (host: HTMLElement) => ChatContext | null | undefined
  /** CSS selector of the card, when the component sits deeper than its direct child. */
  host?: string
  /** False for a whole page or pane: menus only, no hover button. */
  button?: boolean
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const hostEl = useRef<HTMLElement | null>(null)
  const ofRef = useRef(of)
  ofRef.current = of
  const [menu, setMenu] = useState<Menu | null>(null)
  const [inButton, setInButton] = useState(false)

  const run = useCallback(async (copy = false) => {
    setMenu(null)
    const ctx = hostEl.current && ofRef.current(hostEl.current)
    if (!ctx) return
    try {
      if (copy) { await copyChatAbout(ctx); pushSuccess('Copied') }
      else await startChatAbout(ctx)
    } catch (e: any) {
      if (e instanceof AuthError) chatAboutAuthError()
      else pushError(e?.message || 'Could not start that chat')
    }
  }, [])

  useEffect(() => {
    const self = anchor.current
    const el = self?.parentElement && (host ? self.parentElement.closest<HTMLElement>(host) : self.parentElement)
    if (!el) return
    hostEl.current = el
    setInButton(Boolean(self!.closest('button')))
    el.classList.add('chat-about-host')

    // Touch state for one press at a time.
    let timer: ReturnType<typeof setTimeout> | null = null
    let start: { x: number; y: number } | null = null
    let armed = false
    let swallowUntil = 0
    const cancel = () => { if (timer) clearTimeout(timer); timer = null }
    const arm = () => {
      armed = true
      window.getSelection()?.removeAllRanges()
      navigator.vibrate?.(10)
    }

    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented || e.shiftKey) return
      const target = e.target as Element | null
      if (target?.closest(NATIVE) || String(window.getSelection() || '').trim()) return
      e.preventDefault()
      // Android fires this during a long press: the lift opens the menu.
      if (start) { cancel(); arm(); return }
      // The keyboard's menu key reports no position; open at the card instead.
      const r = el.getBoundingClientRect()
      setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY, guardUntil: 0 } : { x: r.left + 12, y: r.top + 12, guardUntil: 0 })
    }

    const onTouchStart = (e: TouchEvent) => {
      // A new touch starts clean, whatever the last one left behind.
      cancel(); armed = false; swallowUntil = 0; start = null
      if ((e as any)[CLAIMED] || e.touches.length !== 1) return
      if ((e.target as Element | null)?.closest(NATIVE)) return
      ;(e as any)[CLAIMED] = true
      const t = e.touches[0]
      start = { x: t.clientX, y: t.clientY }
      timer = setTimeout(() => { timer = null; arm() }, LONG_PRESS_MS)
    }
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > MOVE_SLOP) { cancel(); armed = false; start = null }
    }
    // The menu opens on the lift, and the lift is not a tap on the card.
    const onTouchEnd = (e: TouchEvent) => {
      cancel()
      const at = start
      start = null
      if (!armed || !at) return
      armed = false
      if (e.cancelable) e.preventDefault()
      swallowUntil = Date.now() + LIFT_GUARD_MS
      setMenu({ ...at, guardUntil: swallowUntil })
    }
    const onClick = (e: MouseEvent) => {
      if (!swallowUntil) return
      const swallow = Date.now() < swallowUntil
      swallowUntil = 0
      if (swallow) { e.preventDefault(); e.stopPropagation() }
    }

    el.addEventListener('contextmenu', onContext)
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: false })
    el.addEventListener('touchcancel', onTouchEnd, { passive: false })
    el.addEventListener('click', onClick, true)
    return () => {
      cancel()
      hostEl.current = null
      el.classList.remove('chat-about-host')
      el.removeEventListener('contextmenu', onContext)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('click', onClick, true)
    }
  }, [host])

  const press = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); void run() }

  return (
    <>
      {button ? (
        // A span, not a button: some cards are buttons themselves.
        <span
          ref={anchor}
          role="button"
          tabIndex={inButton ? -1 : 0}
          className="chat-about-btn"
          title="Chat about this"
          aria-label="Chat about this"
          onClick={press}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') press(e) }}
          onPointerDown={(e) => e.stopPropagation()}
          draggable={false}
        >
          <Hi icon={ChatBubbleLeftRightIcon} size={15} />
        </span>
      ) : <span ref={anchor} hidden />}
      {menu && createPortal(<AboutMenu menu={menu} onClose={() => setMenu(null)} onRun={run} />, document.body)}
    </>
  )
}

function AboutMenu({ menu, onClose, onRun }: { menu: Menu; onClose: () => void; onRun: (copy?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  // useDismiss, except that presses left over from the long press's lift don't count.
  useEffect(() => {
    const onDown = (e: Event) => {
      if (Date.now() < menu.guardUntil) return
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, onClose])
  // Keep it on screen near an edge.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    })
  }, [menu])
  useEffect(() => { ref.current?.querySelector('button')?.focus() }, [])
  return (
    <div ref={ref} className="chat-about-menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" role="menuitem" onClick={() => onRun()}>
        <Hi icon={ChatBubbleLeftRightIcon} size={15} /> Chat about this
      </button>
      <button type="button" role="menuitem" onClick={() => onRun(true)}>
        <Hi icon={ClipboardDocumentIcon} size={15} /> Copy as text
      </button>
    </div>
  )
}
