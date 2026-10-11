// Signing in through Cloudflare Access, for a bridge published behind a tunnel.
//
// A browser gets past Access with a cookie after the login page. The app can't
// read that cookie, so it does what `cloudflared access login` does: open
// Access's CLI login page for the app, then collect the resulting app token from
// Cloudflare's transfer service, end-to-end encrypted to a key pair made for this
// one login (NaCl box; see cloudflared's token/transfer.go and token/encrypt.go).
// The token then rides every request as `cf-access-token`, which Access accepts
// and which leaves `Authorization` free for the bridge secret.
import nacl from 'tweetnacl'
import * as WebBrowser from 'expo-web-browser'
import { secureRandom } from './secureRandom'

const TRANSFER = 'https://login.cloudflareaccess.org/transfer/'
const POLL_TIMEOUT_MS = 3 * 60_000

// The key pair's public half is the only thing guarding the token in transit,
// so it must come from a secure source (secureRandom.ts).
nacl.setPRNG(secureRandom)

const b64 = {
  encode: (bytes: Uint8Array, url = false) => {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    const out = btoa(s)
    return url ? out.replace(/\+/g, '-').replace(/\//g, '_') : out
  },
  decode: (str: string) => {
    const bin = atob(str.trim().replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  },
}

function jwtPayload(jwt: string): Record<string, any> | null {
  try { return JSON.parse(new TextDecoder().decode(b64.decode(jwt.split('.')[1] || ''))) } catch { return null }
}

/** When an Access token stops working, in ms (its `exp`), or 0 if unreadable. */
export function accessTokenExpiry(token: string): number {
  const exp = jwtPayload(token)?.exp
  return typeof exp === 'number' ? exp * 1000 : 0
}

/** A response Access answered instead of the bridge: its login page (redirect followed) or a bare 401/302 from Access. */
export function isAccessResponse(r: Response): boolean {
  try { if (new URL(r.url).hostname.endsWith('.cloudflareaccess.com')) return true } catch {}
  return /Cloudflare-Access/i.test(r.headers.get('www-authenticate') || '')
}

/**
 * Whether Access guards this base URL, and if so its application AUD (which the
 * CLI login needs). A request without a token is sent to the team's login page,
 * whose `meta` JWT names the app.
 */
export async function probeAccess(baseUrl: string): Promise<{ protected: false } | { protected: true; aud: string }> {
  const r = await fetch(`${baseUrl}/health`, { headers: { accept: 'application/json' } })
  if (!isAccessResponse(r)) return { protected: false }
  const login = new URL(r.url)
  const aud = jwtPayload(login.searchParams.get('meta') || '')?.aud || login.searchParams.get('kid') || ''
  if (!aud) throw new Error('Cloudflare Access is in front of this server, but its login page did not name the app.')
  return { protected: true, aud }
}

/**
 * Open Access's login for the app and wait for the token. Resolves null if the
 * owner closes the sheet first. Throws on a transfer failure.
 */
export async function signInWithAccess(baseUrl: string, aud: string): Promise<string | null> {
  const keys = nacl.box.keyPair()
  const pub = b64.encode(keys.publicKey, true)
  const q = new URLSearchParams({ token: pub, aud })
  const redirect = `${baseUrl}/?${q}`
  q.set('redirect_url', redirect)
  q.set('send_org_token', 'true')
  q.set('edge_token_transfer', 'true')
  q.set('close_interstitial', 'true')
  const loginUrl = `${baseUrl}/cdn-cgi/access/cli?${q}`

  let closed = false
  const browser = WebBrowser.openBrowserAsync(loginUrl, { dismissButtonStyle: 'cancel', presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET })
    .then(() => { closed = true })
    .catch(() => { closed = true })

  const deadline = Date.now() + POLL_TIMEOUT_MS
  try {
    while (!closed && Date.now() < deadline) {
      // The transfer service long-polls: it answers once the login completes, or
      // with a non-200 to say "not yet". Only 5xx is a real failure.
      const r = await fetch(TRANSFER + pub, { headers: { 'user-agent': 'totem-ios' } }).catch(() => null)
      if (!r) { await new Promise((res) => setTimeout(res, 1500)); continue }
      if (r.status >= 500) throw new Error(`Cloudflare's login service failed (${r.status}).`)
      if (r.status !== 200) { await new Promise((res) => setTimeout(res, 1000)); continue }
      const sender = r.headers.get('service-public-key') || ''
      const sealed = b64.decode(await r.text())
      const opened = nacl.box.open(sealed.slice(24), sealed.slice(0, 24), b64.decode(sender), keys.secretKey)
      if (!opened) throw new Error('Could not read the token Cloudflare sent back.')
      const { app_token: appToken } = JSON.parse(new TextDecoder().decode(opened)) as { app_token?: string }
      if (!appToken) throw new Error('Cloudflare did not send an app token.')
      return appToken
    }
    return null
  } finally {
    if (!closed) WebBrowser.dismissBrowser()
    await browser
  }
}
