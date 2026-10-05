// Tells the bridge which chat this device is actually looking at, so a finished
// reply pushes to the phone only when nobody is (chat/runs ▸ someoneViewing in
// bridge.mjs). "Looking" means the page is visible, the window focused, the Chat
// tab showing and that thread open. Reported on every change, re-sent every 20 s
// while true (the bridge forgets a silent device after 45 s — a locked phone), and
// sent with keepalive as the page hides so it survives the app going away.
import { useEffect } from 'react'
import { authHeaders } from '../api'

const KEY = 'totem.device'
function deviceId() {
  let id = localStorage.getItem(KEY)
  if (!id) { id = (crypto.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 32); localStorage.setItem(KEY, id) }
  return id
}

// One report stream per surface (the chat view, the quick panel), so one going
// off screen never clears the other's presence.
const last: Record<string, string> = {}
function report(source: string, threadId: string | null, viewing: boolean, force = false) {
  const sig = `${threadId}|${viewing}`
  if (!force && sig === last[source]) return
  last[source] = sig
  fetch('/api/chat/presence', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ deviceId: `${deviceId()}-${source}`, threadId, viewing }),
    keepalive: true,
  }).catch(() => {})
}

/** Keep the bridge told whether `threadId` is in front of this person. */
export function useChatPresence(threadId: string | null, onScreen: boolean, source = 'main') {
  useEffect(() => {
    const compute = () => onScreen && !!threadId && document.visibilityState === 'visible' && document.hasFocus()
    const update = () => report(source, threadId, compute())
    update()
    const beat = setInterval(() => { if (compute()) report(source, threadId, true, true) }, 20_000)
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    const onHide = () => report(source, threadId, false)
    window.addEventListener('pagehide', onHide)
    return () => {
      clearInterval(beat)
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      window.removeEventListener('pagehide', onHide)
      report(source, threadId, false)
    }
  }, [threadId, onScreen, source])
}
