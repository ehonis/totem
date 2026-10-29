// Run with: node --test notify/apns.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { generateKeyPairSync, verify } from 'node:crypto'
import { apnsConfigFromEnv, apnsDismissPayload, apnsPayload, createApnsSender, providerToken } from './apns.mjs'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const CONFIG = { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'KEY123', teamId: 'TEAM45', topic: 'com.example.totem' }

test('the provider token is an ES256 JWT Apple can verify', () => {
  const jwt = providerToken(CONFIG, Date.UTC(2026, 9, 7))
  const [h, c, sig] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY123' })
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { iss: 'TEAM45', iat: Date.UTC(2026, 9, 7) / 1000 })
  // Raw r||s (64 bytes), not DER: that is what JWS ES256 means.
  assert.equal(Buffer.from(sig, 'base64url').length, 64)
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')))
})

test('the payload carries the alert, a badge, and what the app needs to open it', () => {
  assert.deepEqual(apnsPayload({ title: 'Due', body: 'Pay rent', url: '/inbox', entryId: 'n1', badge: 3, category: 'task.due' }), {
    aps: { alert: { title: 'Due', body: 'Pay rent' }, sound: 'default', badge: 3, 'thread-id': 'task.due' },
    url: '/inbox', entryId: 'n1', category: 'task.due',
    body: { url: '/inbox', entryId: 'n1', category: 'task.due' },
  })
  assert.deepEqual(apnsPayload({ title: 'Only a title' }).aps.alert, { title: 'Only a title' })
  assert.equal(apnsPayload({ title: 'Done', tag: 'chat:t1' }).tag, 'chat:t1')
})

// expo-notifications sets a remote notification's content.data to userInfo.body and
// nothing else; with the fields only at the top level the app saw no url.
test('the app-facing fields sit under body, where expo-notifications reads data', () => {
  const p = apnsPayload({ title: 'Reply ready', url: '/chat?thread=t1', entryId: 'n2', category: 'chat.finished', tag: 'chat:t1' })
  assert.deepEqual(p.body, { url: '/chat?thread=t1', entryId: 'n2', category: 'chat.finished', tag: 'chat:t1' })
})

test('a dismissal is silent: no alert, no sound, only the tags to take down', () => {
  assert.deepEqual(apnsDismissPayload(['chat:t1']), { aps: { 'content-available': 1 }, dismiss: ['chat:t1'] })
})

test('config is off unless every setting is present', () => {
  assert.equal(apnsConfigFromEnv({ APNS_KEY: 'k', APNS_KEY_ID: 'a', APNS_TEAM_ID: 'b' }), null)
  assert.deepEqual(apnsConfigFromEnv({ APNS_KEY: 'a\\nb', APNS_KEY_ID: 'a', APNS_TEAM_ID: 'b', APNS_TOPIC: 'c' }), { keyPem: 'a\nb', keyId: 'a', teamId: 'b', topic: 'c' })
})

// A fake HTTP/2 session: records the request and answers with a status and body.
function fakeConnect(answer, seen) {
  return (host) => {
    const session = new EventEmitter()
    session.request = (headers) => {
      const req = new EventEmitter()
      req.setTimeout = () => {}
      req.close = () => {}
      req.end = (body) => {
        seen.push({ host, headers, body: JSON.parse(body) })
        const { status, reason } = answer()
        queueMicrotask(() => {
          req.emit('response', { ':status': status })
          if (reason) req.emit('data', Buffer.from(JSON.stringify({ reason })))
          req.emit('close')
        })
      }
      return req
    }
    session.close = () => {}
    return session
  }
}

test('a send goes to the right host with the topic, collapse id and bearer', async () => {
  const seen = []
  const apns = createApnsSender(CONFIG, { connectImpl: fakeConnect(() => ({ status: 200 }), seen) })
  const result = await apns.send({ deviceToken: 'ab'.repeat(32), environment: 'sandbox', payload: { aps: {} }, collapseId: 'job:x' })
  assert.equal(result.ok, true)
  assert.equal(seen[0].host, 'https://api.sandbox.push.apple.com')
  assert.equal(seen[0].headers[':path'], `/3/device/${'ab'.repeat(32)}`)
  assert.equal(seen[0].headers['apns-topic'], 'com.example.totem')
  assert.equal(seen[0].headers['apns-collapse-id'], 'job:x')
  assert.match(seen[0].headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
})

test('a background send is a background push at priority 5, never collapsed', async () => {
  const seen = []
  const apns = createApnsSender(CONFIG, { connectImpl: fakeConnect(() => ({ status: 200 }), seen) })
  await apns.send({ deviceToken: 'ab'.repeat(32), payload: apnsDismissPayload(['chat:t1']), background: true })
  assert.equal(seen[0].headers['apns-push-type'], 'background')
  assert.equal(seen[0].headers['apns-priority'], '5')
  assert.equal(seen[0].headers['apns-collapse-id'], undefined)
  assert.deepEqual(seen[0].body.dismiss, ['chat:t1'])
})

test('a deleted app is gone; throttling is worth retrying', async () => {
  const answers = [{ status: 410, reason: 'Unregistered' }, { status: 400, reason: 'BadDeviceToken' }, { status: 429, reason: 'TooManyRequests' }]
  const apns = createApnsSender(CONFIG, { connectImpl: fakeConnect(() => answers.shift(), []) })
  const send = () => apns.send({ deviceToken: 'ab'.repeat(32), payload: {} })
  assert.deepEqual(await send(), { ok: false, status: 410, gone: true, retryable: false, error: 'Unregistered' })
  assert.equal((await send()).gone, true)
  const throttled = await send()
  assert.equal(throttled.gone, false)
  assert.equal(throttled.retryable, true)
})
