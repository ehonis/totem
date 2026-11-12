// The Dev tab's Issues list, without React: filtering and search, the filter
// menus' options, label colours that stay readable on any palette, initials and
// short times. IssuesCard.tsx draws it; issues.test.ts checks it.
import type { DevIssue } from '../api'

export interface IssueFilters {
  /** owner/name, or '' for every repo. */
  repo: string
  /** A label name, or '' for any. Matched without case, across repos. */
  label: string
  /** Free text: words in the title, repo, labels, author, assignees or milestone; `#12` is issue 12. */
  search: string
}

export const NO_FILTERS: IssueFilters = { repo: '', label: '', search: '' }

export const hasFilters = (f: IssueFilters) => Boolean(f.repo || f.label || f.search.trim())

const lower = (s: string | null | undefined) => String(s ?? '').toLowerCase()

function matchesWord(issue: DevIssue, word: string): boolean {
  const number = /^#(\d+)$/.exec(word)
  if (number) return issue.number === Number(number[1])
  if (/^\d+$/.test(word) && issue.number === Number(word)) return true
  return [
    issue.title, issue.repo, issue.author, issue.milestone,
    ...issue.labels.map((l) => l.name), ...issue.assignees,
  ].some((field) => lower(field).includes(word))
}

/** The issues the filters leave, in the order given (the server's newest-updated first). */
export function filterIssues(issues: DevIssue[], f: IssueFilters): DevIssue[] {
  const words = lower(f.search).split(/\s+/).filter(Boolean)
  const repo = lower(f.repo)
  const label = lower(f.label)
  return issues.filter((i) =>
    (!repo || lower(i.repo) === repo)
    && (!label || i.labels.some((l) => lower(l.name) === label))
    && words.every((w) => matchesWord(i, w)))
}

export interface Option { value: string; count: number; color?: string }

/**
 * The repo menu: every watched repo (even with no issues, so the owner can see
 * it is empty) and every repo an issue is in, busiest first.
 */
