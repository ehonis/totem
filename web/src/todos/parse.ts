// Quick-add hints for the task composer: "Call the bank tomorrow p2" becomes the
// title "Call the bank", due tomorrow, priority P2. One copy for the web and the
// iPhone app: web/src/todos/parse.ts is mirrored byte for byte to
// mobile/src/lib/todos/ (mobile/src/features/todos/shared.test.mjs checks it). Pure,
// with no React, React Native or DOM, so vitest and node's test runner both load it.
// It only fills fields the composer already sends (dueDate, priority, folderId);
// what the bridge receives does not change shape.
//
// Recognised, case-insensitive, as whole words:
//   today, tonight · tomorrow, tmrw, tmr · next week (the coming Monday, as the
//   board's "Next week") · in 3 days, in 2 weeks, in a week · on fri, this friday,
//   next monday, and a weekday as the last word · nov 5, 5 november
//   p1-p4 · #folder, when it names one of the owner's chat projects or folders:
//   its name ("#Gizmo Labs", "#r+d"), its name run together ("#worknorthwind"), its
//   path ("#Work - Northwind / r+d") or a word of a project's name ("#northwind").
//   A word that fits several folders is left as text.
// A date may carry "due", "by" or "on" in front, which leaves the title with it.

export type Priority = 1 | 2 | 3 | 4
export type HintKind = 'due' | 'priority' | 'folder'

export interface Hint {
  kind: HintKind
  /** The words as typed, e.g. "by tomorrow". Lower-cased, it is the key a dismissal is stored under. */
  text: string
  start: number
  end: number
  dueDate?: string
  priority?: Priority
  folderId?: string
}

export interface QuickAdd {
  /** The title with the recognised words taken out. */
  title: string
  hints: Hint[]
  dueDate: string | null
  priority: Priority | null
  folderId: string | null
}

/** A chat project or folder a task can be filed under; `parentId` makes it a folder inside that project. */
export interface FolderName { id: string; name: string; parentId?: string | null }

export interface ParseOptions {
  now: Date
  folders?: readonly FolderName[]
  /** Hints the owner dismissed ("keep it as text"), by `hintKey`. */
  ignore?: readonly string[]
  /** The kinds to look for. A field the owner set with its chip is left out, so its word stays in the title. */
  kinds?: readonly HintKind[]
}

export const hintKey = (hint: Pick<Hint, 'text'>) => hint.text.trim().toLowerCase().replace(/\s+/g, ' ')

const pad = (n: number) => String(n).padStart(2, '0')
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
function plusDays(now: Date, days: number) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  d.setDate(d.getDate() + days)
  return d
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
}
const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
}
const WEEKDAY = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|')
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')
// Whole words only: no letter or digit may touch either end.
const B = '(?<![\\p{L}\\p{N}])'
const E = '(?![\\p{L}\\p{N}])'
const LEAD = '(?:(?:due|by|on)\\s+)?'

/** The weekday `day` that is `min`..`min + 6` days after today. */
function nextWeekday(now: Date, day: number, min: 0 | 1) {
  const ahead = (day - now.getDay() + 7) % 7
  return plusDays(now, ahead < min ? ahead + 7 : ahead)
}

/** A month and day, this year unless that day has already gone. Null for a day the month lacks. */
function monthDay(now: Date, month: number, day: number) {
  for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
    const d = new Date(year, month, day)
    if (d.getMonth() !== month) return null
    if (key(d) >= key(now)) return d
  }
  return null
}

interface Rule { pattern: RegExp; due: (m: RegExpExecArray, now: Date, lastWord: boolean) => Date | null }

