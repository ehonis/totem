import React, { useEffect } from 'react'
import { useChat, showBrowser, closeBrowser } from './store'
import { TI } from './ui'
import { IconWorld, IconX, IconExternalLink, IconPlayerStopFilled } from './icons'

// What the chat's agent is looking at, the way T3 Code shows its collaborative
// browser beside the thread: the page it has open, its address, and whether it
// is still driving. Frames arrive with every page change (bridge `browser`
// events); between them the last one stays up. Read-only — the agent drives.

function host(url: string) {
  try { return new URL(url).host.replace(/^www\./, '') } catch { return url }
}

export function useChatBrowser(threadId: string | null) {
  return useChat((s) => (threadId ? s.browser[threadId] || null : null))
}

export default function BrowserPanel({ threadId }: { threadId: string | null }) {
  const frame = useChatBrowser(threadId)
  const open = useChat((s) => s.browserOpen)

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
        <figure className={`vc-browser-frame ${frame.live ? 'live' : ''}`}>
          <img src={frame.image} alt={frame.title ? `Screenshot of ${frame.title}` : 'What the browser is showing'} />
          {frame.title && <figcaption>{frame.title}</figcaption>}
        </figure>
      </div>
    </aside>
  )
}

/** The chip that brings the browser back: in the header, or above the composer on a phone. */
export function BrowserChip({ threadId, className = '' }: { threadId: string | null; className?: string }) {
  const frame = useChatBrowser(threadId)
  const open = useChat((s) => s.browserOpen)
  if (!frame || open) return null
  return (
    <button type="button" className={`vc-browser-chip ${frame.live ? 'live' : ''} ${className}`} onClick={() => showBrowser(true)} title={frame.url}>
      <img src={frame.image} alt="" />
      <span>{frame.live ? 'Browsing' : 'Browser'} · {host(frame.url) || 'blank'}</span>
    </button>
  )
}
