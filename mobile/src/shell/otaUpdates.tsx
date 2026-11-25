// Over-the-air updates while the app stays alive (the rules: otaPolicy.ts). Coming back to
// the foreground looks for an update (or a rollback) and fetches it in the background; a
// fetched one is applied on a later return after a long absence, only on a top-level page
// with nothing being typed, and only if nothing else arrives in the moment after (a tapped
// notification, a quick action, a link). Voice mode, dictation and an unsaved journal take
// hold it off (holdReload). Before reloading it notes the page and chat on screen, and the
// fresh launch goes back there (resumedFromUpdate) instead of the landing page, and does not
// replay the home-screen action the app was first launched from (quickActions.ts).
// A development build, or one without expo-updates, does nothing here.
import { useEffect, useRef } from 'react'
import { AppState, TextInput } from 'react-native'
import { usePathname } from 'expo-router'
import * as Updates from 'expo-updates'
import { getState as chatState } from '../lib/chat/store'
import { tappedNotificationRecently } from './push'
import { SETTLE_MS, shouldApply, shouldCheck, stillSettled } from './otaPolicy'

const holds = new Set<symbol>()

/** Keep the app from reloading into an update until the returned release is called. */
export function holdReload(): () => void {
  const key = Symbol('hold')
  holds.add(key)
  return () => { holds.delete(key) }
}

const beforeReload = new Set<() => boolean>()
/**
 * Run just before reloading into an update, to save what is still waiting on a timer (the
 * chat drafts). Returning false (it could not be saved) calls the reload off.
 */
export function onBeforeReload(fn: () => boolean): () => void {
  beforeReload.add(fn)
  return () => { beforeReload.delete(fn) }
}

let arrivedAt = 0
/** Something opened a screen of its own as the app came back (a quick action): no reload now. */
export function noteArrival() { arrivedAt = Date.now() }

// Where to pick up after a reload into an update, kept for one launch.
const RESUME_KEY = 'totem.ota.resume'
type Resume = { at: number; path: string; chatId: string | null }

function takeResume(): Resume | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY)
    if (!raw) return null
    localStorage.removeItem(RESUME_KEY)
    const r = JSON.parse(raw) as Resume
    return Date.now() - r.at < 120_000 ? r : null
  } catch { return null }
}

let resume: Resume | null | undefined
/** Where the reload before this launch left him; null on any other launch. Read after mount. */
export function resumedFromUpdate(): Resume | null {
  if (resume === undefined) resume = takeResume()
  return resume
}

let resumeTaken = false
/** The layout takes the resume once; a later remount (signing in again) lands as usual. */
export function takeResumedFromUpdate(): Resume | null {
  if (resumeTaken) return null
  resumeTaken = true
  return resumedFromUpdate()
}

/** Mounted once in the signed-in app; draws nothing, so its re-renders stay here. */
export function OtaUpdates() {
  const { isUpdatePending, isChecking, isDownloading } = Updates.useUpdates()
  const path = usePathname()
  const state = useRef({ pending: false, busy: false, path: '/', leftAt: 0, lastCheckAt: Date.now() })
  state.current.pending = isUpdatePending
  state.current.busy = isChecking || isDownloading
  state.current.path = path

  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return
    let settle: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      const s = state.current
      if (!shouldCheck({ lastCheckAt: s.lastCheckAt, now: Date.now(), busy: s.busy || s.pending })) return
      s.lastCheckAt = Date.now()
      try {
        const found = await Updates.checkForUpdateAsync()
        if (found.isAvailable || found.isRollBackToEmbedded) await Updates.fetchUpdateAsync()
      } catch { /* offline or the server is away: the next return tries again */ }
    }
    const apply = (pathBefore: string, chatBefore: string | null) => {
      const s = state.current
      const chatNow = chatState().activeId
      if (AppState.currentState !== 'active' || holds.size) return
      if (s.path !== '/chat' && TextInput.State.currentlyFocusedInput() != null) return
      const arrived = tappedNotificationRecently(SETTLE_MS + 1000) || Date.now() - arrivedAt < SETTLE_MS + 1000
      if (!stillSettled({ pathBefore, pathNow: s.path, chatBefore, chatNow, arrived })) return
      // Save what is waiting first; nothing saved, no reload (and no resume marker left behind).
      let saved = true
      beforeReload.forEach((fn) => { try { if (!fn()) saved = false } catch { saved = false } })
      if (!saved) return
      try {
        const resume: Resume = { at: Date.now(), path: s.path, chatId: s.path === '/chat' ? chatNow : null }
        localStorage.setItem(RESUME_KEY, JSON.stringify(resume))
      } catch { /* it lands on the landing page instead */ }
      Updates.reloadAsync().catch(() => {
        // Stays on this bundle until the next cold start, which must not think it was a reload.
        try { localStorage.removeItem(RESUME_KEY) } catch { /* expires on its own */ }
      })
    }
    const sub = AppState.addEventListener('change', (next) => {
      const s = state.current
      if (next === 'background') { s.leftAt = Date.now(); clearTimeout(settle); return }
      if (next !== 'active') return
      const awayMs = s.leftAt ? Date.now() - s.leftAt : 0
      s.leftAt = 0
      const typing = TextInput.State.currentlyFocusedInput() != null
      const newChat = chatState().activeId == null
      if (shouldApply({ pending: s.pending, awayMs, held: holds.size > 0, path: s.path, typing, newChat })) {
        const pathBefore = s.path
        const chatBefore = chatState().activeId
        settle = setTimeout(() => apply(pathBefore, chatBefore), SETTLE_MS)
        return
      }
      void check()
    })
    return () => { sub.remove(); clearTimeout(settle) }
  }, [])
  return null
}
