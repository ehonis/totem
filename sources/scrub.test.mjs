import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { scrubError } from './scrub.mjs'

// Test tokens are built at runtime, prefixes in pieces, so no literal here matches a
// provider's pattern: secret scanners (GitGuardian, the oss-sync check) read this file.
const fakeToken = (prefix, length = 32) => prefix.join('') + 'x'.repeat(length)
// Random-looking: letters and digits, the shape the unnamed-token fallback is for.
const randomish = (length) => randomBytes(length).toString('hex').slice(0, length).replace(/^\d/, 'a')

const PREFIX_SHAPES = {
  'GitHub classic': ['gh', 'p_'],
  'GitHub OAuth': ['gh', 'o_'],
  'GitHub user-to-server': ['gh', 'u_'],
  'GitHub server-to-server': ['gh', 's_'],
  'GitHub refresh': ['gh', 'r_'],
  'GitHub fine-grained': ['github', '_pat_'],
  'GitLab': ['gl', 'pat-'],
  'OpenAI-style': ['s', 'k-'],
  'Stripe live': ['sk', '_live_'],
  'Slack bot': ['xo', 'xb-'],
  'Slack user': ['xo', 'xp-'],
  'Google access': ['ya', '29.'],
  'Google API key': ['AI', 'za'],
  'Google refresh': ['1/', '/0'],
  'JWT': ['ey', 'J'],
  'AWS access key id': ['AK', 'IA'],
  'AWS temporary key id': ['AS', 'IA'],
}

test('a token with a known prefix is redacted even with nothing naming it', () => {
  for (const [name, prefix] of Object.entries(PREFIX_SHAPES)) {
    const token = fakeToken(prefix)
    const out = scrubError(`upstream rejected ${token} at 12:00`)
    assert.equal(out, 'upstream rejected [redacted] at 12:00', name)
  }
})

test('every shape a reviewer found leaking is redacted', () => {
  const v = randomish(40)
  const short = 'hunter2'
  const cases = {
    'auth_token=': `failed auth_token=${v}`,
    'session_token=': `failed session_token=${v}`,
    'private_key=': `bad private_key=${v}`,
    'client_key=': `bad client_key=${v}`,
    'env GITHUB_PERSONAL_ACCESS_TOKEN': `GITHUB_PERSONAL_ACCESS_TOKEN=${v} failed`,
    'env BUSHIDO_API_TOKEN': `BUSHIDO_API_TOKEN=${v}`,
    'spaces around =': `access_token = ${v}`,
    'password, short': `password=${short}`,
    'OAuth code=': `callback ?code=${fakeToken(['4/', '0A'], 30)}&state=abc`,
    'URL userinfo': `fetch failed https://user:${short}@mcp.example.com/sse`,
    'Slack webhook path': `POST https://hooks.slack.com/services/T0/B0/${'Z'.repeat(24)} 404`,
    'Telegram bot path': `GET https://api.telegram.org/bot123456:${'Q'.repeat(35)}/getMe`,
    'camelCase accessToken': `{"accessToken":"${v}"}`,
    'camelCase refreshToken': `{"refreshToken":"${v}"}`,
    'camelCase clientSecret': `{"clientSecret":"${v}"}`,
    'escaped JSON': `Gmail HTTP 400: {\\"refresh_token\\":\\"${v}\\",\\"x\\":1}`,
    'bare hex token (Strava)': `{"resource":"AccessToken","field":"${v}","code":"invalid"}`,
    'percent-encoded name': `https://x/cb?access%5Ftoken=${v}`,
    'percent-encoded =': `redirect=https%3A%2F%2Fx%3Faccess_token%3D${v}`,
    'PRIVATE-TOKEN header': `PRIVATE-TOKEN: ${v}`,
    'Token: header': `Token: ${v}`,
    'token: prose': `token: ${short}`,
    'x-goog-api-key header': `x-goog-api-key: ${v}`,
    'Authorization header line': `request failed\nAuthorization: Bearer ${short}\nHost: x`,
    'Authorization in JSON': `headers: {"Authorization":"Bearer ${v}"}`,
    'authorization in an object': `{ authorization: 'Basic ${v}' }`,
    'Bearer in prose, short': `Bushido rejected Bearer ${short}`,
    'Cookie header': `Cookie: session=${v}; other=1`,
    'client_secret in a form body': `body: grant_type=refresh_token&client_secret=${short}`,
  }
  for (const [name, message] of Object.entries(cases)) {
    const out = scrubError(message)
    for (const secret of [v, short, 'Z'.repeat(24), 'Q'.repeat(35), fakeToken(['4/', '0A'], 30)]) {
      assert.ok(!out.includes(secret), `${name}: ${out}`)
    }
    assert.ok(out.includes('[redacted]'), `${name}: ${out}`)
  }
})

