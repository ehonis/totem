// The few navigations every screen needs: go to a dashboard tab or Productivity
// tool, open a chat, start a new one, open the drawer. Where each lands is
// decided in routes.ts.
import { router } from 'expo-router'
import { DrawerActions } from 'expo-router/react-navigation'
import { setActive, requestVoice } from '../lib/chat/store'
import { resolveNav, type NavTarget } from './routes'

// What nav.ts exported before routes.ts existed, so code written against it keeps working.
// New code imports route data from routes.ts.
export { TAB_ROUTES, PRODUCTIVITY_APPS, type TabId, type ProductivityApp } from './routes'

/**
 * The web's navigate(): a tab id, a Productivity tool id ("todos"), or a
 * partial route. Lets ported code that calls onNavigate('calendar') work as-is.
 */
export function navigateTo(target: NavTarget) {
  const to = resolveNav(target)
  router.navigate(to.params ? ({ pathname: to.pathname, params: to.params } as any) : (to.pathname as any))
}

/** Open a chat (or a new one with null). The chat screen reads the store's activeId. */
export function openChat(threadId: string | null = null) {
  setActive(threadId)
  router.navigate('/chat')
}

export function newChat() {
  openChat(null)
}

/** One-tap voice: a fresh chat that opens straight into voice mode. */
export function startVoice() {
  requestVoice()
  router.navigate('/chat')
}

/** Open the drawer from any screen inside it (the action bubbles up to the drawer). */
export function openDrawer(navigation: { dispatch: (a: any) => void }) {
  navigation.dispatch(DrawerActions.openDrawer())
}
