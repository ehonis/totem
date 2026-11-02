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

test('scrubbing is bounded and never throws on a hostile error', () => {
  assert.equal(scrubError(new Error('y'.repeat(2000))).length, 500)
  assert.equal(scrubError(null), null)
  const evil = { get message() { throw new Error('getter boom') } }
  assert.equal(scrubError(evil), 'an error that could not be read')
})
