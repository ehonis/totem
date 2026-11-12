import { useEffect, useRef, useState } from 'react'
import type { VisualPart } from './types'
import { TI } from './ui'
import { IconArrowsMaximize } from './icons'
import { readVisualMessage, visualOpensOutside, VISUAL_SANDBOX } from './visuals'

// A chart the agent rendered (chat/visuals.mjs), drawn where it sits in the
// reply, the way T3 Code's html_render frame is. The page is loaded from its
// signed upload URL into a sandboxed frame on the chat's own background and
// fitted to its height, which the page reports as it changes; until then the
// height the agent measured with html_preview holds its place.
//
// A frame can always navigate itself, and CSP cannot stop it, so a page that
// leaves (a second load) is closed rather than left showing whatever it went to.
// A frame also reloads when its node is moved in the DOM, so this relies on the
// reply's blocks keeping their order (blocks() and foldWork in Message.tsx do).
export default function VisualFrame({ part }: { part: VisualPart }) {
  const frame = useRef<HTMLIFrameElement>(null)
  // The first URL stays: a re-signed copy of the message must not reload the page.
  const [src] = useState(() => part.url || `/api/chat/uploads/${part.uploadId}`)
  const [height, setHeight] = useState(part.height)
  const loads = useRef(0)
  const [left, setLeft] = useState(false)

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const msg = readVisualMessage(e.data)
      if (msg?.kind === 'size') setHeight(msg.height)
      // A link in the page: the sandbox cannot navigate the dashboard, so it asks. Other sites only.
      else if (msg?.kind === 'open' && visualOpensOutside(msg.url, window.location.origin)) window.open(msg.url, '_blank', 'noopener,noreferrer')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  if (left) return <div className="vc-note vc-visual-left">“{part.title}” reloaded or tried to open another page, so it was closed.</div>

  return (
    <figure className="vc-visual">
      <iframe
        ref={frame}
        className="vc-visual-frame"
        src={src}
        sandbox={VISUAL_SANDBOX}
        referrerPolicy="no-referrer"
        loading="lazy"
        title={part.title}
        style={{ height }}
        onLoad={() => { if (++loads.current > 1) setLeft(true) }}
      />
      {/* Opened on its own the page keeps its sandbox (the bridge serves it under one). */}
      <a className="vc-visual-open" href={src} target="_blank" rel="noopener noreferrer" title={`Open “${part.title}” on its own`} aria-label={`Open ${part.title} on its own`}>
        <TI icon={IconArrowsMaximize} size={14} />
      </a>
    </figure>
  )
}
