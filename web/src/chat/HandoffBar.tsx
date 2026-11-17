import React from 'react'
import { useChat, answerHandoff, showBrowser } from './store'
import { TI } from './ui'
import { IconHandClick } from './icons'

// The chat's own word that its agent handed the browser over (preview_handoff)
// and is waiting on him: a row over the composer for as long as it waits, so a
// chat that looks like it is still running says why. While the browser panel
// shows, its own banner has Done and Skip, so this row steps aside.
export default function HandoffBar({ threadId }: { threadId: string | null }) {
  const handoff = useChat((s) => (threadId ? s.handoffs[threadId] || null : null))
  const frame = useChat((s) => !!(threadId && s.browser[threadId]))
  const panelOpen = useChat((s) => s.browserOpen)
  if (!threadId || !handoff || (panelOpen && frame)) return null
  return (
    <div className="vc-needs" role="status">
      <TI icon={IconHandClick} size={17} />
      <span className="vc-needs-text"><b><span className="vc-needs-long">Your turn in the browser</span><span className="vc-needs-short">Your turn</span></b> <span>{handoff.reason}</span></span>
      {frame && <button type="button" className="vc-btn sm ghost" onClick={() => showBrowser(true)} aria-label="Open the browser" title="Open the browser">Open</button>}
      <button type="button" className="vc-btn sm ghost" onClick={() => answerHandoff(threadId, 'skip')}>Skip</button>
      <button type="button" className="vc-needs-done" onClick={() => answerHandoff(threadId, 'done')}>Done</button>
    </div>
  )
}