const DATE_RULES: Rule[] = [
  { pattern: new RegExp(`${B}${LEAD}(?:today|tonight)${E}`, 'giu'), due: (_m, now) => plusDays(now, 0) },
  { pattern: new RegExp(`${B}${LEAD}(?:tomorrow|tmrw|tmr)${E}`, 'giu'), due: (_m, now) => plusDays(now, 1) },
  // The board's "Next week": the coming Monday, never today.
  { pattern: new RegExp(`${B}${LEAD}next\\s+week${E}`, 'giu'), due: (_m, now) => nextWeekday(now, 1, 1) },
  {
    pattern: new RegExp(`${B}${LEAD}in\\s+(a|\\d{1,3})\\s+(days?|weeks?)${E}`, 'giu'),
    due: (m, now) => {
      const n = m[1].toLowerCase() === 'a' ? 1 : Number(m[1])
      return plusDays(now, /^week/i.test(m[2]) ? n * 7 : n)
    },
  },
  // "this fri" may be today; "on fri" and "next fri" are the coming one, one to seven days out.
  {
    pattern: new RegExp(`${B}(?:due\\s+|by\\s+)?(on|this|next)\\s+(${WEEKDAY})${E}`, 'giu'),
    due: (m, now) => nextWeekday(now, WEEKDAYS[m[2].toLowerCase()], m[1].toLowerCase() === 'this' ? 0 : 1),
  },
  // A bare weekday counts only at the end ("Monday standup notes" stays a title), though
  // a priority or tag may follow it: "Renew registration fri p1".
  {
    pattern: new RegExp(`${B}${LEAD}(${WEEKDAY})${E}`, 'giu'),
    due: (m, now, lastWord) => (lastWord ? nextWeekday(now, WEEKDAYS[m[1].toLowerCase()], 1) : null),
  },
  {
    pattern: new RegExp(`${B}${LEAD}(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?${E}`, 'giu'),
    due: (m, now) => monthDay(now, MONTHS[m[1].toLowerCase()], Number(m[2])),
  },
  {
    pattern: new RegExp(`${B}${LEAD}(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})${E}`, 'giu'),
    due: (m, now) => monthDay(now, MONTHS[m[2].toLowerCase()], Number(m[1])),
  },
]

const PRIORITY = new RegExp(`${B}p([1-4])${E}`, 'giu')

/** Lower case, letters and digits only, as todos/folders.mjs compares names. */
const squash = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '')

interface Alias { text: string; id: string; rank: number }

/** What each folder answers to after a #, best (lowest rank) first. */
function folderAliases(folders: readonly FolderName[]): Alias[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const out: Alias[] = []
  for (const f of folders) {
    const parent = f.parentId ? byId.get(f.parentId) : undefined
    if (parent) out.push({ text: `${parent.name} / ${f.name}`, id: f.id, rank: 0 })
    out.push({ text: f.name, id: f.id, rank: parent ? 2 : 1 })
    if (!parent) {
      for (const word of f.name.split(/[^\p{L}\p{N}+]+/u)) if (squash(word).length >= 3) out.push({ text: word, id: f.id, rank: 3 })
    }
  }
  return out
}

/** The folder a squashed word names: the best rank that fits exactly one folder. */
function folderFor(word: string, aliases: readonly Alias[]): string | null {
  const want = squash(word)
  if (!want) return null
  for (const rank of [0, 1, 2, 3]) {
    const ids = new Set(aliases.filter((a) => a.rank === rank && squash(a.text) === want).map((a) => a.id))
    if (ids.size === 1) return [...ids][0]
    if (ids.size > 1) return null
  }
  return null
}

function folderHints(input: string, folders: readonly FolderName[]): Hint[] {
  const aliases = folderAliases(folders)
  // Names with spaces, longest first, so "#Work - Northwind" beats "#Work".
  const spaced = aliases.filter((a) => /\s/u.test(a.text)).sort((a, b) => b.text.length - a.text.length)
  const found: Hint[] = []
  for (let at = input.indexOf('#'); at >= 0; at = input.indexOf('#', at + 1)) {
    if (at > 0 && /[\p{L}\p{N}]/u.test(input[at - 1])) continue
    const rest = input.slice(at + 1)
    // A name ends at a space or the end: "#r+d-ish" is not "#r+d".
    const long = spaced.find((a) => rest.toLowerCase().startsWith(a.text.toLowerCase()) && endsTag(rest[a.text.length]))
    const word = long ? rest.slice(0, long.text.length) : (/^\S+/u.exec(rest)?.[0] ?? '')
    const id = long ? folderFor(long.text, aliases) : folderFor(word, aliases)
    if (id) found.push({ kind: 'folder', text: input.slice(at, at + 1 + word.length), start: at, end: at + 1 + word.length, folderId: id })
  }
  return found
}

