// notify/push.mjs — Web Push, from scratch, on node:crypto alone.
//
// Two specs, both small:
//   RFC 8291 — the payload encryption (ECDH P-256 → HKDF → AES-128-GCM)
//   RFC 8292 — VAPID, the ES256 JWT that identifies this server to the push service
//
// Written out rather than pulled in as a dependency for one reason that matters:
// this repo has two runtime deps and both exist because the terminal genuinely
// needed them. The counter-argument is that hand-rolled crypto fails silently
// behind a black-box push service — so the encryption here is checked against the
// worked example in RFC 8291 Section 5 and Appendix A, byte for byte, in
// push.test.mjs. If those tests pass, the wire format is right.
//
// What they cannot prove is that Apple accepts it. That is a device check.
import { createECDH, hkdfSync, createCipheriv, createDecipheriv, randomBytes, createPrivateKey, sign as cryptoSign, createHash } from 'node:crypto'

const CURVE = 'prime256v1'
const RECORD_SIZE = 4096
const TAG_LENGTH = 16

export const b64url = (buf) => Buffer.from(buf).toString('base64url')
export const fromB64url = (str) => Buffer.from(String(str), 'base64url')

// ---------------------------------------------------------------------------
// RFC 8291 — payload encryption
// ---------------------------------------------------------------------------

// The key derivation, kept separate from the encryption so the RFC's intermediate
// values (PRK_key, IKM, PRK, CEK, NONCE) can each be asserted in a test rather
// than only the final ciphertext. A wrong CEK and a wrong nonce both produce
// "the phone got nothing", and telling them apart afterwards is miserable.
export function deriveKeys({ uaPublic, asPublic, sharedSecret, authSecret, salt }) {
  // key_info = "WebPush: info" || 0x00 || ua_public || as_public   (both uncompressed)
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info', 'ascii'),
    Buffer.alloc(1),
    uaPublic,
    asPublic,
  ])
  // IKM = HKDF(salt = auth_secret, ikm = ecdh_secret, info = key_info, L = 32)
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12))
  return { keyInfo, ikm, cek, nonce }
}

// Encrypt one payload for one subscription. `salt` and `serverKeys` are injectable
// only so the RFC's example can be reproduced exactly; in production both are
// fresh per message, which is what makes the nonce reuse question moot.
export function encryptPayload({ payload, uaPublicKey, authSecret, salt = randomBytes(16), serverKeys = null }) {
  const uaPublic = Buffer.isBuffer(uaPublicKey) ? uaPublicKey : fromB64url(uaPublicKey)
  const auth = Buffer.isBuffer(authSecret) ? authSecret : fromB64url(authSecret)

  const ecdh = createECDH(CURVE)
  if (serverKeys) ecdh.setPrivateKey(serverKeys.privateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const sharedSecret = ecdh.computeSecret(uaPublic)

  const { cek, nonce } = deriveKeys({ uaPublic, asPublic, sharedSecret, authSecret: auth, salt })

  // One record, so the padding delimiter is 0x02 ("last record"). A 0x01 here is
  // the classic bug: the UA waits for a record that never comes and shows nothing.
  const plaintext = Buffer.concat([
    Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'),
    Buffer.from([0x02]),
  ])

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])

  // header = salt(16) || rs(4, big endian) || idlen(1) || as_public(65)
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(asPublic.length, 20)

  return Buffer.concat([header, asPublic, body])
}

// The other half, used by the tests to prove a round trip and to decode the RFC's
// own ciphertext. Not used in production — nothing on the server ever decrypts a
// push — but a symmetric bug that passes a round-trip test is exactly why the
// known-answer vector matters more than this does.
export function decryptPayload({ body, uaPrivateKey, uaPublicKey, authSecret }) {
  const buf = Buffer.isBuffer(body) ? body : fromB64url(body)
  const salt = buf.subarray(0, 16)
  const idlen = buf.readUInt8(20)
  const asPublic = buf.subarray(21, 21 + idlen)
  const ciphertext = buf.subarray(21 + idlen)

  const ecdh = createECDH(CURVE)
  ecdh.setPrivateKey(Buffer.isBuffer(uaPrivateKey) ? uaPrivateKey : fromB64url(uaPrivateKey))
  const sharedSecret = ecdh.computeSecret(asPublic)

  const { cek, nonce } = deriveKeys({
    uaPublic: Buffer.isBuffer(uaPublicKey) ? uaPublicKey : fromB64url(uaPublicKey),
    asPublic,
    sharedSecret,
    authSecret: Buffer.isBuffer(authSecret) ? authSecret : fromB64url(authSecret),
    salt,
  })

  const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH)),
    decipher.final(),
  ])
  // Strip the padding delimiter and any padding after it.
  const delimiter = plain.lastIndexOf(0x02)
  return plain.subarray(0, delimiter === -1 ? plain.length : delimiter)
}

// ---------------------------------------------------------------------------
// RFC 8292 — VAPID
// ---------------------------------------------------------------------------

// A raw P-256 key pair as the push world expects it: base64url public (65 bytes,
// uncompressed) and private (32 bytes). Rotating the private key invalidates every
// existing subscription — the symptom is silence, not an error.
export function generateVapidKeys() {
  const ecdh = createECDH(CURVE)
  ecdh.generateKeys()
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(ecdh.getPrivateKey()),
  }
}

