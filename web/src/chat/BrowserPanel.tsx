import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useChat, showBrowser, closeBrowser, browserInput, answerHandoff } from './store'
import { usePanelEscape } from './escape'
import { TI } from './ui'
import { IconWorld, IconX, IconExternalLink, IconPlayerStopFilled, IconHandClick } from './icons'
import { useBrowserStream, type BrowserStream } from './browserStream'
import { buttonName, clickCounter, keyAction, modifiersOf, newPanelOwner, toPagePoint, wheelPixels, type Modifier, type RawInput } from './browserInput'

// What the chat's agent is looking at, the way T3 Code shows its collaborative
// browser beside the thread: the page it has open, its address, and whether it
// is still driving. While the panel is open the page streams live
// (useBrowserStream: the bridge's screencast over a socket), so a spinner or a
// bot check moves without anyone touching it; before the first frame, or where
// the socket cannot connect, the last still from the agent's actions stays up.
// The owner can drive it too: the mouse (moves, drags, right clicks, double
// clicks), the wheel, keys with their modifiers, IME and paste, which is how
// he signs in to something the agent must not type a password into. While the
// agent is driving, the page is look-only so the two don't fight over it,
// unless it has handed the browser over (preview_handoff): then a banner says
// what it needs, and Done or Skip gives it back.

export function host(url: string) {
  try { return new URL(url).host.replace(/^www\./, '') } catch { return url }
}

export function useChatBrowser(threadId: string | null) {
  return useChat((s) => (threadId ? s.browser[threadId] || null : null))
}

/**
 * Forward the owner's input to the chat's browser. Pointer positions map from
 * the shown picture to the page's CSS pixels (toPagePoint); a touch tap is a
 * click and a touch drag scrolls. Keys go through a hidden textarea so a phone
 * raises its keyboard: real keys go down and up as keys, composed and pasted
 * text arrives whole. On the live socket every event goes as it happens; with
 * no socket they go by POST, without bare moves, and a late look catches what
 * the page did afterwards.
 */
