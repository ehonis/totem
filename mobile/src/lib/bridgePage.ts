// The rules for a bridge page drawn in the app's WebView (ui/BridgeWebView.tsx),
// pure so `node --test` runs them. First used for charts in replies (#260); any
// screen that shows a page the bridge serves uses the same component.
//
// - Only a page on the connected bridge is loaded: a relative path, or an absolute
//   URL under the bridge's base. Anything else gives no source at all, so the
//   credentials below can never be pointed at another site.
// - The credentials (the Cloudflare Access token) ride the first request only: they are the `headers` of
//   the WebView's `source`, which react-native-webview sends with that one load
//   and never with a navigation, a subresource or a redirect it follows. The
//   source is built once per mount, and bridgeNavigation refuses every later
//   top-level navigation, so nothing re-sends it.
// - The source URL loads once. A redirect before the page has loaded is a failure
//   (Access sending the WebView to its sign-in page); the source URL again (a
//   reload, `location.href = location.href`, even from an inline script while the
//   page is still parsing) or, once loaded, any other page closes it, as the web
//   closes a chart frame that loads twice. Only #hash jumps are let through.
import { readVisualMessage } from './chat/visuals.ts'

type Split = { origin: string; rest: string; hash: string }

// WebKit reports URLs in canonical form (lower-case scheme and host, no default
// port); the base URL is kept as typed. Compare them in one form.
function splitUrl(url: string): Split | null {
  const m = /^(https?):\/\/([^/?#@\s\\]+)([^#\s\\]*)(#\S*)?$/i.exec(String(url ?? ''))
  if (!m) return null
  const scheme = m[1].toLowerCase()
  const host = m[2].toLowerCase().replace(scheme === 'https' ? /:443$/ : /:80$/, '')
  return { origin: `${scheme}://${host}`, rest: m[3] || '/', hash: m[4] || '' }
}

/** Same document: same origin, path and query (the hash may differ). */
export function sameDocument(a: string, b: string): boolean {
  const x = splitUrl(a), y = splitUrl(b)
  return !!x && !!y && x.origin === y.origin && x.rest === y.rest
}

/** Whether a URL is on the bridge's origin. */
export function onBridgeOrigin(url: string, baseUrl: string): boolean {
  const x = splitUrl(url), y = splitUrl(baseUrl)
  return !!x && !!y && x.origin === y.origin
}

const PATH = /^\/(?![/\\])[^\s\\#]*$/

/**
 * The absolute URL of a bridge page, or null when `target` is not one: a path
 * ("/api/…", resolved against the base as bridgeUrl does) or an absolute URL
 * under the base. No #hash: the first load is matched exactly.
 */
export function bridgePageUrl(target: string | undefined, baseUrl: string): string | null {
  const base = splitUrl(baseUrl)
  if (!target || !base || base.hash || base.rest.includes('?')) return null
  const prefix = base.rest.replace(/\/+$/, '')
  let path = target
  if (!target.startsWith('/')) {
    const t = splitUrl(target)
    if (!t || t.hash || t.origin !== base.origin) return null
    if (prefix && t.rest !== prefix && !t.rest.startsWith(`${prefix}/`) && !t.rest.startsWith(`${prefix}?`)) return null
    path = t.rest.slice(prefix.length) || '/'
  }
  if (!PATH.test(path)) return null
  return `${base.origin}${prefix}${path}`
}

export type BridgeConnection = { baseUrl: string; accessToken?: string }
export type BridgeSource = { uri: string; headers: Record<string, string> }

/**
 * The WebView's source for a bridge page: its URL and the headers for that one
 * request. Null when the target is not on the bridge, so no header is ever built
 * for another origin. Only the Access token: never the bridge secret, since the
 * page may be agent-written; a page the bridge serves to a WebView is signed.
 */
export function bridgeSource(target: string | undefined, conn: BridgeConnection): BridgeSource | null {
  const uri = bridgePageUrl(target, conn.baseUrl)
  if (!uri || !onBridgeOrigin(uri, conn.baseUrl)) return null
  const headers: Record<string, string> = {}
  if (conn.accessToken) headers['cf-access-token'] = conn.accessToken
  return { uri, headers }
}

export type NavRequest = { url: string; isTopFrame?: boolean; navigationType?: string }
/** allow: let it load. block: refuse quietly. fail: the page never loaded. leave: the page tried to go elsewhere. */
export type NavDecision = 'allow' | 'block' | 'fail' | 'leave'

/** Where the view is: nothing requested yet, the source URL allowed but not finished, or loaded. */
export type NavPhase = 'new' | 'loading' | 'loaded'

/**
 * What to do with a top-level or frame navigation in a bridge page's WebView.
 * - new: only the source URL, once (the caller moves to `loading` on that allow).
 * - loading: the source URL again is the page reloading itself (`leave`); another
 *   URL is a redirect, such as Access's sign-in (`fail`). Both stop it.
 * - loaded: anything but a #hash jump is `leave`.
 */
export function bridgeNavigation(req: NavRequest, src: string, phase: NavPhase): NavDecision {
  const url = String(req?.url || '')
  if (req?.isTopFrame === false) {
    // A frame inside the page; an empty one cannot leave.
    return /^about:(blank|srcdoc)$/i.test(url) ? 'allow' : 'block'
  }
  const same = sameDocument(url, src)
  const hash = !!splitUrl(url)?.hash
  if (phase === 'new') return url === src || (same && !hash) ? 'allow' : 'fail'
  if (same && hash && req?.navigationType !== 'reload') return 'allow'
  return phase === 'loading' && !same ? 'fail' : 'leave'
}

/**
 * Whether a link the page opened (a tap on <a href> or window.open) may go to the
 * in-app browser: http(s) on another site only, as the web's visualOpensOutside.
 * The in-app browser has none of the app's credentials, so a bridge page would
 * only show Access's sign-in there.
 */
export function linkOpensOutside(url: string, baseUrl: string): boolean {
  const link = splitUrl(String(url || ''))
  return !!link && String(url).length <= 4096 && !onBridgeOrigin(String(url), baseUrl)
}

/**
 * The page's new height from a WebView message, or null. Only a size report is
 * taken (`totem-visual:size`, clamped as the web clamps it); anything else a page
 * posts, its own `open` request included, is dropped.
 */
export function pageHeightFrom(data: unknown): number | null {
  if (typeof data !== 'string' || data.length > 256) return null
  let parsed: unknown
  try { parsed = JSON.parse(data) } catch { return null }
  const msg = readVisualMessage(parsed)
  return msg?.kind === 'size' ? msg.height : null
}

/**
 * Injected after the page loads, only when the caller wants its height: report it
 * whenever it changes, measured as the bridge's chart bootstrap measures it framed
 * (chat/visuals.mjs). Nothing else.
 */
export const PAGE_HEIGHT_SCRIPT = `(function(){var p=window.ReactNativeWebView;if(!p)return;var h,z=function(){var r=document.documentElement;if(!r)return;var v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;p.postMessage(JSON.stringify({type:"totem-visual:size",height:v}));};if(window.ResizeObserver){var o=new window.ResizeObserver(z);o.observe(document.documentElement);if(document.body)o.observe(document.body);}window.addEventListener("load",z);z();})();true;`
