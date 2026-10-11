// notify/apns.mjs — push to the native iPhone app through Apple's own service.
//
// The web app gets notifications through Web Push (push.mjs). The native app
// (Totem for iPhone) cannot: iOS delivers to an installed app only through APNs.
// Same idea as push.mjs, no dependencies: token-based auth (an ES256 JWT signed
// with the team's .p8 key, node:crypto) over HTTP/2 (node:http2).
//
// Apple's rules this follows:
//   * The JWT may be reused for up to an hour and must not be minted more than
//     once every 20 minutes, so one is kept and replaced after 40 minutes.
//   * A TestFlight or App Store build talks to the production host; a debug build
//     to the sandbox. A token from one is rejected by the other with
//     BadDeviceToken, which is why each device records its environment.
//   * 410 Unregistered (the app was deleted) and BadDeviceToken are permanent:
//     the device is gone. 429 and 5xx are worth another try.
import { connect } from 'node:http2'
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}
const TOKEN_TTL_MS = 40 * 60_000
const GONE_REASONS = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic'])

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/**
 * APNs settings from the environment, or null when push to the app is off.
 * APNS_KEY holds the .p8 contents; APNS_KEY_FILE points at the file instead.
 */
export function apnsConfigFromEnv(env = process.env) {
  const keyPem = env.APNS_KEY || (env.APNS_KEY_FILE ? safeRead(env.APNS_KEY_FILE) : '')
  if (!keyPem || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) return null
  return { keyPem: keyPem.replace(/\\n/g, '\n'), keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC }
}

function safeRead(file) {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

/** The provider token: header and claims as Apple specifies, signed ES256 (raw r||s, not DER). */
export function providerToken({ keyPem, keyId, teamId }, at = Date.now()) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(at / 1000) }))
  const input = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey(keyPem), dsaEncoding: 'ieee-p1363' })
  return `${input}.${b64url(signature)}`
}

/**
 * The notification as APNs wants it. The app reads `url` and `entryId` the way the
 * service worker reads Web Push's `data`; `thread-id` groups a category together
 * on the lock screen.
 */
export function apnsPayload({ title, body = '', url = null, entryId = null, badge = 0, category = null }) {
  return {
    aps: {
      alert: body ? { title, body } : { title },
      sound: 'default',
      badge,
      ...(category ? { 'thread-id': category } : {}),
    },
    url,
    entryId,
    category,
  }
}

/**
 * A sender with its own cached token and one HTTP/2 session per host, reused
 * across sends the way Apple asks. `send` resolves to the same shape as push.mjs's
 * sendPush: { ok, status, gone, retryable, error }.
 */
export function createApnsSender(config, { connectImpl = connect, now = () => Date.now() } = {}) {
  let token = null
  let tokenAt = 0
  const sessions = new Map()

  const bearer = () => {
    if (!token || now() - tokenAt > TOKEN_TTL_MS) {
      tokenAt = now()
      token = providerToken(config, tokenAt)
    }
    return token
  }

  const session = (env) => {
    const host = HOSTS[env] || HOSTS.production
    let s = sessions.get(host)
    if (!s || s.closed || s.destroyed) {
      s = connectImpl(host)
      s.on('error', () => sessions.delete(host))
      s.on('close', () => sessions.delete(host))
      // An idle session would keep the bridge's event loop busy for nothing.
      s.unref?.()
      sessions.set(host, s)
    }
    return s
  }

  function send({ deviceToken, environment = 'production', payload, collapseId = null }) {
    return new Promise((resolve) => {
      let req
      try {
        req = session(environment).request({
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${bearer()}`,
          'apns-topic': config.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          // Apple caps the collapse id at 64 bytes.
          ...(collapseId ? { 'apns-collapse-id': String(collapseId).slice(0, 64) } : {}),
        })
      } catch (e) {
        resolve({ ok: false, status: 0, gone: false, retryable: true, error: e.message || String(e) })
        return
      }
      let status = 0
      const chunks = []
      req.setTimeout(15_000, () => req.close())
      req.on('response', (headers) => { status = Number(headers[':status']) || 0 })
      req.on('data', (c) => chunks.push(c))
      req.on('error', (e) => resolve({ ok: false, status, gone: false, retryable: true, error: e.message || String(e) }))
      req.on('close', () => {
        if (status === 200) return resolve({ ok: true, status, gone: false, retryable: false })
        let reason = ''
        try { reason = JSON.parse(Buffer.concat(chunks).toString('utf8')).reason || '' } catch {}
        // A token Apple rejected outright: drop the cached one so the next send mints fresh.
        if (status === 403 && /Token/.test(reason)) token = null
        resolve({
          ok: false,
          status,
          gone: status === 410 || GONE_REASONS.has(reason),
          retryable: status === 429 || status >= 500 || status === 0 || reason === 'ExpiredProviderToken',
          error: reason || (status ? `http ${status}` : 'no response'),
        })
      })
      req.end(JSON.stringify(payload))
    })
  }

  function close() {
    for (const s of sessions.values()) s.close()
    sessions.clear()
  }

  return { send, close }
}