export function repoOptions(issues: DevIssue[], watched: string[] = []): Option[] {
  const counts = new Map<string, number>()
  const names = new Map<string, string>()
  for (const r of watched) { names.set(lower(r), r); counts.set(lower(r), 0) }
  for (const i of issues) {
    const k = lower(i.repo)
    if (!names.has(k)) names.set(k, i.repo)
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  return [...counts].map(([k, count]) => ({ value: names.get(k)!, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** The label menu, by name across repos, busiest first, with the first colour seen. */
export function labelOptions(issues: DevIssue[]): Option[] {
  const byName = new Map<string, Option>()
  for (const i of issues) {
    for (const l of i.labels) {
      const k = lower(l.name)
      const seen = byName.get(k)
      if (seen) seen.count++
      else byName.set(k, { value: l.name, count: 1, color: l.color })
    }
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** Short repo names, with the owner kept only where two repos share a name. */
export function repoMarks(repos: string[]): Map<string, string> {
  const owners = new Map<string, Set<string>>()
  for (const r of repos) {
    const name = lower(r.split('/')[1] || r)
    if (!owners.has(name)) owners.set(name, new Set())
    owners.get(name)!.add(lower(r))
  }
  return new Map(repos.map((r) => {
    const name = r.split('/')[1] || r
    return [r, owners.get(lower(name))!.size > 1 ? r : name]
  }))
}

/** Two letters for an avatar: the first of each part of the login, or its first two. */
export function initials(login: string): string {
  const clean = login.replace(/\[bot\]$/i, '')
  const parts = clean.split(/[-_.]+/).filter(Boolean)
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : clean.replace(/[^a-z0-9]/gi, '').slice(0, 2)
  return (letters || '?').toUpperCase()
}

/** A steady hue per login, so the same person keeps the same avatar colour. */
export function loginHue(login: string): number {
  let h = 0
  for (const ch of lower(login)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 360
}

/** "now", "5m", "3h", "4d", then the date ("Mar 4", with the year once it is not this year). */
export function shortAgo(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d <= 30) return `${d}d`
  const date = new Date(t)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Label colours. GitHub hands back any hex; drawn as-is, a navy label vanishes
// on a dark card and a pale yellow one on a light card. Each label gets a tint
// of its colour over the card's surface, and text in its own hue moved toward
// white (dark surface) or black (light surface) until it reads at 4.5:1.

type Rgb = [number, number, number]

export function parseHex(hex: string | null | undefined): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}

const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
export const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as Rgb
const css = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`

export interface LabelLook { color: string; background: string; borderColor: string }

/** Text, fill and border for a label of colour `hex` on a card of colour `surface`; null for no colour. */
export function labelLook(hex: string, surface: string): LabelLook | null {
  const label = parseHex(hex)
  if (!label) return null
  const base = parseHex(surface) || [22, 25, 34]
  const background = mix(base, label, 0.2)
  const toward: Rgb = luminance(base) < 0.25 ? [255, 255, 255] : [0, 0, 0]
  let text = label
  for (let t = 0.05; contrast(text, background) < 4.5 && t <= 1; t += 0.05) text = mix(label, toward, t)
  return { color: css(text), background: css(background), borderColor: css(mix(base, label, 0.5)) }
}

/** The card surface's colour as the stylesheet has it now (palettes change it). */
export function cardSurface(el: Element | null = typeof document === 'undefined' ? null : document.documentElement): string {
  if (!el) return ''
  return getComputedStyle(el).getPropertyValue('--bg-2').trim()
}

/** A one-line summary for the card's head: "12 open · 4 assigned to you". */
export function summary(issues: DevIssue[], state: 'open' | 'closed' | 'all', login: string | null): string {
  const word = state === 'all' ? '' : ` ${state}`
  const n = issues.length
  const parts = [`${n}${word} issue${n === 1 ? '' : 's'}`]
  if (login) {
    const mine = issues.filter((i) => i.assignees.some((a) => lower(a) === lower(login))).length
    if (mine) parts.push(`${mine} assigned to you`)
  }
  return parts.join(' · ')
}

/** "open", "closed" or "closed as not planned", for the row's name and its icon. */
export function stateText(i: Pick<DevIssue, 'state' | 'stateReason'>): string {
  if (i.state === 'open') return 'open'
  return i.stateReason === 'not_planned' ? 'closed as not planned' : i.stateReason === 'duplicate' ? 'closed as duplicate' : 'closed'
}

/** What a screen reader says for a row: where, which, what, and its state. */
export const rowName = (i: DevIssue) => `${i.repo} #${i.number}: ${i.title} (${stateText(i)})`

export const ASSIGNED_SOURCE = 'Assigned to you'

/** "Showing the 1,000 most recently updated closed issues in owner/repo (of 1,240)." */
export function capNote(c: { source: string; shown: number; total: number }, state: 'open' | 'closed' | 'all'): string {
  const kind = state === 'all' ? 'issues' : `${state} issues`
  const where = c.source === ASSIGNED_SOURCE ? `${kind} assigned to you` : `${kind} in ${c.source}`
  const of = c.total > c.shown ? ` (of ${c.total.toLocaleString('en-US')})` : ''
  return `Showing the ${c.shown.toLocaleString('en-US')} most recently updated ${where}${of}.`
}

/** A source as a sentence names it: a repo by name, the assigned search as "issues assigned to you". */
const sourceName = (source: string) => (source === ASSIGNED_SOURCE ? 'issues assigned to you' : source)

/**
 * The warnings over the list, naming each source. A source never read shows
 * nothing of itself ("Couldn't read …"); one that failed after a good read is
 * shown from that read.
 */
export function errorNotes(errors: { source: string; error: string; stale: boolean }[]): { unread: string | null; stale: string | null } {
  const say = (list: typeof errors) => list.length === 1
    ? `${sourceName(list[0].source)}: ${list[0].error}`
    : list.map((e) => `${sourceName(e.source)} (${e.error})`).join('; ')
  const unread = errors.filter((e) => !e.stale)
  const stale = errors.filter((e) => e.stale)
  return {
    unread: unread.length ? `Couldn’t read ${say(unread)}` : null,
    stale: stale.length ? `Showing the last good list of ${say(stale)}` : null,
  }
}

/** A source read in part: GitHub left some issues out (an org that blocks the token). */
export function warningNote(w: { source: string; warning: string }): string {
  const what = w.source === ASSIGNED_SOURCE ? 'issues assigned to you' : `issues in ${w.source}`
  return `Some ${what} could not be read: ${w.warning}`
}

/** shortAgo in words, for a screen reader: "5 minutes ago", "on Mar 4". */
export function spokenAgo(iso: string | null | undefined, now = Date.now()): string {
  const short = shortAgo(iso, now)
  const m = /^(\d+)([mhd])$/.exec(short)
  if (m) {
    const unit = { m: 'minute', h: 'hour', d: 'day' }[m[2] as 'm' | 'h' | 'd']
    return `${m[1]} ${unit}${m[1] === '1' ? '' : 's'} ago`
  }
  return short === 'now' ? 'just now' : short ? `on ${short}` : ''
}

/** What the row shows besides its name, for a screen reader (aria-describedby). */
export function rowDetails(i: DevIssue, me: string | null, now = Date.now()): string {
  const parts: string[] = []
  if (i.labels.length) parts.push(`Labels: ${i.labels.map((l) => l.name).join(', ')}`)
  if (i.assignees.length) {
    const names = i.assignees.map((a) => (me && a.toLowerCase() === me.toLowerCase() ? `${a} (you)` : a))
    parts.push(`Assigned to ${names.join(', ')}`)
  }
  parts.push(`${i.comments} comment${i.comments === 1 ? '' : 's'}`)
  const ago = spokenAgo(i.updatedAt, now)
  if (ago) parts.push(`Updated ${ago}`)
  return `${parts.join('. ')}.`
}
