// The morning check-in opens on its own on the first open of the day: at launch
// and each time the app comes back from the background, fetch the habits and ask
// lib/habitCheckin's shouldOpenCheckin. The bridge records that it was shown
// (checkin.lastShown) so another device, or the web, doesn't ask again.
import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { router, useNavigationContainerRef } from 'expo-router'
import { getHabits, markHabitCheckin } from '../lib/api'
import { shouldOpenCheckin } from '../lib/habitCheckin'
import { setHabits } from '../features/habits/store'

/** True when the drawer is on top: no sheet or pushed screen over it. */
function drawerOnTop(state: any): boolean {
  while (state?.routes) {
    if (state.routes.some((r: any) => r.name === '(app)')) return state.routes[state.index ?? state.routes.length - 1]?.name === '(app)'
    state = state.routes[state.index ?? 0]?.state
  }
  return false
}

/** Mounted once in the signed-in app (app/(app)/_layout.tsx). */
export function useMorningCheckin() {
  const nav = useNavigationContainerRef()
  const running = useRef(false)
  // A day already opened here, in case recording it on the bridge failed.
  const openedFor = useRef<string | null>(null)

  useEffect(() => {
    const check = async () => {
      if (running.current) return
      running.current = true
      try {
        const payload = await getHabits()
        setHabits(payload)
        if (!shouldOpenCheckin(payload) || openedFor.current === payload.today) return
        if (!drawerOnTop(nav.getRootState())) return
        openedFor.current = payload.today
        try { setHabits(await markHabitCheckin(payload.today)) } catch { /* still open it */ }
        router.push('/habit/checkin')
      } catch {
        // Offline or signed out: the screens say so; the check-in waits for the next open.
      } finally {
        running.current = false
      }
    }
    void check()
    // Once per activation: only a return from the background counts, not the
    // inactive blip of pulling down Notification Centre.
    let last = AppState.currentState
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && last === 'background') void check()
      last = next
    })
    return () => sub.remove()
  }, [nav])
}
