// Following a link or file from a chat: the decision is lib/links.ts, this acts on
// it. A file on the box or anything the bridge serves opens inside the app (the
// file sheet or the viewer), which send the bearer and the Cloudflare Access token
// to the bridge alone. The in-app browser (SFSafariViewController) can't send
// either, so behind Access it showed Access's login page for every bridge link
// unless Safari happened to hold a cookie: it is kept for other sites.
import { Linking, Share } from 'react-native'
import { router } from 'expo-router'
import { File, Paths } from 'expo-file-system'
import { ApiError, api, authHeaders, getAppConfig } from '../../lib/api'
import { bridgeFetch, bridgeUrl, getBaseUrl } from '../../lib/connection'
import { cacheFileName, classifyLink, fileNameOf, fileView, headProvesGone, headersFor, mimeOf, safeDecode, type LinkRoute } from '../../lib/links'
import { openUrl } from '../../lib/siblingApps'
import { pushError } from '../../lib/toast'
import { tap } from '../../ui/haptics'
import { openDashboardUrl } from '../notifications/openUrl'

export interface OpenableFile {
  id?: string
  uploadId?: string
  name: string
  mime: string
  /** A bridge path (a signed upload or raw-file link). */
  url?: string
  /** The file's absolute path on the box, when it has one. */
  path?: string
}

/** Why a file can't be opened, in the owner's words. */
export function refusal(e: unknown, name: string): string {
  const status = e instanceof ApiError ? e.status : (e as { status?: number })?.status || 0
  if (status === 404) return `${name} is gone: it was moved or deleted.`
  if (status === 403) return `${name} is outside the folders Totem shares.`
  if (status === 401) return `Sign in again to open ${name}.`
  return `Couldn’t open ${name}: ${(e as Error)?.message || 'try again in a moment'}.`
}

/** Open a chat file: text in the file sheet, the rest in the viewer. */
export function openFile(f: OpenableFile) {
  tap()
  show(f)
}

function show(f: OpenableFile) {
  const id = f.uploadId || f.id || ''
  const url = f.url || (id ? `/api/chat/uploads/${encodeURIComponent(id)}` : '')
  if (!url) {
    if (f.path) void openPath(f.path)
    return
  }
  const params = { id, name: f.name, mime: f.mime, url }
  if (fileView(f.name, f.mime) === 'text') router.push({ pathname: '/chat/file', params })
  else router.push({ pathname: '/chat/view', params })
}

/** A file on the box, by absolute path: the bridge checks it and signs a link (web openFile in chat/store.ts). */
export async function openPath(path: string) {
  const name = fileNameOf(path)
  try {
    const link = await api<{ path: string; name: string; mime: string; url: string }>(`/api/chat/files/link?path=${encodeURIComponent(path)}`)
    show({ name: link.name || name, mime: link.mime || mimeOf(name), url: link.url, path: link.path || path })
  } catch (e) {
    pushError(refusal(e, name))
  }
}

/** How long a HEAD may take before the app stops waiting on it. */
export const HEAD_TIMEOUT_MS = 10_000

/** A HEAD to the bridge with the app's credentials, aborted after `ms`. */
export function headWithin(path: string, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return bridgeFetch(path, { method: 'HEAD', headers: authHeaders(), signal: controller.signal }).finally(() => clearTimeout(timer))
}

/** Something else the bridge serves (an upload, an attachment): a HEAD says what it is (web openResource). */
export async function openResource(path: string) {
  let name = fileNameOf(path)
  let mime = mimeOf(name)
  try {
    const r = await headWithin(path, HEAD_TIMEOUT_MS)
    if (r.status === 403 || r.status === 401 || headProvesGone(path, r.status)) throw Object.assign(new Error(r.statusText), { status: r.status })
    if (r.ok) {
      const disposition = r.headers.get('content-disposition') || ''
      const named = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] || /filename="([^"]*)"/i.exec(disposition)?.[1]
      if (named) name = safeDecode(named)
      mime = (r.headers.get('content-type') || '').split(';')[0].trim() || mimeOf(name)
    }
    // Another answer (a route without HEAD, no answer in time) still opens, with
    // the type its name suggests: the viewer reports what it gets.
  } catch (e) {
    if ((e as { status?: number })?.status) { pushError(refusal(e, name)); return }
  }
  show({ name, mime, url: path })
}

/**
 * Download a bridge file into the cache with the app's credentials, then hand it
 * to the share sheet (Save to Files, AirDrop, another app): the phone's download.
 */
export async function shareFile(url: string, name: string) {
  const abs = bridgeUrl(url)
  const dest = new File(Paths.cache, cacheFileName(name))
  if (dest.exists) dest.delete()
  try {
    const file = await File.downloadFileAsync(abs, dest, { headers: headersFor(abs, getBaseUrl(), authHeaders()) })
    await Share.share({ url: file.uri })
  } catch (e) {
    const status = Number(/\b(40[134])\b/.exec(String((e as Error)?.message))?.[1]) || 0
    throw status ? Object.assign(new Error(refusal({ status }, name)), { status }) : e
  }
}

/** mailto:, tel:, sms: straight to the system. Linking.canOpenURL would say no for any scheme Info.plist doesn't list. */
function openSystem(url: string) {
  Linking.openURL(url).catch(() => {
    const what = /^tel:/i.test(url) ? 'call' : /^sms:/i.test(url) ? 'text' : 'email'
    pushError(`No app on this phone can ${what} ${safeDecode(url.replace(/^[a-z]+:/i, '').split('?')[0])}.`)
  })
}

export function followRoute(route: LinkRoute) {
  switch (route.kind) {
    case 'file': return void openPath(route.path)
    case 'resource': return void openResource(route.path)
    case 'app': return void openDashboardUrl(route.path)
    case 'external': return void openUrl(route.url) // a Krakatoa or Bushido link opens that app
    case 'system': return openSystem(route.url)
  }
}

/**
 * A link tapped in a reply. Every kind is handled here and the Markdown library is
 * told not to act (it would ask Linking.canOpenURL, which answers false for mailto:
 * and tel: in an app that declares no query schemes, and drops any other href).
 */
export async function followLink(href: string) {
  const base = getBaseUrl()
  let route = classifyLink(href, [base])
  if (!route) {
    if (href && !href.trim().startsWith('#')) pushError(`Totem can’t open “${href.trim().slice(0, 80)}” from the app.`)
    return
  }
  tap()
  // A link the bridge built may use PUBLIC_URL rather than the address the app connects to.
  if (route.kind === 'external') {
    const pub = await Promise.race([getAppConfig().then((c) => c.publicUrl, () => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))])
    if (pub) route = classifyLink(href, [base, pub]) || route
  }
  followRoute(route)
}
