/**
 * A reply's Markdown as the words it reads as, for the "Select text" sheet
 * (features/chat/SelectTextSheet.tsx), so a selection copies words, not `**`,
 * `[text](url)` or table pipes. It reads the reply's whole text, as the menu's
 * Copy does. Code keeps its characters. Pure, so `node --test` runs it.
 *
 * Every pattern runs in linear time on a long line (see the timing tests): spans
 * are bounded, and no two quantifiers can share a run of the same characters.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const ESCAPABLE = '\\`*_{}[]()#+-.!|~>'
// Held code spans and escaped characters wait in the line as \u0002<n>\u0003, so no
// rule below reads them. Those two control characters are dropped from the input.
const HELD = /\u0002(\d+)\u0003/g

/** Emphasis, links and images out of one line whose code and escapes are held. */
function inline(s: string): string {
  const PARENS = '\\((?:[^()\\n]|\\([^()\\n]{0,500}\\)){0,2000}\\)'
  return s
    .replace(new RegExp(`!\\[([^\\]\\n]{0,500})\\]${PARENS}`, 'g'), '$1')
    .replace(new RegExp(`\\[([^\\]\\n]{1,500})\\]${PARENS}`, 'g'), '$1')
    .replace(/<((?:https?|mailto):[^<>\s]{1,2000})>/gi, '$1')
    .replace(/\*\*(?=\S)([^\n]{0,500}?\S)\*\*/g, '$1')
    .replace(/(^|[^\w])__(?=\S)([^\n]{0,500}?\S)__(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([^\n]{0,500}?\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]{0,500}?\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]{0,500}?\S)_(?!\w)/g, '$1$2')
}

/**
 * One line of prose. Escapes and code spans are taken out first, in one pass, so
 * an escaped backtick never opens code and bold or a link around code still
 * closes; inline() then sees the whole line.
 */
function line(s: string): string {
  const held: string[] = []
  const hold = (t: string) => `\u0002${held.push(t) - 1}\u0003`
  const unclosed = new Set<number>() // backtick run lengths with no closing run left
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) { out += hold(s[i + 1]); i += 2; continue }
    if (c !== '`') { out += c; i++; continue }
    let n = 1
    while (s[i + n] === '`') n++
    const close = unclosed.has(n) ? -1 : closingRun(s, i + n, n)
    if (close < 0) { unclosed.add(n); out += s.slice(i, i + n); i += n; continue }
    // One space comes off each end, as CommonMark does, unless the span is all spaces.
    const code = s.slice(i + n, close)
    out += hold(code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code) ? code.slice(1, -1) : code)
    i = close + n
  }
  return inline(out).replace(HELD, (_, k: string) => held[Number(k)])
}

/** Where the next run of exactly n backticks starts, or -1. */
function closingRun(s: string, from: number, n: number): number {
  for (let j = s.indexOf('`', from); j >= 0; j = s.indexOf('`', j)) {
    let m = 1
    while (s[j + m] === '`') m++
    if (m === n) return j
    j += m
  }
  return -1
}

function isTableDelimiter(t: string): boolean {
  if (!t.includes('|') || !t.includes('-')) return false
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').every((c) => /^:?-{3,}:?$/.test(c.trim()))
}

function tableRow(t: string): string {
  return t.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => line(c.trim())).join('\t')
}

/** A heading's text, without its `#`s or a closing run of them. */
function heading(s: string): string {
  let t = s.trimEnd()
  let k = t.length
  while (k > 0 && t[k - 1] === '#') k--
  if (k < t.length && (k === 0 || /\s/.test(t[k - 1]))) t = t.slice(0, k).trimEnd()
  return t
}

export function markdownToPlainText(md: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const raw of String(md ?? '').replace(/[\u0002\u0003]/g, '').replace(/\r\n?/g, '\n').split('\n')) {
    const open = FENCE.exec(raw)
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !raw.trim().slice(open[1].length).trim()) fence = null
      else out.push(raw)
      continue
    }
    if (open) { fence = open[1]; continue }
    const t = raw.trim()
    if (isTableDelimiter(t)) continue
    if (RULE.test(raw)) { out.push(''); continue }
    if (t.length > 1 && t.startsWith('|') && t.endsWith('|')) { out.push(tableRow(t)); continue }
    let s = raw
    const h = /^ {0,3}#{1,6}\s+/.exec(s)
    if (h) s = heading(s.slice(h[0].length))
    s = s.replace(/^ {0,3}(>\s?)+/, '')
    s = s.replace(/^(\s*)[-*+]\s+\[([ xX])\]\s+/, (_, ind, mark) => `${ind}${mark.trim() ? '☑' : '☐'} `)
    s = s.replace(/^(\s*)[-*+]\s+/, '$1• ')
    out.push(line(s))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
