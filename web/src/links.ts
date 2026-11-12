/**
 * Where a clicked link goes: the one decision for every link on the page.
 *
 *   file      a file on the box (an absolute path, `file://`, Totem's raw-file URL)
 *             → the chat's canvas, or an in-app download where there is no canvas.
 *   app       any other path on the server: a dashboard page (the bridge answers
 *             an unknown path with the dashboard too) → navigate in the window.
 *   resource  what the API serves (uploads, attachments: `/api/…`)
 *             → the chat's canvas, or an in-app download.
 *   external  another site → left alone: a new tab in a browser, the system
 *             browser in the desktop app (its link shim, desktop/src-tauri/src/lib.rs).
 *
 * In a browser only file links are taken over; everything else, and any click
 * with a modifier, keeps the browser's own behaviour (a new tab is still Totem).
 *
 * The desktop app's shim sends every link that opens a new tab, or leaves the
 * server, to the system browser. A file link in a reply has `target=_blank`, so
 * it went out too, to a browser usually not signed in. In the app nothing on the
 * server leaves the window: this listener runs in the window's capture phase,
 * ahead of the shim's (document, capture), and the shim skips a click whose
 * default was prevented. `window.open` gets the same rule, but only during the
 * owner's own click: a chart page can ask the host to open a URL at any time,
 * and must not drive the app. No new desktop build is needed for any of it.
 */
import { api } from './api'
import { downloads } from './downloads'
import { pushError } from './toast'

export type LinkRoute =
  | { kind: 'file'; path: string }
  | { kind: 'app'; to: string }
  | { kind: 'resource'; url: string }
  | { kind: 'external'; url: string }

/** Where a file on the box sits: the folders an agent's absolute paths start with. */
const FS_PATH = /^\/(Users|home|root|tmp|private|var|opt|mnt|Volumes|srv)\//

const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

/** What `href` (as written in the page) points at, seen from the dashboard at `origin`. */
export function classifyLink(href: string, origin: string): LinkRoute | null {
  const raw = (href || '').trim()
  if (!raw || raw.startsWith('#')) return null
  if (/^file:\/\//i.test(raw)) {
    const path = decode(raw.replace(/^file:\/\/(localhost)?/i, '').split(/[?#]/)[0])
    return FS_PATH.test(path) ? { kind: 'file', path } : null
  }
  if (FS_PATH.test(raw)) return { kind: 'file', path: decode(raw) }
  let u: URL
  try { u = new URL(raw, origin) } catch { return null }
  if (!/^https?:$/.test(u.protocol)) return null
  if (u.origin !== origin) return { kind: 'external', url: u.href }
  const path = decode(u.pathname)
  if (FS_PATH.test(path)) return { kind: 'file', path }
  if (u.pathname === '/api/chat/files/raw' && u.searchParams.get('path')) return { kind: 'file', path: u.searchParams.get('path')! }
  if (u.pathname.startsWith('/api/')) return { kind: 'resource', url: u.href }
  return { kind: 'app', to: u.pathname + u.search + u.hash }
}

export interface LinkClick {
  href: string
  target?: string | null
  /** The link has a `download` attribute: downloads.ts takes it. */
  download?: boolean
  button: number
  /** Ctrl, ⌘, Shift or Alt held. */
  modified: boolean
}

/** The route to take over for this click, or null to leave it to the browser (or the desktop shim). */
export function linkAction(click: LinkClick, env: { origin: string; desktop: boolean }): LinkRoute | null {
  if (click.download) return null
  const route = classifyLink(click.href, env.origin)
  if (!route) return null
  if (!env.desktop) return click.button === 0 && !click.modified && route.kind === 'file' ? route : null
  if (click.button > 1 || route.kind === 'external') return null
  // A plain click on an in-window page link already stays in the window.
  if (route.kind === 'app' && click.target !== '_blank' && !click.modified && click.button === 0) return null
  return route
}

/** In the desktop app: the shim (or the app's marker) is on the page. */
export function inDesktopApp(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TOTEM_DESKTOP__ || (window as { __totemExternalLinks?: boolean }).__totemExternalLinks)
}

const fileName = (path: string) => path.split('/').filter(Boolean).pop() || 'download'

/** Download a file on the box through its signed link, so a bearer-only window's native download works. */
export function downloadFile(path: string) {
  api<{ url: string; name: string }>(`/api/chat/files/link?path=${encodeURIComponent(path)}`)
    .then((link) => downloads.start(link.url, link.name))
    // The unsigned raw URL would fail the same way, so there is nothing to fall back on.
    .catch((e) => pushError(`Couldn’t download ${fileName(path)}: ${e?.message || 'try again in a moment'}.`))
}

/** Act on a route: the open chat takes files and resources into its canvas (ChatView). */
export function followLink(route: LinkRoute) {
  if (route.kind === 'file') {
    const unhandled = window.dispatchEvent(new CustomEvent('totem:open-file', { detail: route.path, cancelable: true }))
    if (unhandled) downloadFile(route.path)
  } else if (route.kind === 'resource') {
    const unhandled = window.dispatchEvent(new CustomEvent('totem:open-resource', { detail: route.url, cancelable: true }))
    if (unhandled) downloads.start(route.url, decode(fileName(new URL(route.url).pathname)))
  } else if (route.kind === 'app') {
    window.history.pushState({}, '', route.to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
}

/** Route link clicks (and, in the desktop app, `window.open`) as above. Returns the uninstall. */
export function installLinkRouting(): () => void {
  const desktop = inDesktopApp()
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented) return
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null
    if (!a) return
    const route = linkAction({
      href: a.getAttribute('href') || '',
      target: a.getAttribute('target'),
      download: a.hasAttribute('download'),
      button: e.button,
      modified: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
    }, { origin: location.origin, desktop })
    if (!route) return
    e.preventDefault()
    followLink(route)
  }
  window.addEventListener('click', onClick, true)
  window.addEventListener('auxclick', onClick, true)
  const shimOpen = window.open
  if (desktop) {
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      // Only the owner's own click opens something in the app; anything else goes to the shim.
      const route = navigator.userActivation?.isActive ? classifyLink(String(url ?? ''), location.origin) : null
      if (route && route.kind !== 'external') { followLink(route); return null }
      return shimOpen.call(window, url, target, features)
    }) as typeof window.open
  }
  return () => {
    window.removeEventListener('click', onClick, true)
    window.removeEventListener('auxclick', onClick, true)
    if (desktop) window.open = shimOpen
  }
}
