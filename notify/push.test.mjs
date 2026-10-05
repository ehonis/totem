// Run with: node --test notify/push.test.mjs
//
// The point of this file is the known-answer test below. Hand-rolled crypto that
// only round-trips against itself will happily be wrong in a way that looks
// perfect from the inside and produces silence on the phone — so the encryption is
// checked against the worked example in RFC 8291 Section 5 and Appendix A, byte
// for byte, including every intermediate value.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import {
  encryptPayload, decryptPayload, deriveKeys, generateVapidKeys, signVapidToken,
  vapidHeaders, audienceFor, sendPush, pushPayload, b64url, fromB64url, normalizeTopic, isRetryable,
} from './push.mjs'

// RFC 8291 §5 and Appendix A, verbatim.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  sharedSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

test('the ECDH agreement matches the RFC example', () => {
  const as = createECDH('prime256v1')
  as.setPrivateKey(fromB64url(RFC.asPrivate))
  assert.equal(b64url(as.getPublicKey()), RFC.asPublic)
  assert.equal(b64url(as.computeSecret(fromB64url(RFC.uaPublic))), RFC.sharedSecret)
})

test('every derived key matches the RFC example', () => {
  const { ikm, cek, nonce } = deriveKeys({
    uaPublic: fromB64url(RFC.uaPublic),
    asPublic: fromB64url(RFC.asPublic),
    sharedSecret: fromB64url(RFC.sharedSecret),
    authSecret: fromB64url(RFC.authSecret),
    salt: fromB64url(RFC.salt),
  })
  assert.equal(b64url(ikm), RFC.ikm)
  assert.equal(b64url(cek), RFC.cek)
  assert.equal(b64url(nonce), RFC.nonce)
})

test('the encrypted body is byte-for-byte the RFC example', () => {
  const as = createECDH('prime256v1')
  as.setPrivateKey(fromB64url(RFC.asPrivate))
  const body = encryptPayload({
    payload: RFC.plaintext,
    uaPublicKey: RFC.uaPublic,
    authSecret: RFC.authSecret,
    salt: fromB64url(RFC.salt),
    serverKeys: { privateKey: fromB64url(RFC.asPrivate) },
  })
  assert.equal(b64url(body), RFC.body)
})

test('the RFC ciphertext decrypts back to its plaintext', () => {
  const plain = decryptPayload({
    body: RFC.body,
    uaPrivateKey: RFC.uaPrivate,
    uaPublicKey: RFC.uaPublic,
    authSecret: RFC.authSecret,
  })
  assert.equal(plain.toString('utf8'), RFC.plaintext)
})

test('the header carries salt, record size and the server key in the right places', () => {
  const body = encryptPayload({
    payload: 'hi', uaPublicKey: RFC.uaPublic, authSecret: RFC.authSecret,
    salt: fromB64url(RFC.salt), serverKeys: { privateKey: fromB64url(RFC.asPrivate) },
  })
  assert.deepEqual(body.subarray(0, 16), fromB64url(RFC.salt))
  assert.equal(body.readUInt32BE(16), 4096)
  assert.equal(body.readUInt8(20), 65)
  assert.equal(b64url(body.subarray(21, 86)), RFC.asPublic)
})

test('a fresh salt and server key are used for every message', () => {
  const args = { payload: 'same text', uaPublicKey: RFC.uaPublic, authSecret: RFC.authSecret }
  const a = encryptPayload(args)
  const b = encryptPayload(args)
  // Identical plaintext must not produce identical ciphertext: a reused nonce with
  // the same key is the one catastrophic mistake available in AES-GCM.
  assert.notEqual(b64url(a), b64url(b))
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16))
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86))
})

test('a round trip works for realistic notification payloads', () => {
  const payload = pushPayload({
    title: "Marion Keller's birthday is today",
    body: 'your mom, Marion, turns 65 today.',
    url: '/brain',
    entryId: 'n_abc123',
    badge: 3,
  })
  const body = encryptPayload({ payload, uaPublicKey: RFC.uaPublic, authSecret: RFC.authSecret })
  const out = decryptPayload({
    body, uaPrivateKey: RFC.uaPrivate, uaPublicKey: RFC.uaPublic, authSecret: RFC.authSecret,
  })
  const parsed = JSON.parse(out.toString('utf8'))
  assert.equal(parsed.notification.title, "Marion Keller's birthday is today")
  assert.equal(parsed.notification.navigate, '/brain')
  assert.equal(parsed.data.entryId, 'n_abc123')
  // Declarative Web Push wants the badge as a string.
  assert.equal(parsed.notification.app_badge, '3')
  assert.equal(parsed.web_push, 8030)
})

