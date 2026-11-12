// The shapes and the text that must survive are in redact.corpus.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REDACT_MAX, redactTokens } from './redact.mjs'
import { b64url, fill, ORDINARY, pem, pemEnd, shapes } from './redact.corpus.mjs'

test('every known token shape is redacted', () => {
  for (const [name, text, leaks] of shapes()) {
    const out = redactTokens(`before ${text} after`)
    for (const leak of leaks) assert.ok(!out.includes(leak), `${name} survived: ${out}`)
    assert.match(out, /redacted/, name)
  }
})

test('ordinary text comes back unchanged', () => {
  for (const text of ORDINARY) assert.equal(redactTokens(text), text)
})

test('a JWT goes whole, header and payload too', () => {
  const jwt = [b64url({ alg: 'HS256' }), b64url({ sub: 'u1' }), fill(43, 2)].join('.')
  assert.equal(redactTokens(jwt), '[redacted jwt]')
})

test('a private key block goes whole, and the text after it stays', () => {
  const block = [pem('RSA PRIVATE'), fill(64, 1), pemEnd('RSA PRIVATE')].join('\n')
  assert.equal(redactTokens(`${block}\nnext line`), '[redacted private key]\nnext line')
})

// Linear time, not speed: these run in about 10 ms on a dev machine, and a shared CI runner
// under load has taken over 50. A pattern that backtracks takes seconds here (one took 23 s),
// so 250 ms still catches it without failing a busy runner.
test('100,000 characters of anything a pattern starts on take under 250 ms', () => {
  const seeds = ['a', 'a.', 'a-', 'A1b', 'A1b/', '"', '"accessToken":"', 'token=', '?token=', 'AUTH_', 'Basic ', 'Bearer ',
    'Authorization: Basic ', 'eyJ', 'https://', 'https://a', pem('PRIVATE'), 'a@', '=', 'Aa1', 'x ']
  for (const seed of seeds) {
    const text = seed.repeat(Math.ceil(100000 / seed.length)).slice(0, 100000)
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      redactTokens(text)
      best = Math.min(best, performance.now() - t)
    }
    assert.ok(best < 250, `${JSON.stringify(seed)} took ${best.toFixed(1)} ms`)
  }
})

test('past the limit the rest is cut, never passed on unchecked', () => {
  const secret = ['gh', 'p_'].join('') + fill(36, 8)
  const out = redactTokens(`${'x '.repeat(REDACT_MAX / 2)}${secret}`)
  assert.ok(!out.includes(fill(36, 8)))
  assert.match(out, /more characters cut before redaction\]$/)
})
