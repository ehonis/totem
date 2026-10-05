/**
 * Path-based routing for the dashboard.
 *
 * Every tab is a real URL — `/productivity/calendar`, `/settings/providers` —
 * rather than the `/?tab=…&app=…&stab=…` query soup this used to be. The bridge
 * already serves index.html for any unknown path (bridge.mjs ▸ serveStatic), so
 * a deep link and a refresh both land where you'd expect.
 *
 * Query params are kept only for things that aren't hierarchy: `?thread=<id>`
 * on /chat. Old `?tab=` links (iOS Shortcut replies, saved bookmarks, anything
 * the assistant wrote before this change) still resolve — `parseLocation` reads
 * them, and App rewrites the URL to the new shape on boot.
 */

export interface Route {
  tab: string
  /** Sub-app inside Productivity (todos | calendar | habits | goals | lists | journal). */
  app: string | null
  /** Sub-tab inside Settings / Studio. */
  sub: string | null
  /** Section to scroll to once the view is up (no leading '#'). */
  hash: string | null
}

/** A navigation target: a bare tab id, or any part of a route. */
export type NavTarget = string | Partial<Route>

export const TAB_IDS = [
  'overview', 'chat', 'productivity', 'code', 'inbox', 'logs', 'brain', 'studio', 'settings',
]

// Todos/Calendar/Habits are apps *inside* Productivity, but their ids still turn
// up on their own in old links, the `landingTab` pref, and Overview's View buttons.
export const PRODUCTIVITY_APPS = ['todos', 'calendar', 'habits', 'goals', 'lists', 'journal']
export const DEFAULT_PRODUCTIVITY_APP = 'calendar'

const SUB_TABS: Record<string, string[]> = {
  // Keep in step with SUB_TABS in components/SettingsView.tsx.
  settings: ['general', 'chat', 'ai', 'integrations', 'tasks', 'providers', 'shortcuts', 'notifications', 'voice', 'skills', 'jobs', 'connections', 'logs'],
  studio: ['skills', 'workflows', 'connections'],
}

export const productivityApp = (id?: string | null) =>
  id && PRODUCTIVITY_APPS.includes(id) ? id : null

const validSub = (tab: string, sub?: string | null) =>
  sub && SUB_TABS[tab]?.includes(sub) ? sub : null

/** Fold a bare id (which may be a productivity app) into a full route. */
export function toRoute(target: NavTarget): Route {
  const partial = typeof target === 'string' ? { tab: target } : { ...target }
  const app = productivityApp(partial.tab) || productivityApp(partial.app)
  const tab = productivityApp(partial.tab) ? 'productivity' : (partial.tab || 'overview')
  return {
    tab: TAB_IDS.includes(tab) ? tab : 'overview',
    app: tab === 'productivity' ? app : null,
    sub: validSub(tab, partial.sub),
    hash: partial.hash || null,
  }
}

// Tabs that always have a pane showing, so the URL should name it rather than
// leaving `/settings` pointing at whatever the view happens to default to.
const DEFAULT_SUB: Record<string, string> = { settings: 'general', studio: 'skills' }

/** Fill in the app / sub-tab a bare tab URL implies. */
export function withDefaults(route: Route, landing?: string | null): Route {
  if (route.tab === 'productivity' && !route.app) {
    return { ...route, app: productivityApp(landing) || DEFAULT_PRODUCTIVITY_APP }
  }
  if (!route.sub && DEFAULT_SUB[route.tab]) {
    return { ...route, sub: DEFAULT_SUB[route.tab] }
  }
  return route
}

/**
 * Where a navigation target lands, given where you are now.
 *
 * Fields the target names win. A target that names no tab is a move *within*
 * the current one (a sub-tab switch). Anything left over comes from `memory` —
 * the app/sub-tab you last had open on the destination tab — so returning to
 * Productivity or Settings doesn't reset the pane you were using.
 */
export function resolveTarget(
  current: Route,
  target: NavTarget,
  memory: Partial<Route> = {},
  landing?: string | null,
): Route {
  const partial = typeof target === 'string' ? { tab: target } : target
  const given = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined))
  const wanted = { ...given, tab: (given as Partial<Route>).tab ?? current.tab }
  const staying = toRoute(wanted).tab === current.tab
  const carried = staying ? { app: current.app, sub: current.sub } : memory
  return withDefaults(toRoute({ ...carried, ...wanted }), landing)
}

/** The URL for a route: /tab[/app|/sub][#hash], preserving ?project= and ?thread= on chat. */
export function buildPath(route: Route, search = ''): string {
  const parts = [route.tab]
  if (route.tab === 'productivity' && route.app) parts.push(route.app)
  if (route.sub) parts.push(route.sub)
  const query = route.tab === 'chat' ? threadQuery(search) : ''
  return `/${parts.join('/')}${query}${route.hash ? `#${route.hash}` : ''}`
}

/** Keep only ?project= and ?thread= — the query params that still mean something. */
function threadQuery(search: string): string {
  const params = new URLSearchParams(search)
  const out = new URLSearchParams()
  for (const key of ['project', 'thread']) { const v = params.get(key); if (v) out.set(key, v) }
  const q = out.toString()
  return q ? `?${q}` : ''
}

/**
 * Read the current location as a route.
 *
 * Path wins; a legacy `?tab=`/`?app=`/`?stab=` query is the fallback, so old
 * links keep working. `?thread=` on its own still means "open the chat".
 * `landing` (the user's default-tab pref) fills an empty path.
 */
export function parseLocation(loc: Location, landing?: string): Route {
  const params = new URLSearchParams(loc.search)
  const segments = loc.pathname.split('/').filter(Boolean)
  const hash = loc.hash ? loc.hash.slice(1) : null

  // An unknown first segment is a stale or typo'd URL, not a tab — fall through.
  const [first, second] = segments
  if (first && (TAB_IDS.includes(first) || productivityApp(first))) {
    return withDefaults(toRoute({ tab: first, app: second, sub: second, hash }), landing)
  }

  // Legacy query form, or a bare "/" — fall back to ?tab=, then the landing pref.
  const legacyTab = params.get('tab')
  const target = legacyTab
    || (params.get('thread') || params.get('project') ? 'chat' : null)
    || landing
    || 'overview'
  return withDefaults(
    toRoute({ tab: target, app: params.get('app'), sub: params.get('stab'), hash }),
    landing,
  )
}