test('an empty payload still encrypts and decrypts', () => {
  const body = encryptPayload({ payload: '', uaPublicKey: RFC.uaPublic, authSecret: RFC.authSecret })
  const out = decryptPayload({ body, uaPrivateKey: RFC.uaPrivate, uaPublicKey: RFC.uaPublic, authSecret: RFC.authSecret })
  assert.equal(out.toString('utf8'), '')
})

test('VAPID keys are the raw sizes the push services expect', () => {
  const { publicKey, privateKey } = generateVapidKeys()
  assert.equal(fromB64url(publicKey).length, 65)
  assert.equal(fromB64url(publicKey)[0], 0x04) // uncompressed point
  assert.equal(fromB64url(privateKey).length, 32)
})

test('the VAPID token is a verifiable ES256 JWT with the right claims', () => {
  const { publicKey, privateKey } = generateVapidKeys()
  const now = Date.UTC(2026, 8, 15, 12, 0)
  const token = signVapidToken({
    endpoint: 'https://web.push.apple.com/abc/def?x=1',
    subject: 'mailto:ethan@example.com',
    privateKey,
    now,
  })
  const [header, claims, signature] = token.split('.')
  assert.deepEqual(JSON.parse(fromB64url(header)), { typ: 'JWT', alg: 'ES256' })

  const parsed = JSON.parse(fromB64url(claims))
  // The audience is the origin, not the endpoint. Sending the full URL is the most
  // common VAPID rejection there is.
  assert.equal(parsed.aud, 'https://web.push.apple.com')
  assert.equal(parsed.sub, 'mailto:ethan@example.com')
  assert.equal(parsed.exp, Math.floor(now / 1000) + 12 * 60 * 60)

  // The signature verifies against the public half of the same pair, as raw r||s.
  const raw = fromB64url(publicKey)
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) },
    format: 'jwk',
  })
  assert.equal(fromB64url(signature).length, 64)
  assert.equal(
    cryptoVerify('sha256', Buffer.from(`${header}.${claims}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, fromB64url(signature)),
    true,
  )
})

test('the token expiry is capped below the 24 hour maximum', () => {
  const { privateKey } = generateVapidKeys()
  const now = Date.UTC(2026, 8, 15, 12, 0)
  const token = signVapidToken({
    endpoint: 'https://push/1', subject: 'mailto:a@b.c', privateKey, now, expiresInSeconds: 48 * 60 * 60,
  })
  const exp = JSON.parse(fromB64url(token.split('.')[1])).exp
  assert.ok(exp - Math.floor(now / 1000) <= 24 * 60 * 60)
})

test('a subject that is not mailto: or https: is refused up front', () => {
  const { privateKey } = generateVapidKeys()
  assert.throws(
    () => signVapidToken({ endpoint: 'https://push/1', subject: 'ethan@example.com', privateKey }),
    /mailto:/,
  )
})

test('audienceFor strips path and query', () => {
  assert.equal(audienceFor('https://fcm.googleapis.com/fcm/send/abc:def'), 'https://fcm.googleapis.com')
  assert.equal(audienceFor('https://web.push.apple.com/a/b?c=d'), 'https://web.push.apple.com')
})

const SUBSCRIPTION = {
  endpoint: 'https://web.push.apple.com/abc',
  keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret },
}
const VAPID = { subject: 'mailto:ethan@example.com', ...generateVapidKeys() }

test('a send carries the headers the push services require', async () => {
  let captured = null
  const result = await sendPush({
    subscription: SUBSCRIPTION,
    payload: pushPayload({ title: 'hello' }),
    vapid: VAPID,
    ttlSeconds: 600,
    topic: 'reminder-1',
    fetchImpl: async (url, init) => {
      captured = { url, init }
      return { ok: true, status: 201, text: async () => '' }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(captured.url, SUBSCRIPTION.endpoint)
  assert.equal(captured.init.headers['Content-Encoding'], 'aes128gcm')
  assert.equal(captured.init.headers['Content-Type'], 'application/octet-stream')
  assert.equal(captured.init.headers.TTL, '600')
  assert.equal(captured.init.headers.Topic, 'reminder-1')
  assert.match(captured.init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
  assert.ok(Buffer.isBuffer(captured.init.body))
})

test('410 and 404 are reported as gone, not as a failure to retry', async () => {
  for (const status of [404, 410]) {
    const result = await sendPush({
      subscription: SUBSCRIPTION, payload: 'x', vapid: VAPID,
      fetchImpl: async () => ({ ok: false, status, text: async () => 'unsubscribed' }),
    })
    assert.equal(result.gone, true, `status ${status}`)
    assert.equal(result.ok, false)
  }
})

test('a server error is retryable, and a network failure does not throw', async () => {
  const server = await sendPush({
    subscription: SUBSCRIPTION, payload: 'x', vapid: VAPID,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  })
  assert.equal(server.gone, false)
  assert.equal(server.status, 500)
  assert.equal(server.error, 'boom')

  const offline = await sendPush({
    subscription: SUBSCRIPTION, payload: 'x', vapid: VAPID,
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.equal(offline.ok, false)
  assert.equal(offline.status, 0)
  assert.match(offline.error, /ECONNREFUSED/)
})

test('a subscription missing its keys fails loudly, before any network call', async () => {
  let called = false
  await assert.rejects(
    () => sendPush({
      subscription: { endpoint: 'https://push/1' }, payload: 'x', vapid: VAPID,
      fetchImpl: async () => { called = true; return { ok: true, status: 201 } },
    }),
    /p256dh/,
  )
  assert.equal(called, false)
})

test('a topic is hashed into the grammar RFC 8030 actually requires', () => {
  // Apple answers `400 BadWebPushTopic` and drops the push entirely. Totem's
  // dedupe keys have colons and dots and are far longer than 32 characters.
  const topic = normalizeTopic('task.due:task.due-today:2026-09-15:1')
  assert.ok(topic.length <= 32)
  assert.match(topic, /^[A-Za-z0-9\-_]+$/)
  // The property the topic exists for survives: same key, same topic.
  assert.equal(topic, normalizeTopic('task.due:task.due-today:2026-09-15:1'))
  assert.notEqual(topic, normalizeTopic('task.due:task.due-today:2026-09-15:2'))
  // A caller that already knows the rules keeps its readable topic.
  assert.equal(normalizeTopic('reminder-1'), 'reminder-1')
  assert.equal(normalizeTopic(null), null)
})

test('the Topic header sent to the push service is always legal', async () => {
  let captured = null
  await sendPush({
    subscription: SUBSCRIPTION, payload: 'x', vapid: VAPID,
    topic: 'habit.slipping:habit.streak-ending:3-year-journal:2026-09-15',
    fetchImpl: async (_url, init) => { captured = init; return { ok: true, status: 201, text: async () => '' } },
  })
  assert.ok(captured.headers.Topic.length <= 32)
  assert.match(captured.headers.Topic, /^[A-Za-z0-9\-_]+$/)
})

test('only genuinely transient failures are reported as retryable', async () => {
  const at = async (status) => (await sendPush({
    subscription: SUBSCRIPTION, payload: 'x', vapid: VAPID,
    fetchImpl: async () => ({ ok: false, status, text: async () => '' }),
  })).retryable
  assert.equal(await at(400), false) // our bug; identical next time
  assert.equal(await at(403), false) // bad VAPID
  assert.equal(await at(410), false) // gone
  assert.equal(await at(429), true)  // slow down
  assert.equal(await at(503), true)  // push service having a moment
  const offline = await sendPush({
    subscription: SUBSCRIPTION, payload: 'x', vapid: VAPID,
    fetchImpl: async () => { throw new Error('ECONNRESET') },
  })
  assert.equal(offline.retryable, true)
})

test('the two payload shapes carry the same fields to different renderers', () => {
  const args = { title: 'Pick up bike', body: 'Due today.', url: '/productivity/todos', entryId: 'n_1', badge: 2 }

  // Declarative: Safari composes and shows it without waking the service worker.
  const declarative = JSON.parse(pushPayload(args))
  assert.equal(declarative.web_push, 8030)
  assert.equal(declarative.notification.title, 'Pick up bike')
  assert.equal(declarative.data.title, 'Pick up bike')

  // Service worker: no envelope, so sw.js composes it and decides the chrome.
  const sw = JSON.parse(pushPayload({ ...args, declarative: false }))
  assert.equal(sw.web_push, undefined)
  assert.equal(sw.notification, undefined)
  assert.equal(sw.data.title, 'Pick up bike')
  assert.equal(sw.data.body, 'Due today.')
  assert.equal(sw.data.url, '/productivity/todos')
  assert.equal(sw.data.entryId, 'n_1')
  assert.equal(sw.data.badge, 2)
})