// Node will not sign with 32 raw bytes, so the raw pair becomes a JWK. The public
// half is required in the JWK, and deriving it from the private key here means a
// caller only has to keep the one secret.
function vapidPrivateKeyObject(rawPrivate) {
  const priv = Buffer.isBuffer(rawPrivate) ? rawPrivate : fromB64url(rawPrivate)
  const ecdh = createECDH(CURVE)
  ecdh.setPrivateKey(priv)
  const pub = ecdh.getPublicKey()
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64url(priv),
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
    format: 'jwk',
  })
}

// `aud` is the *origin* of the endpoint, not the endpoint. Sending the full URL is
// the most common VAPID rejection and the error text rarely says so.
export function audienceFor(endpoint) {
  const url = new URL(endpoint)
  return `${url.protocol}//${url.host}`
}

export function signVapidToken({ endpoint, subject, privateKey, expiresInSeconds = 12 * 60 * 60, now = Date.now() }) {
  if (!subject || !/^(mailto:|https:)/.test(subject)) {
    throw new Error('VAPID subject must be a mailto: or https: URL')
  }
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64url(JSON.stringify({
    aud: audienceFor(endpoint),
    // The spec caps this at 24 hours; 12 keeps a clock-skewed box well inside it.
    exp: Math.floor(now / 1000) + Math.min(expiresInSeconds, 23 * 60 * 60),
    sub: subject,
  }))
  const signingInput = `${header}.${claims}`
  // JWS wants the raw r||s pair, not the DER envelope Node defaults to.
  const signature = cryptoSign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: vapidPrivateKeyObject(privateKey),
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${b64url(signature)}`
}

export function vapidHeaders({ endpoint, subject, publicKey, privateKey, now = Date.now() }) {
  const token = signVapidToken({ endpoint, subject, privateKey, now })
  return { Authorization: `vapid t=${token}, k=${publicKey}` }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

// RFC 8030 §5.4: a Topic is at most 32 characters from the URL-safe base64
// alphabet. Totem's dedupe keys are neither — `task.due:task.due-today:2026-09-15:1`
// has colons, dots, and is too long — and Apple rejects the whole push with
// `400 BadWebPushTopic` rather than ignoring the header.
//
// Hashing keeps exactly the property the topic is for (the same key collapses to
// the same topic, so an undelivered message is replaced by its successor) while
// satisfying the grammar. Found in production: the test button sends no topic, so
// it worked while every scheduled push failed.
export function normalizeTopic(topic) {
  if (!topic) return null
  const raw = String(topic)
  // Already legal: pass it through, so a caller that knows the rules keeps its
  // readable topic.
  if (raw.length <= 32 && /^[A-Za-z0-9\-_]+$/.test(raw)) return raw
  return createHash('sha256').update(raw).digest('base64url').slice(0, 32)
}

// A 404/410 means the subscription is gone. Any other 4xx is this server's fault
// and will fail identically next time — retrying it three times just delays the
// error reaching the logs. 429 and 5xx are the genuinely transient ones.
export function isRetryable(status) {
  if (status === 0) return true            // network failure
  if (status === 429) return true
  return status >= 500
}

// One subscription, one message. Returns a result rather than throwing on an HTTP
// error, because the caller's job is to decide between "retry" and "this device is
// gone" — and that decision is the whole reason a dead subscription ever gets
// noticed.
export async function sendPush({
  subscription,
  payload,
  vapid,
  ttlSeconds = 4 * 60 * 60,
  urgency = 'normal',
  topic = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  now = Date.now(),
}) {
  const endpoint = subscription?.endpoint
  if (!endpoint) throw new Error('subscription has no endpoint')
  if (!subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error('subscription is missing its p256dh/auth keys')
  }

  const body = encryptPayload({
    payload,
    uaPublicKey: subscription.keys.p256dh,
    authSecret: subscription.keys.auth,
  })

  const headers = {
    ...vapidHeaders({ endpoint, ...vapid, now }),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttlSeconds),
    Urgency: urgency,
  }
  // A topic lets the push service collapse an unsent message with its replacement
  // — the right behaviour for a reminder that moved while the phone was off.
  const normalizedTopic = normalizeTopic(topic)
  if (normalizedTopic) headers.Topic = normalizedTopic

  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    return { ok: false, gone: false, retryable: true, status: 0, error: e.message || String(e) }
  }

  // 404 and 410 are the push service saying this subscription no longer exists —
  // on iOS, that the web app was removed from the Home Screen. It is never worth
  // retrying, and it must be surfaced rather than counted as a failed send.
  const gone = response.status === 404 || response.status === 410
  if (response.ok) return { ok: true, gone: false, retryable: false, status: response.status }

  const text = await response.text().catch(() => '')
  return {
    ok: false,
    gone,
    retryable: !gone && isRetryable(response.status),
    status: response.status,
    // 400 with an unhelpful body is nearly always the VAPID audience or an expired
    // JWT; say so, because the push services will not.
    error: text.slice(0, 300) || `HTTP ${response.status}`,
  }
}

// The payload the device receives.
//
// Two shapes, because they are displayed by different code:
//
//   declarative (Safari 18.4+) — the `web_push: 8030` envelope. Safari composes
//     and shows the notification itself without waking the service worker, which
//     is the more reliable path. It also means Safari decides the chrome, and it
//     attributes the notification to the web app.
//   service worker — no envelope. `sw.js` calls showNotification itself, so the
//     notification is exactly what we pass it.
//
// Both carry the same fields under `data`, so a notification renders the same
// either way.
export function pushPayload({ title, body = '', url = null, entryId = null, badge = 0, category = null, declarative = true }) {
  const data = { entryId, category, url, badge, title, body }
  if (!declarative) return JSON.stringify({ data })
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title,
      body,
      navigate: url || '/',
      app_badge: String(badge),
    },
    data,
  })
}