/** Whether a #tag may end before this character: only a space or the end of the text. */
const endsTag = (next: string | undefined) => next === undefined || /\s/u.test(next)

const PRIORITY_TRAILER = /^p[1-4](?![\p{L}\p{N}])/iu

/** Whether only priorities and #tags follow a date that has to come last. A known folder name may hold spaces. */
function onlyTrailers(tail: string, folders: readonly FolderName[]) {
  const names = folderAliases(folders).map((a) => a.text).filter((t) => /\s/u.test(t)).sort((a, b) => b.length - a.length)
  let rest = tail.trimStart()
  while (rest) {
    const lower = rest.toLowerCase()
    const word = PRIORITY_TRAILER.exec(rest)?.[0]
      ?? (rest.startsWith('#')
        ? names.map((name) => `#${name}`).find((tag) => lower.startsWith(tag.toLowerCase()) && endsTag(rest[tag.length]))
          ?? /^#\S+/u.exec(rest)?.[0]
        : undefined)
    if (!word) return false
    rest = rest.slice(word.length).trimStart()
  }
  return true
}

function candidates(input: string, now: Date, folders: readonly FolderName[]): Hint[] {
  const found: Hint[] = []
  for (const rule of DATE_RULES) {
    rule.pattern.lastIndex = 0
    for (let m = rule.pattern.exec(input); m; m = rule.pattern.exec(input)) {
      const end = m.index + m[0].length
      const due = rule.due(m, now, onlyTrailers(input.slice(end), folders))
      if (due) found.push({ kind: 'due', text: m[0], start: m.index, end, dueDate: key(due) })
    }
  }
  PRIORITY.lastIndex = 0
  for (let m = PRIORITY.exec(input); m; m = PRIORITY.exec(input)) {
    found.push({ kind: 'priority', text: m[0], start: m.index, end: m.index + m[0].length, priority: (5 - Number(m[1])) as Priority })
  }
  return [...found, ...folderHints(input, folders)]
}

export function parseQuickAdd(input: string, { now, folders = [], ignore = [], kinds }: ParseOptions): QuickAdd {
  const none: QuickAdd = { title: input.trim(), hints: [], dueDate: null, priority: null, folderId: null }
  const ignored = new Set(ignore)
  // Earliest first; at one position the longest ("by tomorrow" over "tomorrow").
  const sorted = candidates(input, now, folders)
    .filter((hint) => !ignored.has(hintKey(hint)) && (!kinds || kinds.includes(hint.kind)))
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const hints: Hint[] = []
  for (const hint of sorted) {
    if (hints.some((kept) => kept.kind === hint.kind || (hint.start < kept.end && kept.start < hint.end))) continue
    hints.push(hint)
  }
  if (!hints.length) return none
  let title = ''
  let at = 0
  for (const hint of [...hints].sort((a, b) => a.start - b.start)) {
    title += `${input.slice(at, hint.start)} `
    at = hint.end
  }
  title = `${title}${input.slice(at)}`.replace(/\s+/g, ' ').trim()
  // A task called "Tomorrow" is a task called "Tomorrow".
  if (!title) return none
  return {
    title,
    hints,
    dueDate: hints.find((hint) => hint.kind === 'due')?.dueDate ?? null,
    priority: hints.find((hint) => hint.kind === 'priority')?.priority ?? null,
    folderId: hints.find((hint) => hint.kind === 'folder')?.folderId ?? null,
  }
}
