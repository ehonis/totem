// Where a notification's link goes in the app, decided without touching the
// router so it can be checked on its own. A link is a dashboard path in any of
// the shapes web/src/router.ts parseLocation reads ("/inbox#P12",
// "/chat?thread=…", "/productivity/todos", "/settings/providers#usage", old
// "/?tab=…" links), the same path as an absolute URL on the bridge's own origin,
// or a page somewhere else (a GitHub run, a news story).

/** web/src/router.ts TAB_IDS. */
const WEB_TABS = ['overview', 'search', 'chat', 'messages', 'screen', 'productivity', 'totems', 'code', 'dev', 'fleet', 'inbox', 'logs', 'brain', 'settings']
/** web/src/router.ts PRODUCTIVITY_APPS. */
const PRODUCTIVITY = ['todos', 'calendar', 'habits', 'goals', 'lists', 'journal']
/** web/src/router.ts SUB_TABS.settings; each is also a settings pane id in the app. */
const SETTINGS_PANES = ['general', 'chat', 'ai', 'integrations', 'tasks', 'providers', 'shortcuts', 'notifications', 'voice', 'skills', 'jobs', 'connections', 'logs']
/** Tabs the app doesn't have: they open on the web dashboard. */
const WEB_ONLY = ['messages', 'screen', 'dev', 'logs', 'brain']

export type Destination =
  | { kind: 'external'; url: string }
  | { kind: 'web'; path: string }
  | { kind: 'landing' }
  | { kind: 'tab'; tab: 'overview' | 'search' | 'totems' | 'fleet' }
  | { kind: 'chat'; thread: string | null; project: string | null }
  | { kind: 'totem'; id: string }
  | { kind: 'device'; id: string }
  | { kind: 'inbox'; focus: string | null }
  | { kind: 'productivity'; app: string | null }
  | { kind: 'settings'; pane: string | null }
  | { kind: 'usage' }

const decode = (s: string) => {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')) } catch { return s }
}

/** scheme://host[:port], lowercased, default ports dropped; null for anything but http(s). */
export function originOf(url: string): string | null {
  const m = /^(https?):\/\/(?:[^@/?#]*@)?([^/?#]+)/i.exec(String(url || '').trim())
  if (!m) return null
  const scheme = m[1].toLowerCase()
  const host = m[2].toLowerCase().replace(scheme === 'https' ? /:443$/ : /:80$/, '')
  return `${scheme}://${host}`
}

/**
 * Where `url` lands. `bridgeOrigins` are the addresses the bridge answers on
 * (the connection's base URL, PUBLIC_URL): an absolute link on one of them is a
 * dashboard path, any other absolute link opens outside the app.
 */
export function notificationDestination(url: string, bridgeOrigins: (string | null | undefined)[] = []): Destination {
  let rest = String(url || '').trim()
  if (rest.startsWith('//')) rest = `https:${rest}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(rest)) {
    const origin = originOf(rest)
    const own = origin && bridgeOrigins.some((b) => b && originOf(b) === origin)
    if (!own) return { kind: 'external', url: rest }
    rest = rest.replace(/^https?:\/\/[^/?#]*/i, '')
  }
  if (!rest.startsWith('/')) rest = `/${rest}`

  const hashAt = rest.indexOf('#')
  const hash = hashAt >= 0 ? decode(rest.slice(hashAt + 1)) || null : null
  const beforeHash = hashAt >= 0 ? rest.slice(0, hashAt) : rest
  const queryAt = beforeHash.indexOf('?')
  const pathname = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash
  const params = new Map<string, string>()
  for (const pair of (queryAt >= 0 ? beforeHash.slice(queryAt + 1) : '').split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = decode(eq >= 0 ? pair.slice(0, eq) : pair)
    if (!params.has(key)) params.set(key, decode(eq >= 0 ? pair.slice(eq + 1) : ''))
  }
  const param = (k: string) => params.get(k) || null

  // parseLocation: a known first segment is the route; an unknown one is not a
  // dashboard page (a file the bridge serves, or a stale link), so the bridge
  // answers it in the browser; a bare "/" falls back to the legacy query.
  const [first, second] = pathname.split('/').filter(Boolean).map(decode)
  let tab: string
  let app: string | null
  let sub: string | null
  if (first) {
    if (!WEB_TABS.includes(first) && !PRODUCTIVITY.includes(first)) return { kind: 'web', path: rest }
    tab = first
    app = second || null
    sub = second || null
  } else {
    const legacy = param('tab') || (param('thread') || param('project') ? 'chat' : null)
    if (!legacy) return { kind: 'landing' }
    tab = legacy
    app = param('app')
    sub = param('stab')
  }

  // toRoute: Studio and Code are gone; productivity apps live inside Productivity.
  if (tab === 'studio') {
    if (sub === 'skills' || sub === 'connections') tab = 'settings'
    else return { kind: 'tab', tab: 'totems' }
  }
  if (tab === 'code') tab = 'dev'
  if (PRODUCTIVITY.includes(tab)) { app = tab; tab = 'productivity' }

  if (WEB_ONLY.includes(tab)) return { kind: 'web', path: rest }
  switch (tab) {
    case 'chat': return { kind: 'chat', thread: param('thread'), project: param('project') }
    case 'totems': {
      const id = param('totem')
      return id ? { kind: 'totem', id } : { kind: 'tab', tab: 'totems' }
    }
    case 'inbox': return { kind: 'inbox', focus: hash }
    case 'productivity': return { kind: 'productivity', app: app && PRODUCTIVITY.includes(app) ? app : null }
    case 'settings': {
      // The quota meters are a native sheet; the Providers pane around them is web-only.
      if (sub === 'providers' && hash === 'usage') return { kind: 'usage' }
      return { kind: 'settings', pane: sub && SETTINGS_PANES.includes(sub) ? sub : null }
    }
    // A machine's notification names it in the hash (fleet/store.mjs).
    case 'fleet': return hash ? { kind: 'device', id: hash } : { kind: 'tab', tab }
    case 'overview': case 'search': return { kind: 'tab', tab }
    default: return { kind: 'landing' }
  }
}