function useDriveBrowser(threadId: string, enabled: boolean, stream: BrowserStream, owner: string) {
  const screen = useRef<HTMLDivElement | null>(null)
  // The element itself, as state: hiding the panel unmounts it, and the wheel
  // listener has to follow the new one when it comes back.
  const [screenEl, setScreenEl] = useState<HTMLDivElement | null>(null)
  const screenRef = useCallback((el: HTMLDivElement | null) => { screen.current = el; setScreenEl(el) }, [])
  const keys = useRef<HTMLTextAreaElement>(null)
  const clicks = useRef(clickCounter())
  const lastCount = useRef(1)
  const held = useRef(new Map<string, string>()) // KeyboardEvent.code → the key sent down
  const touch = useRef<{ id: number; x: number; y: number; lastX: number; lastY: number; scrolling: boolean; at: { x: number; y: number } } | null>(null)
  const move = useRef<{ event: RawInput | null; raf: number }>({ event: null, raf: 0 })
  const wheel = useRef({ dx: 0, dy: 0, x: 0, y: 0, mods: [] as Modifier[], raf: 0 })
  const lookTimer = useRef<number>()
  const [typing, setTyping] = useState(false)
  const live = useRef(stream)
  live.current = stream

  const send = (event: RawInput) => {
    const s = live.current
    if (s.send(event)) return
    // On the socket but not allowed to drive: the caption says why.
    if (s.status === 'open') return
    if (event.kind === 'mouse' && event.type === 'move' && !event.buttons) return
    void browserInput(threadId, event, owner)
    window.clearTimeout(lookTimer.current)
    lookTimer.current = window.setTimeout(() => void browserInput(threadId, { kind: 'look' }, owner), 1200)
  }

  const shown = () => screen.current?.querySelector<HTMLElement>(live.current.drawn ? 'canvas' : 'img') || null
  const at = (e: { clientX: number; clientY: number }, clamp = false) => {
    const el = shown()
    if (!el) return null
    const s = live.current
    const page = s.drawn && s.header ? { width: s.header.width, height: s.header.height } : { width: (el as HTMLImageElement).naturalWidth || 0, height: (el as HTMLImageElement).naturalHeight || 0 }
    return toPagePoint(e.clientX, e.clientY, el.getBoundingClientRect(), page, { clamp })
  }
  // CSS pixels of the page per pixel of the panel, for a touch drag's scroll.
  const pageScale = () => {
    const el = shown()
    const s = live.current
    const width = s.drawn && s.header ? s.header.width : (el as HTMLImageElement | null)?.naturalWidth || 0
    const rect = el?.getBoundingClientRect()
    return rect?.width && width ? width / rect.width : 1
  }

  const flushMove = () => {
    const m = move.current
    m.raf = 0
    if (m.event) { send(m.event); m.event = null }
  }
  const queueWheel = (p: { x: number; y: number }, dx: number, dy: number, mods: Modifier[]) => {
    const w = wheel.current
    w.dx += dx; w.dy += dy; w.x = p.x; w.y = p.y; w.mods = mods
    if (w.raf) return
    w.raf = window.requestAnimationFrame(() => {
      const { dx: deltaX, dy: deltaY, x, y, mods: modifiers } = w
      w.dx = 0; w.dy = 0; w.raf = 0
      if (Math.round(deltaX) || Math.round(deltaY)) send({ kind: 'wheel', x, y, deltaX: Math.round(deltaX), deltaY: Math.round(deltaY), modifiers })
    })
  }

  useEffect(() => () => {
    window.clearTimeout(lookTimer.current)
    window.cancelAnimationFrame(move.current.raf)
    window.cancelAnimationFrame(wheel.current.raf)
  }, [])

  // A native listener, since React's wheel handler is passive and the panel would scroll too.
  useEffect(() => {
    const el = screenEl
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!enabled) return
      const p = at(e)
      if (!p) return
      e.preventDefault()
      const { deltaX, deltaY } = wheelPixels(e, { height: live.current.header?.height || 800 })
      queueWheel(p, deltaX, deltaY, modifiersOf(e))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [screenEl, threadId, enabled])

  // Losing focus lets go of all this panel holds; on the socket the bridge knows
  // what that is (a modifier it pressed for a key included), by POST only the keys.
  const releaseKeys = () => {
    if (!live.current.release()) for (const key of held.current.values()) send({ kind: 'key', type: 'up', key, modifiers: [] })
    held.current.clear()
  }

  const pointer = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled) return
      const p = at(e)
      if (!p) return
      e.preventDefault()
      keys.current?.focus({ preventScroll: true })
      e.currentTarget.setPointerCapture?.(e.pointerId)
      if (e.pointerType === 'touch') {
        touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, scrolling: false, at: p }
        return
      }
      flushMove()
      lastCount.current = clicks.current(e.timeStamp, e.clientX, e.clientY, e.button)
      send({ kind: 'mouse', type: 'down', ...p, button: buttonName(e.button), buttons: e.buttons, clickCount: lastCount.current, modifiers: modifiersOf(e) })
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled) return
      const t = touch.current
      if (t && e.pointerId === t.id) {
        if (!t.scrolling && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) t.scrolling = true
        if (t.scrolling) {
          const k = pageScale()
          queueWheel(t.at, -(e.clientX - t.lastX) * k, -(e.clientY - t.lastY) * k, [])
          t.lastX = e.clientX; t.lastY = e.clientY
        }
        return
      }
      if (e.pointerType === 'touch') return
      const p = at(e, e.buttons !== 0)
      if (!p) return
      move.current.event = { kind: 'mouse', type: 'move', ...p, button: 'none', buttons: e.buttons, clickCount: 0, modifiers: modifiersOf(e) }
      if (!move.current.raf) move.current.raf = window.requestAnimationFrame(flushMove)
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      const t = touch.current
      if (t && e.pointerId === t.id) {
        touch.current = null
        if (!t.scrolling && enabled) {
          const count = clicks.current(e.timeStamp, t.x, t.y, 0)
          send({ kind: 'mouse', type: 'down', ...t.at, button: 'left', buttons: 1, clickCount: count, modifiers: [] })
          send({ kind: 'mouse', type: 'up', ...t.at, button: 'left', buttons: 0, clickCount: count, modifiers: [] })
        }
        return
      }
      if (e.pointerType === 'touch' || !enabled) return
      const p = at(e, true)
      if (!p) return
      flushMove()
      send({ kind: 'mouse', type: 'up', ...p, button: buttonName(e.button), buttons: e.buttons, clickCount: lastCount.current, modifiers: modifiersOf(e) })
    },
    onPointerCancel: () => { touch.current = null },
    // The page gets the right click; the dashboard's own menu would cover it.
    onContextMenu: (e: React.MouseEvent) => { if (enabled) e.preventDefault() },
  }

  const sendText = (text: string) => {
    for (let i = 0; i < text.length; i += 4000) send({ kind: 'text', text: text.slice(i, i + 4000) })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = keyAction({ key: e.key, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey })
    if (action !== 'key') return
    e.preventDefault()
    e.stopPropagation()
    flushMove()
    held.current.set(e.code || e.key, e.key)
    send({ kind: 'key', type: 'down', key: e.key, modifiers: modifiersOf(e) })
  }
  const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const key = held.current.get(e.code || e.key)
    if (key === undefined) return
    e.preventDefault()
    e.stopPropagation()
    held.current.delete(e.code || e.key)
    send({ kind: 'key', type: 'up', key, modifiers: modifiersOf(e) })
  }
  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as InputEvent).isComposing) return
    const el = e.currentTarget
    if (el.value) sendText(el.value)
    el.value = ''
  }

  const textarea = (
    <textarea
      ref={keys}
      className="vc-browser-keys"
      aria-label="Type into the page"
      autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onInput={onInput}
      onPaste={(e) => { const text = e.clipboardData.getData('text/plain'); e.preventDefault(); if (text) sendText(text) }}
      onCompositionEnd={(e) => { if (e.currentTarget.value) sendText(e.currentTarget.value); e.currentTarget.value = '' }}
      onFocus={() => setTyping(true)}
      onBlur={() => { releaseKeys(); setTyping(false) }}
    />
  )
  return { screenRef, pointer, textarea, typing }
}

