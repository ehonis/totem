// A source's last error as one plain sentence for its row in Settings →
// Connections. The raw text (already scrubbed by the bridge, sources/) stays
// one click away under "Details"; this is only what shows at a glance.

const RULES: [RegExp, string][] = [
  [/ENOENT|no such file or directory/i, 'A file it needs is missing on the server.'],
  [/EACCES|EPERM|permission denied|operation not permitted/i, 'Totem is not allowed to read a file it needs on the server.'],
  [/invalid_grant|token (has )?(expired|been revoked)|refresh token/i, 'Its sign-in has expired or was revoked. Sign in again.'],
  [/\b401\b|unauthori[sz]ed|forbidden|\b403\b|insufficient.{0,10}(scope|permission)/i, 'It refused Totem’s credentials.'],
  [/\b429\b|rate.?limit|too many requests/i, 'It is rate limiting Totem for now.'],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|getaddrinfo|network (error|is unreachable)|fetch failed/i, 'Totem could not reach it.'],
  [/timed? ?out|ETIMEDOUT|deadline/i, 'It did not answer in time.'],
  [/(HTTP|status) 5\d\d\b|internal server error|bad gateway|service unavailable/i, 'It is having trouble on its side.'],
]

export function plainError(raw: string | null | undefined): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  for (const [pattern, sentence] of RULES) if (pattern.test(text)) return sentence
  // Unknown: its first sentence, without a path or a stack, kept short.
  const first = text.split(/(?<=[.!?])\s|\n/)[0].replace(/(\/[\w.-]+){2,}/g, '…').trim()
  return first.length > 120 ? `${first.slice(0, 117)}…` : first
}
