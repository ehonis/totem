// sources/scrub.mjs — an error message with the secrets taken out.
//
// Connector errors quote what went wrong, and what went wrong is often a URL, a
// header or an echoed body: `…?access_token=…`, `Authorization: Bearer …`,
// `{"refresh_token":"…"}`, a webhook whose path is the secret. The run log keeps
// errors for a month and shows them in Settings, so every message is scrubbed
// before it is stored, not when it is shown.
//
// Layers, each catching what the one before cannot:
//   1. percent-decoding, so `access%5Ftoken%3D…` reads as what it is;
//   2. URLs: userinfo always, and for an MCP server only the origin (its path is
//      often the credential: `/s/<secret>/mcp`);
//   3. auth headers and cookies, scheme and all;
//   4. anything named like a secret, `name=value` or `name: value`, any quoting,
//      env-style (`GITHUB_PERSONAL_ACCESS_TOKEN=`), camelCase (`refreshToken`);
//   5. tokens with a known prefix, and known secret-bearing URL shapes;
//   6. the fallback: any long run that mixes letters and digits, which is what a
//      token with no name and no prefix looks like (a Strava hex token in an
//      unnamed field).

const REDACTED = '[redacted]'
const MAX_ERROR = 500

// Words that make a name a secret's name, anywhere in it.
const SECRET_WORDS = 'token|key|secret|password|passwd|pwd|code|sig|signature|auth|credential|session|cookie|assertion|jwt'
// Names that contain one of those words and are not secrets.
const NOT_SECRET = /^(error_?code|status_?code|exit_?code|response_?code|http_?code|token_?type|grant_?type|key_?id|auth_?type|code_?challenge_?method)$/i

// 4. `name = value`, `name: value`, `"name": "value"`, `\"name\":\"value\"`, `name: 'value'`.
const NAMED = new RegExp(
  String.raw`(\\?["']?)([\w-]*(?:${SECRET_WORDS})[\w-]*)(\\?["']?)(\s*[:=]\s*)(\\?["']?)([^\s"'\\&,;<>{}[\]()]+)`,
  'gi',
)
// 3. `Authorization: Bearer abc`, `"Authorization":"Bearer abc"`, `{ authorization: 'Basic abc' }`.
const AUTH_HEADER = /(\\?["']?)((?:proxy-)?authorization)(\\?["']?)(\s*[:=]\s*)(\\?["']?)(?:(?:bearer|basic|token|digest|bot)\s+)?[^\s"'\\,;}]+/gi
const COOKIE_HEADER = /\b((?:set-)?cookie)(\s*:\s*)[^\n]+/gi
// `Bearer abc`, `Basic abc` in prose; bare "token <value>" only with a token-length value.
const AUTH_SCHEMES = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}|\b(token)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{20,}/gi
// 5. Prefixes providers put on their tokens.
const PREFIXED = /(?:\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|sk-|sk_live_|rk_live_|xox[abprs]-|ya29\.|AIza|eyJ)|(?<![\w/])1\/\/0)[A-Za-z0-9._\-/+]{10,}/g
const SLACK_HOOK = /(hooks\.slack\.com\/services\/)[^\s"'<>]+/gi
const TELEGRAM_BOT = /\bbot\d{5,}:[A-Za-z0-9_-]{20,}/g
// 6. A long run mixing letters and digits.
const LONG_RUN = /[A-Za-z0-9_\-+~]{32,}=*/g
const URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s"'<>]+)/gi

function decodePercents(text) {
  let out = text
  // Twice, for a value that was encoded inside an encoded URL.
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(out); i += 1) {
    out = out.replace(/%([0-9a-f]{2})/gi, (m, hex) => {
      const c = String.fromCharCode(parseInt(hex, 16))
      return c >= ' ' && c <= '~' ? c : m
    })
  }
  return out
}

function scrubUrls(text, originOnly) {
  return text.replace(URL_RE, (_, scheme, rest) => {
    const at = rest.search(/[/?#]/)
    let authority = at < 0 ? rest : rest.slice(0, at)
    const tail = at < 0 ? '' : rest.slice(at)
    const userinfo = authority.lastIndexOf('@')
    if (userinfo >= 0) authority = `${REDACTED}@${authority.slice(userinfo + 1)}`
    if (originOnly) return `${scheme}${authority}${tail ? '/…' : ''}`
    return `${scheme}${authority}${tail}`
  })
}

const looksRandom = (run) => /[0-9]/.test(run) && /[A-Za-z]/.test(run)

function readText(value) {
  if (value == null) return null
  if (typeof value === 'string') return value
  try {
    const message = value?.message
    return String(message || value)
  } catch {
    return 'an error that could not be read'
  }
}

/**
 * The message with its secrets replaced by `[redacted]`, at most 500 characters.
 * `urls: 'origin'` keeps only each URL's scheme and host (for MCP servers).
 */
export function scrubError(value, { urls = 'keep' } = {}) {
  const raw = readText(value)
  if (raw == null) return null
  let text = decodePercents(raw)
  text = scrubUrls(text, urls === 'origin')
  text = text
    .replace(AUTH_HEADER, (_, q1, name, q2, sep, q3) => `${q1}${name}${q2}${sep}${q3}${REDACTED}`)
    .replace(COOKIE_HEADER, (_, name, sep) => `${name}${sep}${REDACTED}`)
    .replace(NAMED, (whole, q1, name, q2, sep, q3, val) => {
      if (NOT_SECRET.test(name) || val === REDACTED || /^\d{1,4}$/.test(val)) return whole
      return `${q1}${name}${q2}${sep}${q3}${REDACTED}`
    })
    .replace(AUTH_SCHEMES, (_, scheme, word) => `${scheme || word} ${REDACTED}`)
    .replace(SLACK_HOOK, `$1${REDACTED}`)
    .replace(TELEGRAM_BOT, `bot${REDACTED}`)
    .replace(PREFIXED, REDACTED)
    .replace(LONG_RUN, (run) => (looksRandom(run) ? REDACTED : run))
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR) || null
}
