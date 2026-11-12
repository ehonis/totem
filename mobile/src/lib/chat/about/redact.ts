// Known token shapes, taken out of text before it is logged, shown or handed to an
// agent. One source for three copies: the bridge imports this file, and
// web/src/chat/about/redact.ts and mobile/src/lib/chat/about/redact.ts are
// byte-for-byte copies (web/src/chat/about/places.test.ts checks). It is plain
// JavaScript that is also valid TypeScript, so keep it free of type annotations.
// A pattern only finds a shape it knows: this lowers the odds of a leak, it does
// not rule one out.
//
// Every pattern runs in linear time. Where a name is matched, it starts only at
// the start of a run of name characters (a lookbehind) and its length is bounded,
// so a long run of letters cannot make a pattern retry at every position.
// Command output passes through here, so keep it that way.

// Past this, the rest is dropped rather than passed on unchecked.
export const REDACT_MAX = 200000

// Parameter names whose value is a secret: the last _ or - separated word of the name
// is one of these, so `access_token=`, `api_key=` and `x-amz-signature=` count and
// `monkey=` or `keyboard=` do not.
const PARAM = '(?:[a-z0-9]{1,30}[_-]){0,6}(?:token|secret|password|passwd|pass|pwd|key|apikey|auth|sig|signature|credential)'
// Only in a URL's query or fragment: as prose these are ordinary words.
const URL_PARAM = 'code|session|sessionid|credential'
// Words inside a quoted JSON or YAML key that make its value a secret ("accessToken").
const QUOTED_KEY = 'token|secret|passw(?:or)?d|pwd|apikey|api_key|authorization|cookie|credential|private_?key'
// Words an UPPER_SNAKE environment name ends or starts with (OPENAI_API_KEY).
const ENV_WORD = 'TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|AUTH|COOKIE|SESSION|CREDENTIALS?'

const RULES = [
  // Private keys, whole: to the END line, or to the end of the text when it was cut.
  { re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, to: '[redacted private key]' },
  // user:password@ in a URL
  { re: /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^/\s@"'<>]{1,256}@/gi, to: '$1[redacted]@' },
  { re: /\b(Authorization\s*[:=]\s*["']?(?:Basic|Bearer|Token|Digest)\s+)[^\s"'<>,;]{4,}/gi, to: '$1[redacted]' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: 'Bearer [redacted]' },
  // Basic alone only when what follows looks like base64 (a digit, + or /, a trailing =,
  // or capitals past the first letter), so "Basic training" stays.
  { re: /\b(?:Basic|basic|BASIC)\s+(?=[A-Za-z0-9+/]{12})(?=[A-Za-z]*[0-9+/]|[A-Za-z0-9+/][a-z0-9+/]*[A-Z][a-z0-9+/]*[A-Z]|[A-Za-z0-9+/]{12,}=)[A-Za-z0-9+/]{12,}={0,2}/g, to: 'Basic [redacted]' },
  // JWTs and anything else that is base64url JSON
  { re: /\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*){0,2}/g, to: '[redacted jwt]' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}/g, to: '[redacted github token]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, to: '[redacted github token]' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g, to: '[redacted api key]' },
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, to: '[redacted aws key id]' },
  { re: /\bAIza[A-Za-z0-9_-]{20,}/g, to: '[redacted google key]' },
  { re: /\bya29\.[A-Za-z0-9._-]{20,}/g, to: '[redacted google token]' },
  { re: /\bxox[a-z]-[A-Za-z0-9-]{8,}/gi, to: '[redacted slack token]' },
  { re: /\bxapp-[A-Za-z0-9-]{8,}/gi, to: '[redacted slack token]' },
  // "accessToken": "…", 'api_key': '…', and the same with = instead of :
  { re: new RegExp(`(?<![A-Za-z0-9_-])(["']?)(?=[A-Za-z0-9_-]{0,60}?(?:${QUOTED_KEY}))([A-Za-z0-9_-]{1,64})\\1(\\s{0,8}[:=]\\s{0,8})(["'])[^"'\\n]{0,4096}\\4`, 'gi'), to: '$1$2$1$3$4[redacted]$4' },
  // ?token=…, &api_key=…, password=… (a whole parameter name, before = )
  { re: new RegExp(`(^|[?&#;\\s,("'])(${PARAM})=[^\\s"'\`&#<>]{1,4096}`, 'gi'), to: '$1$2=[redacted]' },
  { re: new RegExp(`([?&#;])(${URL_PARAM})=[^\\s"'\`&#<>]{1,4096}`, 'gi'), to: '$1$2=[redacted]' },
  // NAME_TOKEN=value, OPENAI_API_KEY=value (whole underscore-separated words)
  { re: new RegExp(`(?<![A-Za-z0-9_])((?:[A-Z0-9]{1,30}_){0,6}(?:${ENV_WORD})(?:_[A-Z0-9]{1,30}){0,6})=[^\\s"'\`&#]{1,4096}`, 'g'), to: '$1=[redacted]' },
  // Anything left that is 40+ characters of base64 with at least two capitals, two
  // small letters and two digits: an unlabelled secret. A commit SHA (no capitals),
  // a UUID or a date does not qualify.
  // Each lookahead stays inside the run: its class is the run's minus what it looks for.
  { re: /(?<![A-Za-z0-9+/_-])(?=(?:[a-z0-9+/_-]*[A-Z]){2})(?=(?:[A-Z0-9+/_-]*[a-z]){2})(?=(?:[A-Za-z+/_-]*[0-9]){2})[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g, to: '[redacted secret]' },
]

export function redactTokens(text = '') {
  let out = String(text)
  if (out.length > REDACT_MAX) out = `${out.slice(0, REDACT_MAX)} [… ${out.length - REDACT_MAX} more characters cut before redaction]`
  for (const { re, to } of RULES) out = out.replace(re, to)
  return out
}