test('the second round of shapes is redacted too', () => {
  const v = randomish(30)
  const cases = {
    'JSON password with a space': [`{"password":"${v} ${v}"}`, '{"password":"[redacted]"}'],
    'JSON password with a colon': [`{"password":"p@ss:${v}!x"}`, '{"password":"[redacted]"}'],
    'escaped JSON with a space': [`{\\"client_secret\\":\\"${v} x\\"}`, '{\\"client_secret\\":\\"[redacted]\\"}'],
    'XML element': [`<access_token>${v}</access_token>`, '<access_token>[redacted]</access_token>'],
    '?pass=': [`postgres://u@h/db?pass=${v}`, 'postgres://[redacted]@h/db?pass=[redacted]'],
    'db_pass:': [`db_pass: ${v}`, 'db_pass: [redacted]'],
    'PEM block': [`key -----BEGIN PRIVATE KEY-----\n${v}\n${v}\n-----END PRIVATE KEY----- rejected`, 'key -----BEGIN PRIVATE KEY-----[redacted]-----END PRIVATE KEY----- rejected'], // gitleaks:allow (a made-up key for the scrubber)
    'PEM cut off': [`-----BEGIN RSA PRIVATE KEY-----\n${v}`, '-----BEGIN RSA PRIVATE KEY-----[redacted]-----END RSA PRIVATE KEY-----'], // gitleaks:allow (a made-up key for the scrubber)
    'Discord webhook': [`POST https://discord.com/api/webhooks/123456789012345678/${v} 404`, 'POST https://discord.com/api/webhooks/[redacted] 404'],
    'an unnamed 24-character token': [`invalid api key ${randomish(24)}`, 'invalid api key [redacted]'],
  }
  for (const [name, [input, expected]] of Object.entries(cases)) assert.equal(scrubError(input), expected, name)
  // Not secrets: `pass` inside a word, a quoted name that is not a secret's, an XML element that is not.
  assert.equal(scrubError('bypass: true, compass=north'), 'bypass: true, compass=north')
  assert.equal(scrubError('{"error":"invalid grant"}'), '{"error":"invalid grant"}')
  assert.equal(scrubError('{"code": "401"}'), '{"code": "401"}')
  assert.equal(scrubError('<message>Backend Error</message>'), '<message>Backend Error</message>')
})

test('a secret in a URL\'s query or fragment is redacted, and the rest of the URL kept', () => {
  const v = randomish(16)
  assert.equal(scrubError(`https://x.test/?access_token=${v}&page=2`), 'https://x.test/?access_token=[redacted]&page=2')
  assert.equal(scrubError(`GET https://api.x.test/v1?token=${v} failed`), 'GET https://api.x.test/v1?token=[redacted] failed')
  assert.equal(scrubError(`https://app.x.test/cb#access_token=${v}&type=bearer`), 'https://app.x.test/cb#access_token=[redacted]&type=bearer')
  assert.equal(scrubError(`https://x.test/?access_token=${v}&page=2`, { urls: 'origin' }), 'https://x.test/…')
  // A scheme's colon is not a name's separator, even where the URL has no query to scrub.
  assert.equal(scrubError(`see https://x.test/a?page=2&sort=asc, then client_secret=${v}`), 'see https://x.test/a?page=2&sort=asc, then client_secret=[redacted]')
  assert.equal(scrubError('https://x.test/path?code=401&state=ok'), 'https://x.test/path?code=401&state=ok')
})

