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
//   2. URLs: userinfo and secret-named query or fragment params always, and for an
//      MCP server only the origin (its path is often the credential: `/s/<secret>/mcp`);
//   3. PEM blocks, auth headers and cookies, scheme and all;
//   4. anything named like a secret, `name=value`, `name: value`, a quoted JSON
//      value (spaces and all) or `<name>value</name>`, env-style
//      (`GITHUB_PERSONAL_ACCESS_TOKEN=`), camelCase (`refreshToken`);
//   5. tokens with a known prefix, and known secret-bearing URL shapes;
//   6. the fallback: any run of 24 or more that mixes letters and digits, which is
//      what a token with no name and no prefix looks like (a Strava hex token in
//      an unnamed field).
//
// It runs on the bridge's main thread for every failed run, on text a remote
// server chose (Bushido passes its `body.error` through whole), so it must stay
// linear. The input is cut to 8 KB before anything else, and no pattern below may
// backtrack over a run: a name is captured atomically (`(?=(x+))\1`, which the
// engine cannot give characters back from), a scheme or value is bounded, and a
// name is tested against the secret words after the match, not inside it. A
// `[\w-]*(?:word)[\w-]*` here took 25 s on 100 KB of one letter.

const REDACTED = '[redacted]'
const MAX_ERROR = 500
const MAX_INPUT = 8 * 1024

// Words that make a name a secret's name, anywhere in it, or `pass` as the whole
// name or its last part (`?pass=`, `db_pass:`), so `bypass` and `compass` are left.
const SECRET_NAME = /token|key|secret|password|passwd|pwd|code|sig|signature|auth|credential|session|cookie|assertion|jwt|(?:^|[_-])pass$/i
// Names that contain one of those words and are not secrets.
const NOT_SECRET = /^(error_?code|status_?code|exit_?code|response_?code|http_?code|token_?type|grant_?type|key_?id|auth_?type|code_?challenge_?method)$/i
const isSecretName = (name) => SECRET_NAME.test(name) && !NOT_SECRET.test(name)
// A short number after a secret-looking name is a status, not a secret (`code: 401`).
const isStatus = (value) => /^\d{1,4}$/.test(value)

// 3. A PEM block, header to footer, or to the end when the message was cut off.
const PEM = /-----BEGIN ([A-Z0-9 ]{1,40})-----[^-]*(?:-----END [A-Z0-9 ]{1,40}-----)?/g
// `Authorization: Bearer abc`, `"Authorization":"Bearer abc"`, `{ authorization: 'Basic abc' }`.
const AUTH_HEADER = /(\\?["']?)((?:proxy-)?authorization)(\\?["']?)(\s*[:=]\s*)(\\?["']?)(?:(?:bearer|basic|token|digest|bot)\s+)?[^\s"'\\,;}]+/gi
const COOKIE_HEADER = /\b((?:set-)?cookie)(\s*:\s*)[^\n]+/gi
// 4. `"name": "value with spaces"`, `\"name\":\"value\"`, `'name': 'value'`.
const QUOTED = /(\\?["'])(?=([\w-]+))\2\1(\s*:\s*)(\\?["'])((?:(?!\4)[^\n]){0,400})\4/g
// `name = value`, `name: value`, `"name": value`. The name starts a run (the
// lookbehind) and is taken whole, so a long run is one attempt, not one per letter.
// `https://…` is not a name and a value: taken as one, the URL's query was swallowed
// whole and never looked at again.
const NAMED = /(?<![\w-])(\\?["']?)(?=([\w-]+))\2(\\?["']?)(\s*[:=](?!\/\/)\s*)(\\?["']?)([^\s"'\\&,;<>{}[\]()]+)/g
// `<access_token>value</access_token>`.
const XML_ELEMENT = /<(?=([\w:-]+))\1>([^<]{0,2000})<\/\1>/g
// `Bearer abc`, `Basic abc` in prose; bare "token <value>" only with a token-length value.
const AUTH_SCHEMES = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}|\b(token)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{20,}/gi
// 5. Prefixes providers put on their tokens, AWS access key ids included.
const PREFIXED = /(?:\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|sk-|sk_live_|rk_live_|xox[abprs]-|ya29\.|AIza|eyJ|AKIA|ASIA)|(?<![\w/])1\/\/0)[A-Za-z0-9._\-/+]{10,}/g
const WEBHOOK_PATH = /((?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks)\/)[^\s"'<>]+/gi
const TELEGRAM_BOT = /\bbot\d{5,}:[A-Za-z0-9_-]{20,}/g
// 6. A long run mixing letters and digits.
const LONG_RUN = /[A-Za-z0-9_\-+~]{24,}=*/g
// The scheme is bounded: unbounded, `a.a.a.…` made every word boundary rescan the rest.
const URL_RE = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s"'<>]+)/gi
// One `name=value` in a URL's query or fragment. The name is bounded, so a run with no
// `=` costs at most 100 steps.
const URL_PARAM = /([?&#;])([^=&#;?]{1,100})=([^&#;]*)/g

/** The first 8 KB, cut back to the last whitespace so no token is left half in. */
function cap(text) {
  if (text.length <= MAX_INPUT) return text
  let end = MAX_INPUT
  const floor = MAX_INPUT - 512
  while (end > floor && !/\s/.test(text[end - 1])) end -= 1
  return `${text.slice(0, end > floor ? end : floor)} …`
}

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
    const query = tail.search(/[?#]/)
    if (query < 0) return `${scheme}${authority}${tail}`
    const params = tail.slice(query).replace(URL_PARAM, (whole, sep, name, val) => (
      isSecretName(name) && !isStatus(val) && val ? `${sep}${name}=${REDACTED}` : whole
    ))
    return `${scheme}${authority}${tail.slice(0, query)}${params}`
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
  let text = decodePercents(cap(raw))
  text = scrubUrls(text, urls === 'origin')
  text = text
    .replace(PEM, (_, label) => `-----BEGIN ${label}-----${REDACTED}-----END ${label}-----`)
    .replace(AUTH_HEADER, (_, q1, name, q2, sep, q3) => `${q1}${name}${q2}${sep}${q3}${REDACTED}`)
    .replace(COOKIE_HEADER, (_, name, sep) => `${name}${sep}${REDACTED}`)
    .replace(QUOTED, (whole, q, name, sep, vq, val) => (
      !isSecretName(name) || isStatus(val) || val === REDACTED ? whole : `${q}${name}${q}${sep}${vq}${REDACTED}${vq}`
    ))
    .replace(NAMED, (whole, q1, name, q2, sep, q3, val) => (
      !isSecretName(name) || isStatus(val) || val === REDACTED ? whole : `${q1}${name}${q2}${sep}${q3}${REDACTED}`
    ))
    .replace(XML_ELEMENT, (whole, name) => (isSecretName(name) ? `<${name}>${REDACTED}</${name}>` : whole))
    .replace(AUTH_SCHEMES, (_, scheme, word) => `${scheme || word} ${REDACTED}`)
    .replace(WEBHOOK_PATH, `$1${REDACTED}`)
    .replace(TELEGRAM_BOT, `bot${REDACTED}`)
    .replace(PREFIXED, REDACTED)
    .replace(LONG_RUN, (run) => (looksRandom(run) ? REDACTED : run))
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR) || null
}
