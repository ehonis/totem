// Where each dashboard tab and Productivity tool lives in the app, decided
// without touching the router so it can be tested on its own (routes.test.mjs).
// nav.ts turns the answer into a navigation.
import { settingsLanding } from '../features/settings/paneRoutes.ts'

/** The web's tab ids (router.ts TAB_IDS) to app routes. */
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

/** web/src/router.ts PRODUCTIVITY_APPS, in its order. Each is its own page at /productivity/<id>. */
export const PRODUCTIVITY_APPS = ['todos', 'calendar', 'habits', 'goals', 'lists', 'recs', 'journal'] as const
export type ProductivityApp = (typeof PRODUCTIVITY_APPS)[number]

/** Each tool's page title. The ids stay the web's ("todos"); the label is what the owner reads. */
export const TOOL_LABELS: Record<ProductivityApp, string> = {
  todos: 'Tasks',
  calendar: 'Calendar',
  habits: 'Habits',
  goals: 'Goals',
  lists: 'Lists',
  recs: 'Recs',
  journal: 'Journal',
}

export const isProductivityApp = (id: unknown): id is ProductivityApp =>
  typeof id === 'string' && (PRODUCTIVITY_APPS as readonly string[]).includes(id)

/** A tool's page, or the Productivity hub for no tool (or one the app doesn't have). */
export const productivityPath = (app?: string | null): string =>
  isProductivityApp(app) ? `/productivity/${app}` : '/productivity'

export type NavTarget = string | { tab?: string; app?: string | null; sub?: string | null; hash?: string | null }

/** A drawer page, navigated to (an existing one is focused, not stacked). */
export type NavRoute = { pathname: string; params?: Record<string, string> }

/**
 * The web's navigate() target, as an app route: a tab id, a Productivity tool id
 * ("todos"), or a partial route. Ported code that calls onNavigate('calendar'),
 * the landing-tab preference and notification links all come through here.
 */
export function resolveNav(target: NavTarget): NavRoute {
  const t = typeof target === 'string' ? { tab: target } : target || {}
  const tab = t.tab || 'overview'
  if (isProductivityApp(tab)) return { pathname: productivityPath(tab) }
  if (tab === 'productivity') return { pathname: productivityPath(t.app) }
  // The action log was its own tab; it is Settings › Activity now.
  if (tab === 'logs') return resolveNav({ tab: 'settings', sub: 'logs', hash: t.hash })
  if (tab === 'settings') {
    // Retired panes land where their settings went (Jobs on the Totems page).
    const land = settingsLanding(t.sub, t.hash)
    if ('tab' in land) return resolveNav(land.tab)
    if ('pane' in land) return { pathname: '/settings', params: land.row ? { sub: land.pane, row: land.row } : { sub: land.pane } }
    return { pathname: '/settings', params: {} }
  }
  const path = Object.prototype.hasOwnProperty.call(TAB_ROUTES, tab) ? TAB_ROUTES[tab as TabId] : '/'
  return { pathname: path }
}

/** Which Productivity page a pathname is: a tool, the hub, or neither. */
export function productivityPage(pathname: string): ProductivityApp | 'hub' | null {
  const [first, second, extra] = String(pathname || '').split(/[?#]/)[0].split('/').filter(Boolean)
  if (first !== 'productivity' || extra) return null
  if (!second) return 'hub'
  return isProductivityApp(second) ? second : null
}