test('an MCP server keeps only its URL origin: the path is often the credential', () => {
  const secret = randomish(32)
  const out = scrubError(`server "zapier" failed: fetch https://mcp.zapier.example/api/mcp/s/${secret}/mcp -> 401`, { urls: 'origin' })
  assert.equal(out, 'server "zapier" failed: fetch https://mcp.zapier.example/… -> 401')
})

test('what went wrong survives scrubbing', () => {
  const benign = [
    'token refresh for "personal" HTTP 400 — Token has been expired or revoked',
    'could not reach Bushido for Strava: fetch failed',
    'Bushido answered HTTP 503',
    'Gmail "home" GET /messages HTTP 429: Quota exceeded for quota metric',
    'calendar "work" HTTP 401',
    'error_code=500 grant_type=refresh_token status code: 429',
  ]
  for (const message of benign) assert.equal(scrubError(message), message)
  assert.match(scrubError(`GET https://api.example.com/v1/items?access_token=${randomish(30)}&limit=5 HTTP 401`), /limit=5 HTTP 401$/)
  assert.match(scrubError(`body {"refresh_token":"${randomish(30)}","error":"invalid_grant"}`), /invalid_grant/)
})

// The budget is generous for a slow runner; the old scrubber took 25 s on the first
// of these and hundreds of milliseconds on each 8 KB shape.
const fast = (input) => {
  const start = performance.now()
  scrubError(input)
  return performance.now() - start
}
const fill = (unit, length) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length)

test('100,000 characters scrub in under 50 ms', () => {
  scrubError('warm up')
  for (const input of [fill('a', 100_000), `HTTP 400 ${fill(randomish(64), 100_000)}`, fill('<p>Service Unavailable</p>', 1_000_000)]) {
    assert.ok(fast(input) < 50, `${input.length} characters`)
  }
})

test('no pattern backtracks: each worst case at the 8 KB cap scrubs in under 50 ms', () => {
  // Inside the cap the regexes themselves must be linear, or 8 KB of one shape is
  // still a slow main thread. Each of these defeated one pattern before.
  const shapes = ['a', 'a.', 'a-', 'token_', 'key=', '"a":"', '\\"key\\":\\"', '<token>', '-----BEGIN A-----', 'a://', 'bearer ', 'token ', '%41', 'x://a@', 'x://a?', '?b&', 'x://h?a=b&']
  for (const unit of shapes) assert.ok(fast(fill(unit, 8000)) < 50, unit)
})

test('only the first 8 KB is read, cut at a space so no token is left half in', () => {
  // Twenty long tokens shrink to "[redacted]" each, so the output is short enough to
  // show where the cut fell; the GitHub token straddles the 8 KB mark.
  const lead = `${Array.from({ length: 20 }, () => randomish(400)).join(' ')} ${fill('w ', 160)}`
  assert.equal(lead.length, 8180)
  const token = fakeToken(['gh', 'p_'], 36)
  const out = scrubError(`${lead}${token} tail`)
  assert.ok(out.endsWith('w w …'), out.slice(-40))
  assert.ok(!out.includes(token.slice(0, 8)), out.slice(-40))
})

test('scrubbing is bounded and never throws on a hostile error', () => {
  assert.equal(scrubError(new Error('y'.repeat(2000))).length, 500)
  assert.equal(scrubError(null), null)
  const evil = { get message() { throw new Error('getter boom') } }
  assert.equal(scrubError(evil), 'an error that could not be read')
})
