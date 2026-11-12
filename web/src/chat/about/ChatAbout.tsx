// "Chat about this" on a card or page. Dropped inside the card, it takes the
// card (its parent, or the nearest `host` above it) and adds a right-click menu,
// and a long-press menu on a touch screen; nothing is drawn on the card itself.
// Text selected on the card goes with the chat, and the menu offers to copy it,
// so taking over right-click costs nothing. Shift+right-click keeps the browser's
// own menu, and so does right-clicking a link or a field.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AuthError } from '../../api'
import { Hi, ChatBubbleLeftRightIcon, ClipboardDocumentIcon, DocumentTextIcon } from '../../icons'
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

// A right-click's mousedown and its contextmenu arrive together; older than this,
// the snapshot belongs to some other click.
const PRESS_FRESH_MS = 1500

type Menu = { x: number; y: number; guardUntil: number; selection: string }
type Action = 'chat' | 'copy-card' | 'copy-selection'

/** The selected text, if the selection touches `el`. */
function selectionIn(el: HTMLElement): string {
  const sel = window.getSelection()
  const text = String(sel || '').trim()
  if (!text || !sel?.rangeCount) return ''
  for (let i = 0; i < sel.rangeCount; i++) if (sel.getRangeAt(i).intersectsNode(el)) return text
  return ''
}

export default function ChatAbout({ of, host }: {
  /** The card's context, read when it is used (so never stale), from the card's element. */
  of: (host: HTMLElement) => ChatContext | null | undefined
  /** CSS selector of the card, when the component sits deeper than its direct child. */
  host?: string
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const hostEl = useRef<HTMLElement | null>(null)
  const ofRef = useRef(of)
  ofRef.current = of
  const [menu, setMenu] = useState<Menu | null>(null)

  const run = useCallback(async (action: Action, selection: string) => {
    setMenu(null)
    try {
      if (action === 'copy-selection') { await navigator.clipboard.writeText(selection); pushSuccess('Copied'); return }
      const base = hostEl.current && ofRef.current(hostEl.current)
      if (!base) return
      const ctx = selection ? { ...base, selection } : base
      if (action === 'copy-card') { await copyChatAbout(ctx); pushSuccess('Copied') }
      else await startChatAbout(ctx)
    } catch (e: any) {
      if (e instanceof AuthError) chatAboutAuthError()
      else pushError(e?.message || (action === 'chat' ? 'Could not start that chat' : 'Could not copy that'))
    }
  }, [])

  useEffect(() => {
    const self = anchor.current
    const el = self?.parentElement && (host ? self.parentElement.closest<HTMLElement>(host) : self.parentElement)
    if (!el) return
    hostEl.current = el
    el.classList.add('chat-about-host')

    // What was selected when the right button went down. macOS selects the word
    // under the pointer before it sends contextmenu, and that word is not
    // something the owner chose. The menu key has no press, so it reads the
    // selection as it is.
    let pressed: { at: number; selection: string } | null = null
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2 || (e.button === 0 && e.ctrlKey)) pressed = { at: Date.now(), selection: selectionIn(el) }
    }

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
      if (target?.closest(NATIVE)) return
      e.preventDefault()
      // Android fires this during a long press: the lift opens the menu.
      if (start) { cancel(); arm(); return }
      const fresh = pressed && Date.now() - pressed.at < PRESS_FRESH_MS ? pressed : null
      pressed = null
      const selection = fresh ? fresh.selection : selectionIn(el)
      // The word macOS just selected is dropped again, so the page looks as it did.
      if (fresh && !selection && String(window.getSelection() || '').trim()) window.getSelection()?.removeAllRanges()
      // The keyboard's menu key reports no position; open at the card instead.
      const r = el.getBoundingClientRect()
      const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 12, y: r.top + 12 }
      setMenu({ ...at, guardUntil: 0, selection })
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
      setMenu({ ...at, guardUntil: swallowUntil, selection: '' })
    }
    const onClick = (e: MouseEvent) => {
      if (!swallowUntil) return
      const swallow = Date.now() < swallowUntil
      swallowUntil = 0
      if (swallow) { e.preventDefault(); e.stopPropagation() }
    }

    el.addEventListener('mousedown', onMouseDown, true)
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
      el.removeEventListener('mousedown', onMouseDown, true)
      el.removeEventListener('contextmenu', onContext)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('click', onClick, true)
    }
  }, [host])

  return (
    <>
      <span ref={anchor} hidden />
      {menu && createPortal(<AboutMenu menu={menu} onClose={() => setMenu(null)} onRun={run} />, document.body)}
    </>
  )
}

function AboutMenu({ menu, onClose, onRun }: { menu: Menu; onClose: () => void; onRun: (action: Action, selection: string) => void }) {
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
      <button type="button" role="menuitem" onClick={() => onRun('chat', menu.selection)}>
        <Hi icon={ChatBubbleLeftRightIcon} size={15} /> {menu.selection ? 'Chat about the selection' : 'Chat about this'}
      </button>
      {menu.selection && (
        <button type="button" role="menuitem" onClick={() => onRun('copy-selection', menu.selection)}>
          <Hi icon={ClipboardDocumentIcon} size={15} /> Copy
        </button>
      )}
      <button type="button" role="menuitem" onClick={() => onRun('copy-card', menu.selection)}>
        <Hi icon={DocumentTextIcon} size={15} /> Copy card as text
      </button>
    </div>
  )
}
