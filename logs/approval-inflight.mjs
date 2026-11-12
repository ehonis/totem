// Accepted actions that are still being carried out, on disk.
//
// An accepted email, message or command can be cut off by a bridge restart part
// way through. Nobody then knows how far it got: the email may have gone, the
// command may have run half its work. Calling that "failed" invites a retry that
// sends twice; leaving the proposal open does the same more quietly. So each
// accepted action is written here before it starts and cleared when it ends, and
// whatever a new process finds left over from an earlier one ends as `uncertain`:
// check before retrying.

import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export const UNCERTAIN_NOTE = 'the bridge restarted while this was being carried out, so it may or may not have happened; check before retrying'
// The send itself failed, after the request may already have reached Gmail or
// Messages: a lost reply is not a refusal.
export const UNCERTAIN_LOST_NOTE = 'it failed after the request may already have reached its destination, so it may or may not have happened; check before retrying'

export function createInflightLedger({ file, now = () => Date.now(), bootId = randomUUID() }) {
  if (!file) throw new Error('createInflightLedger needs a file')
  let queue = Promise.resolve()

  function withLock(fn) {
    const next = queue.then(fn)
    queue = next.then(() => {}, () => {})
    return next
  }

  async function readAll() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      return Array.isArray(parsed?.entries) ? parsed.entries : []
    } catch {
      return []
    }
  }

  async function writeAll(entries) {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify({ entries }, null, 2) + '\n')
    await rename(tmp, file)
  }

  /**
   * Before the side effect starts. `key` is unique per action (an inbox id, or
   * `<id>:run`). Refused while an earlier process's attempt at the same key is
   * still unsettled: replacing it would lose the only record that it may have run.
   */
  function begin({ key, id, kind, action, title = '', phase = 'accepting' }) {
    return withLock(async () => {
      const entries = await readAll()
      if (entries.some((e) => e.key === key && e.bootId !== bootId)) {
        throw Object.assign(new Error(`${id} was cut off by a restart and is still being settled; check before retrying`), { status: 409 })
      }
      const rest = entries.filter((e) => e.key !== key)
      rest.push({ key, id, kind, action, title: String(title).slice(0, 200), phase, bootId, startedAt: new Date(now()).toISOString() })
      await writeAll(rest)
    })
  }

  /** After it ended, however it ended. Also how a settled leftover is cleared. */
  function end(key) {
    return withLock(async () => {
      const entries = await readAll()
      const rest = entries.filter((e) => e.key !== key)
      if (rest.length !== entries.length) await writeAll(rest)
    })
  }

  /** Everything an earlier process began and never ended. Read only: each is cleared once settled. */
  function leftovers() {
    return withLock(async () => (await readAll()).filter((e) => e.bootId !== bootId))
  }

  return { file, bootId, begin, end, leftovers }
}

/**
 * Settle what an earlier process left: each inbox line is marked `uncertain`
 * first, then the owner is told, and only then is the entry cleared, so a crash
 * part way through settles the rest on the next boot. Run before the port opens
 * (bridge.mjs), so no request can accept the same proposal again first.
 *
 * @param {object} deps
 * @param {ReturnType<typeof createInflightLedger>} deps.ledger
 * @param {(id: string, note: string) => Promise<void>} deps.settleLine  Stamp the inbox line.
 * @param {(entry: object, note: string) => void} deps.record             Write the action log.
 * @param {(entry: object) => Promise<void>} [deps.notify]                Tell the owner.
 * @param {string} deps.today                                             YYYY-MM-DD
 */
export async function settleLeftovers({ ledger, settleLine, record, notify = async () => {}, today }) {
  const settled = []
  for (const entry of await ledger.leftovers()) {
    const note = `uncertain ${today}: ${UNCERTAIN_NOTE}`
    await settleLine(entry.id, note)
    record(entry, note)
    await notify(entry).catch(() => {})
    await ledger.end(entry.key)
    settled.push(entry)
  }
  return settled
}

/**
 * One inbox.md line given its outcome note: an open line (`- [ ] P12 | …`) is
 * resolved with it, a resolved one has it appended. Returns the new text, or null
 * when no line has that id.
 */
export function settleInboxLine(text, id, note) {
  const lines = String(text ?? '').split('\n')
  // The same line shape as bridge.mjs's INBOX_LINE_RE.
  const head = new RegExp(`^(- \\[)([ x])(\\]\\s*${String(id).replace(/[^A-Za-z0-9]/g, '')}\\s*\\|)`)
  const idx = lines.findIndex((line) => head.test(line))
  if (idx === -1) return null
  lines[idx] = `${lines[idx].replace(head, '$1x$3')} | ${note}`
  return lines.join('\n')
}
