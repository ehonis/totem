// A memory file named in a prompt instead of pasted into it.
//
// A project's, folder's or totem's memory.md used to be pasted into every chat
// turn, resumed or not, so a resumed session carried one more copy of it per
// turn. Chats now get the file's path and a one-line summary (size, entries,
// last change, section headings) and read it with their file tools when the
// request may depend on it. Totem runs and asks still get their memory inline
// (totems/core.mjs): each is a fresh session that needs its state every time.

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { memoryEntries } from './projects.mjs'

// How much of a memory a run that cannot open the file gets instead (memoryRef).
export const MEMORY_HEAD_CHARS = 4000
const HEADINGS_LISTED = 8

// Minutes, not just the day: a chat that read the file earlier today has to see
// that another chat changed it since.
function stamp(ms, tz) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
  } catch {
    return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  }
}

/** True when `path` is not inside `root` (both resolved). */
export function outsideDir(path, root) {
  const rel = relative(resolve(root), resolve(path))
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * `{ path, bytes, entries, updated, headings }` for a memory file, its path
 * made absolute (a relative *_DIR setting is the bridge's, not the agent's
 * working folder). A missing file is empty. `headChars` > 0 also returns the
 * file's first `headChars` characters as `pasted` (with `cut` when there is more).
 */
export async function memoryFileStats(path, { tz, headChars = 0 } = {}) {
  if (!path) return { path: '', bytes: 0, entries: 0, updated: null, headings: [] }
  const abs = resolve(String(path))
  const empty = { path: abs, bytes: 0, entries: 0, updated: null, headings: [] }
  try {
    const [st, text] = await Promise.all([stat(abs), readFile(abs, 'utf8')])
    const list = memoryEntries(text)
    if (!list.length) return empty
    const headings = [...new Set(list.map((e) => e.heading.replace(/^#+\s*/, '').trim().slice(0, 40)).filter(Boolean))]
    return {
      path: abs, bytes: st.size, entries: list.length, updated: stamp(st.mtimeMs, tz), headings,
      ...(headChars > 0 ? { pasted: text.slice(0, headChars).trimEnd(), cut: text.length > headChars } : {}),
    }
  } catch {
    return empty
  }
}

const size = (bytes) => (bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`)

/** "4.2 KB, 12 entries, last updated 2026-11-03 14:05; sections: Decisions, People", or "empty so far". */
export function memorySummary(stats) {
  if (!stats?.entries) return 'empty so far'
  const hs = stats.headings || []
  const sections = hs.length ? `; sections: ${hs.slice(0, HEADINGS_LISTED).join(', ')}${hs.length > HEADINGS_LISTED ? ` and ${hs.length - HEADINGS_LISTED} more` : ''}` : ''
  return `${size(stats.bytes || 0)}, ${stats.entries} ${stats.entries === 1 ? 'entry' : 'entries'}${stats.updated ? `, last updated ${stats.updated}` : ''}${sections}`
}

/** False when the file was pasted because this run cannot open it. */
export const memoryEditable = (stats) => typeof stats?.pasted !== 'string'

/**
 * The prompt's line for one memory file: `label`, its path and summary, and when
 * to read it (`dependsOn` finishes "when the request may depend on …"). With
 * `pasted` (a backend that cannot open the file), that start is pasted instead,
 * and the caller drops its "keep that file" line (memoryEditable).
 */
export function memoryRef(label, stats, dependsOn) {
  const line = `${label}: ${stats?.path || ''} (${memorySummary(stats)}).`
  if (!stats?.entries) return line
  if (!memoryEditable(stats)) {
    return `${line} This run cannot open or edit files outside its working folder, so ${stats.cut ? `its first ${stats.pasted.length} characters are` : 'it is'} pasted here. If this chat settles something worth keeping, say it in your reply so the owner can add it:\n${stats.pasted}${stats.cut ? '\n…(cut)' : ''}`
  }
  return `${line} It is not pasted here: read it with your file tools before you answer or act when the request may depend on ${dependsOn}, and skip it when it plainly does not. If you read it earlier in this chat and this summary has changed since, read it again: your copy is out of date.`
}