export default function BrowserPanel({ threadId }: { threadId: string | null }) {
  const frame = useChatBrowser(threadId)
  const open = useChat((s) => s.browserOpen)
  const handoff = useChat((s) => (threadId ? s.handoffs[threadId] || null : null))
  const yours = !!frame && (!frame.live || !!handoff)
  // One owner for this panel's presses on both its socket and its POSTs.
  const [owner] = useState(newPanelOwner)
  const stream = useBrowserStream(threadId, open && !!frame, frame?.at ?? null, owner)
  const drive = useDriveBrowser(threadId || '', yours && (stream.status !== 'open' || stream.drive), stream, owner)

  usePanelEscape(open, () => showBrowser(false))

  if (!open || !frame || !threadId) return null
  // The stream's page when it has drawn one: the owner's own clicks move it with no run going.
  const url = (stream.drawn && stream.header?.url) || frame.url
  const title = (stream.drawn && stream.header?.title) || frame.title
  const web = /^https?:/i.test(url)
  const watchOnly = stream.status === 'open' && !stream.drive
  const caption = !yours ? 'The agent is driving'
    : watchOnly ? (stream.reason || 'Watching only on this device')
      : drive.typing ? 'Your keys go to the page' : 'Click to use this page yourself'
  return (
    <aside className="vc vc-artifact vc-browser" aria-label="Browser">
      <header className="vc-art-head">
        <div className="vc-browser-bar" title={url}>
          <TI icon={IconWorld} size={16} />
          <span className="vc-browser-host">{web ? host(url) : url || 'about:blank'}</span>
          {web && <span className="vc-browser-path">{url.replace(/^https?:\/\/[^/]+/, '')}</span>}
          {frame.live && <span className="vc-browser-live"><i />Live</span>}
        </div>
        <div className="vc-art-actions">
          {web && (
            <a className="vc-icon-btn" href={url} target="_blank" rel="noreferrer noopener" aria-label="Open this page in a new tab" title="Open in a new tab">
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
        <figure className={`vc-browser-frame ${frame.live ? 'live' : ''} ${drive.typing ? 'typing' : ''} ${yours && !watchOnly ? 'yours' : ''} ${stream.drawn ? 'streaming' : ''}`}>
          <div ref={drive.screenRef} className="vc-browser-screen" {...drive.pointer}>
            <img src={frame.image} alt={title ? `Screenshot of ${title}` : 'What the browser is showing'} draggable={false} hidden={stream.drawn} />
            <canvas ref={stream.canvas} aria-label={title ? `Live view of ${title}` : 'Live view of the browser'} hidden={!stream.drawn} />
          </div>
          {yours && !watchOnly && drive.textarea}
          <figcaption>
            {caption}
            {title && <> · {title}</>}
          </figcaption>
        </figure>
      </div>
    </aside>
  )
}
