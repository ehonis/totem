// The message-shaped half of Gmail: building an RFC 5322 message to hand Gmail as
// `raw`, and turning Gmail's MIME payload tree back into readable text. Pure
// functions with no I/O, so the tests can pin the exact bytes.

// Header values come from an agent, so CR/LF would let one smuggle in a second
// header (a Bcc nobody asked for). Fold every line break to a space.
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim()

// RFC 2047 encoded-word for a non-ASCII header value (subjects, display names).
// Chunked so no encoded word exceeds 75 characters, split on character
// boundaries so a multi-byte character never straddles two words.
export function encodeHeader(value) {
  const s = oneLine(value)
  if (!/[^\x20-\x7e]/.test(s)) return s
  const words = []
  let chunk = ''
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = '' }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ')
}

const ADDR_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/

// Split a recipients value ("a@x.com, Bo <b@y.com>" or an array of them) into
// { name, email } pairs. Commas inside a quoted display name do not split.
export function parseAddressList(value) {
  const parts = Array.isArray(value) ? value.flatMap((v) => splitAddresses(String(v ?? ''))) : splitAddresses(String(value ?? ''))
  return parts.map(parseAddress).filter(Boolean)
}

function splitAddresses(s) {
  const out = []
  let cur = ''
  let quoted = false
  let angle = false
  for (const ch of s) {
    if (ch === '"') quoted = !quoted
    else if (ch === '<' && !quoted) angle = true
    else if (ch === '>' && !quoted) angle = false
    if ((ch === ',' || ch === ';') && !quoted && !angle) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map((p) => p.trim()).filter(Boolean)
}

export function parseAddress(raw) {
  const s = oneLine(raw)
  if (!s) return null
  const m = s.match(/^(.*?)<\s*([^<>\s]+)\s*>$/)
  const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"') : ''
  const email = (m ? m[2] : s).trim()
  return { name, email }
}

export function validEmail(email) {
  return ADDR_RE.test(String(email || ''))
}

export function formatAddress({ name, email }) {
  if (!name) return email
  const display = /[^\x20-\x7e]/.test(name) ? encodeHeader(name) : `"${name.replace(/["\\]/g, '\\$&')}"`
  return `${display} <${email}>`
}

// Base64 body lines wrapped at 76 characters, as RFC 2045 asks.
const wrap76 = (b64) => b64.replace(/.{76}(?=.)/g, '$&\r\n')

// The whole message, CRLF line endings. Plain text only: an agent's email is
// prose, and HTML would be one more thing that renders differently from what the
// owner approved. Gmail fills in From, Date and Message-ID from the account.
export function buildMessage({ from = null, to = [], cc = [], bcc = [], subject = '', body = '', inReplyTo = null, references = null }) {
  const headers = []
  if (from) headers.push(`From: ${formatAddress(from)}`)
  if (to.length) headers.push(`To: ${to.map(formatAddress).join(', ')}`)
  if (cc.length) headers.push(`Cc: ${cc.map(formatAddress).join(', ')}`)
  if (bcc.length) headers.push(`Bcc: ${bcc.map(formatAddress).join(', ')}`)
  headers.push(`Subject: ${encodeHeader(subject)}`)
  if (inReplyTo) headers.push(`In-Reply-To: ${oneLine(inReplyTo)}`)
  if (references) headers.push(`References: ${oneLine(references)}`)
  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64')
  const text = String(body ?? '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  return `${headers.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(text, 'utf8').toString('base64'))}\r\n`
}

export const toBase64Url = (s) => Buffer.from(s, 'utf8').toString('base64url')

// "Re: " once, however many times the thread has already been replied to.
export function replySubject(subject) {
  const s = oneLine(subject)
  return /^re:/i.test(s) ? s : `Re: ${s}`
}

// ---- Reading -----------------------------------------------------------------

export function headerMap(headers = []) {
  const out = {}
  for (const h of headers) {
    const k = String(h.name || '').toLowerCase()
    if (!(k in out)) out[k] = String(h.value ?? '')
  }
  return out
}

function decodePart(data, charset = 'utf-8') {
  if (!data) return ''
  const bytes = Buffer.from(data, 'base64url')
  try { return new TextDecoder(charset || 'utf-8').decode(bytes) } catch { return bytes.toString('utf8') }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

// Good enough to read a newsletter or a receipt in a terminal: drop scripts and
// styles, turn block ends into line breaks, keep link targets, decode entities.
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const t = text.replace(/<[^>]+>/g, '').trim()
      return !t || t === href || /^mailto:/i.test(href) ? t || href : `${t} (${href})`
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const charsetOf = (part) => {
  const ct = headerMap(part.headers)['content-type'] || ''
  return (ct.match(/charset="?([^";\s]+)"?/i) || [])[1] || 'utf-8'
}

// Walk the payload tree once: the first text/plain and text/html bodies, and
// every part that is a file. Inline images in an HTML mail are attachments too
// (they carry a filename), which is what the owner would see in Gmail.
export function readPayload(payload) {
  let plain = null
  let html = null
  const attachments = []
  const walk = (part) => {
    if (!part) return
    const mime = String(part.mimeType || '').toLowerCase()
    if (part.filename && part.body?.attachmentId) {
      attachments.push({ attachmentId: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType || '', size: part.body.size || 0 })
    } else if (mime === 'text/plain' && plain === null && part.body?.data) {
      plain = decodePart(part.body.data, charsetOf(part))
    } else if (mime === 'text/html' && html === null && part.body?.data) {
      html = decodePart(part.body.data, charsetOf(part))
    }
    for (const child of part.parts || []) walk(child)
  }
  walk(payload)
  const text = plain !== null && plain.trim() ? plain : html !== null ? htmlToText(html) : ''
  return { text: text.replace(/\r\n/g, '\n').trim(), hasHtml: html !== null, attachments }
}
