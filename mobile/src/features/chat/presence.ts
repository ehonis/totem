// Tells the bridge which chat this phone is actually looking at (web
// chat/presence.ts), so a finished reply pushes only when nobody is. "Looking"
// means the app is in the foreground, the chat screen focused and that thread
// open. Re-sent every 20 s while true; the bridge forgets a silent device after
// 45 s (a locked phone).
import { useEffect } from 'react'
import { AppState } from 'react-native'
import { authHeaders } from '../../lib/api'
import { bridgeFetch } from '../../lib/connection'

const KEY = 'totem.device'
function deviceId() {
  let id = localStorage.getItem(KEY)
  if (!id) { id = `${Date.now()}${Math.random()}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 32); localStorage.setItem(KEY, id) }
  return id
}

let last = ''
function report(threadId: string | null, viewing: boolean, force = false) {
  const sig = `${threadId}|${viewing}`
  if (!force && sig === last) return
  last = sig
  bridgeFetch('/api/chat/presence', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ deviceId: `${deviceId()}-app`, threadId, viewing }),
  }).catch(() => {})
}

export function useChatPresence(threadId: string | null, onScreen: boolean) {
  useEffect(() => {
    const compute = () => onScreen && !!threadId && AppState.currentState === 'active'
    report(threadId, compute())
    const beat = setInterval(() => { if (compute()) report(threadId, true, true) }, 20_000)
    const sub = AppState.addEventListener('change', () => report(threadId, compute()))
    return () => { clearInterval(beat); sub.remove(); report(threadId, false) }
  }, [threadId, onScreen])
}
