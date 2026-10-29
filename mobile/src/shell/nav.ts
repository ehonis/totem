// Where each dashboard tab lives in the app, and the few navigations every
// screen needs (open a chat, start a new one, open the drawer).
import { router } from 'expo-router'
import { DrawerActions } from 'expo-router/react-navigation'
import { setActive, requestVoice } from '../lib/chat/store'

/** The web's tab ids (router.ts TAB_IDS) to app routes. Productivity apps are a param. */
export const TAB_ROUTES = {
  overview: '/',
  search: '/search',
  totems: '/totems',
  chat: '/chat',
  productivity: '/productivity',
  inbox: '/inbox',
  fleet: '/fleet',
  settings: '/settings',
} as const

export type TabId = keyof typeof TAB_ROUTES

export const PRODUCTIVITY_APPS = ['todos', 'habits', 'goals', 'lists', 'journal', 'calendar'] as const
export type ProductivityApp = (typeof PRODUCTIVITY_APPS)[number]

/**
 * The web's navigate(): a tab id, a productivity app id ("todos"), or a
 * partial route. Lets ported code that calls onNavigate('calendar') work as-is.
 */
export function navigateTo(target: string | { tab?: string; app?: string | null; sub?: string | null; hash?: string | null }) {
  const t = typeof target === 'string' ? { tab: target } : target
  const tab = t.tab || 'overview'
  if ((PRODUCTIVITY_APPS as readonly string[]).includes(tab)) {
    router.navigate({ pathname: '/productivity', params: { app: tab } })
    return
  }
  if (tab === 'productivity') {
    router.navigate({ pathname: '/productivity', params: t.app ? { app: t.app } : {} })
    return
  }
  if (tab === 'settings') {
    // Providers › Usage (the quota meters) is a native sheet; the rest of that pane is web-only.
    if (t.sub === 'providers' && t.hash === 'usage') {
      router.push('/chat/usage')
      return
    }
    router.navigate({ pathname: '/settings', params: t.sub ? { sub: t.sub } : {} })
    return
  }
  const path = TAB_ROUTES[tab as TabId] || '/'
  router.navigate(path as any)
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
