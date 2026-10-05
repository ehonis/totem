// Run with: node --test auth/guard.test.mjs
//
// The cross-site guard. A failure here means another website the owner visits
// could make their browser create tasks, approve inbox items, run /ask or change
// settings using the session cookie.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { guardRequest, isCrossSite, upgradeOriginAllowed } from './guard.mjs'

const HOST = 'totem.example.com'
const rq = (method, headers = {}) => ({ method, headers: { host: HOST, ...headers } })
const JSON_BODY = { 'content-type': 'application/json', 'content-length': '12' }

test('cookie and proxy requests from another site are refused', () => {
  for (const via of ['session', 'proxy', null]) {
    for (const headers of [
      { origin: 'https://evil.example', ...JSON_BODY },
      { origin: 'null', ...JSON_BODY },
      { 'sec-fetch-site': 'cross-site', ...JSON_BODY },
      { 'sec-fetch-site': 'same-site', origin: 'https://bushido.example.com', ...JSON_BODY },
    ]) {
      const verdict = guardRequest(rq('POST', headers), { via })
      assert.equal(verdict?.status, 403, `${via} ${JSON.stringify(headers)}`)
    }
  }
})

test('same-origin requests pass, with Origin, Sec-Fetch-Site, or neither', () => {
  assert.equal(guardRequest(rq('POST', { origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin', ...JSON_BODY }), { via: 'session' }), null)
  assert.equal(guardRequest(rq('DELETE', { origin: `https://${HOST}` }), { via: 'session' }), null)
  assert.equal(guardRequest(rq('POST', JSON_BODY), { via: 'session' }), null, 'no browser headers: not a cross-site browser request')
  // Behind a proxy that rewrites Host, PUBLIC_URL names the public origin.
  assert.equal(guardRequest({ method: 'POST', headers: { host: 'localhost:8787', origin: `https://${HOST}`, ...JSON_BODY } }, { via: 'session', publicUrl: `https://${HOST}` }), null)
  assert.equal(guardRequest({ method: 'POST', headers: { host: 'localhost:8787', 'x-forwarded-host': HOST, origin: `https://${HOST}`, ...JSON_BODY } }, { via: 'session' }), null)
})

test('bearer callers are not checked; reads are never checked', () => {
  assert.equal(guardRequest(rq('POST', { origin: 'https://elsewhere.example', 'content-type': 'text/plain', 'content-length': '3' }), { via: 'bearer' }), null)
  assert.equal(guardRequest(rq('GET', { origin: 'https://evil.example' }), { via: 'session' }), null)
})

test('a cookie request with a non-JSON body is a 415', () => {
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
    const headers = { origin: `https://${HOST}`, 'content-length': '5', ...(type ? { 'content-type': type } : {}) }
    assert.equal(guardRequest(rq('POST', headers), { via: 'session' })?.status, 415, String(type))
  }
  // The voice journal's raw audio upload is the one deliberate exception.
  assert.equal(guardRequest(rq('POST', { origin: `https://${HOST}`, 'content-length': '5', 'content-type': 'audio/mp4' }), { via: 'session' }), null)
  // No body at all (logout, delete) needs no type.
  assert.equal(guardRequest(rq('POST', { origin: `https://${HOST}` }), { via: 'session' }), null)
})

test('isCrossSite treats an unparseable Origin as foreign', () => {
  assert.equal(isCrossSite(rq('POST', { origin: 'not a url' })), true)
})

test('the terminal upgrade needs this host as its Origin', () => {
  assert.equal(upgradeOriginAllowed(rq('GET', { origin: `https://${HOST}` })), true)
  assert.equal(upgradeOriginAllowed(rq('GET', { origin: 'https://evil.example' })), false)
  assert.equal(upgradeOriginAllowed(rq('GET', { origin: 'null' })), false)
  assert.equal(upgradeOriginAllowed(rq('GET', {})), false)
})

test('bridge applies the guard to the auth routes, the API gate, /ask, /morning-text and the terminal', () => {
  const bridge = readFileSync(join(import.meta.dirname, '..', 'bridge.mjs'), 'utf8')
  const after = (marker) => {
    const i = bridge.indexOf(marker)
    assert.notEqual(i, -1, marker)
    return bridge.slice(i, i + 400)
  }
  assert.match(after("if (req.url.startsWith('/api/auth/')) {"), /refusedAsCrossSite\(req, res\)/)
  assert.match(after("// ---- Web dashboard API"), /refusedAsCrossSite\(req, res\)/)
  assert.match(after("req.url === '/morning-text'"), /refusedAsCrossSite\(req, res, \{ text: true \}\)/)
  assert.match(after("(req.url === '/ask' || req.url === '/ask-text')"), /refusedAsCrossSite\(req, res\)/)
  assert.match(after('authorize: (req) =>'), /upgradeOriginAllowed/)
})

test('bridge rejects non-object JSON bodies and survives stray rejections', () => {
  const bridge = readFileSync(join(import.meta.dirname, '..', 'bridge.mjs'), 'utf8')
  const start = bridge.indexOf('function readJsonBody(req)')
  const body = bridge.slice(start, bridge.indexOf('\n}\n', start))
  assert.match(body, /parsed === null \|\| typeof parsed !== 'object'/)
  assert.match(body, /status: 400/)
  assert.match(bridge, /process\.on\('unhandledRejection'/)
})
