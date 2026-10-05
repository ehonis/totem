// logs/store.mjs — the audit trail: every action Totem takes, as one line.
//
// Why this exists, and why it is separate from assistant-usage.jsonl:
//
//   assistant-usage.jsonl answers "how much is Totem being used, by channel" —
//   it is a counter feeding the Usage graphs, and it deliberately keeps almost
//   nothing about each event (a channel, a duration, an 80-char preview).
//
//   This file answers a different question: "what actually happened, and did it
//   work?" It is the record you read when a command ChatGPT proposed ran at 2am
//   and you want to know what it did. So it keeps the specifics — the target, the
//   arguments' shape, the exit code, the error string — and it is written for
//   every mutation, not just agent turns.
//
// The two line up through `channel`: an action-log entry carries the same channel
// vocabulary the usage log uses, so a spike in the Usage graph can be expanded
// into the individual actions behind it.
//
// Append-only JSONL. One line per action, written after the fact with the outcome
// already known, so a half-written action is never mistaken for a successful one.

import { readFile, writeFile, appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Terminal states an action can land in. `pending` is never written to disk. */
export const ACTION_STATUSES = ['ok', 'error', 'denied', 'skipped']

/**
 * Who asked for this. Kept small and closed so the log stays groupable — a free
 * string here would become forty spellings of "chatgpt" within a week.
 */
export const ACTORS = ['ethan', 'chatgpt', 'claude', 'cursor', 'agent', 'job', 'system', 'unknown']

const MAX_BYTES = 8 * 1024 * 1024   // ~8MB, then trim to the newest half
const KEEP_LINES = 8000
const MAX_DETAIL = 4000             // per-field cap, so one huge blob can't dominate

/** Normalise an actor to the closed set, mapping the names clients actually send. */
export function normalizeActor(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return 'unknown'
  if (ACTORS.includes(s)) return s
  if (/chatgpt|openai|gpt/.test(s)) return 'chatgpt'
  if (/claude/.test(s)) return 'claude'
  if (/cursor/.test(s)) return 'cursor'
  if (/codex|opencode/.test(s)) return 'agent'
  if (/web|dashboard|shortcut|ios/.test(s)) return 'ethan'
  return 'unknown'
}

const clip = (v, max = MAX_DETAIL) => {
  if (v == null) return null
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more chars]` : s
}

/**
 * Redact anything that looks like a credential before it reaches disk. The log is
 * meant to be readable — by the owner and by a cloud model through totem_read_logs —
 * so a token that lands here is a token that leaves the box.
 */
export function redactText(input) {
  let s = String(input ?? '')
  s = s.replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9-]{8,})/g, '[redacted]')
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]')
  // key=value / "key": "value" for anything that names itself a secret.
  s = s.replace(/((?:token|secret|password|passwd|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)([^\s"',}&]{6,})/gi, '$1[redacted]')
  return s
}

export function createActionLog({ file, log = () => {}, now = Date.now } = {}) {
  if (!file) throw new Error('createActionLog needs a file')
  let dirReady = false
  // Serialise appends: concurrent fire-and-forget records must not interleave
  // half-lines into the JSONL.
  let chain = Promise.resolve()

  async function ensureDir() {
    if (dirReady) return
    await mkdir(dirname(file), { recursive: true })
    dirReady = true
  }

  /**
   * Record one completed action.
   *
   * Every field is optional except `action`, because a caller that cannot say
   * what it did should still leave a trace rather than skipping the log.
   *
   * @param {object} entry
   * @param {string} entry.action    dotted verb, e.g. 'task.create', 'inbox.accept', 'command.run'
   * @param {string} [entry.actor]   who asked — see ACTORS
   * @param {string} [entry.channel] the usage-log channel this belongs to, so the two line up
   * @param {string} [entry.target]  what it acted on, e.g. a task id or inbox P-id
   * @param {string} [entry.status]  ok | error | denied | skipped. Default 'ok'
   * @param {string} [entry.summary] one line a human reads first: what happened
   * @param {string} [entry.why]     why it happened — for AI-initiated actions this is required by the caller
   * @param {*}      [entry.detail]  the specifics: arguments, exit code, counts
   * @param {string} [entry.error]   the failure message when status is 'error'
   * @param {number} [entry.startedAt] to compute ms
   * @param {string} [entry.correlationId] ties a chain together (proposal → approval → run → output)
   */
  function record(entry = {}) {
    const action = String(entry.action || '').trim()
    if (!action) {
      log('action log: refusing an entry with no action')
      return null
    }
    const id = entry.id || randomUUID()
    const ts = entry.ts || now()
    const row = {
      id,
      ts,
      iso: new Date(ts).toISOString(),
      action,
      actor: normalizeActor(entry.actor),
      status: ACTION_STATUSES.includes(entry.status) ? entry.status : 'ok',
    }
    if (entry.channel) row.channel = String(entry.channel)
    if (entry.target) row.target = clip(redactText(entry.target), 200)
    if (entry.summary) row.summary = clip(redactText(entry.summary), 600)
    if (entry.why) row.why = clip(redactText(entry.why), 800)
    if (entry.detail !== undefined && entry.detail !== null) row.detail = clip(redactText(entry.detail))
    if (entry.error) row.error = clip(redactText(entry.error), 1200)
    if (entry.provider) row.provider = String(entry.provider)
    if (entry.correlationId) row.correlationId = String(entry.correlationId)
    if (Number.isFinite(entry.startedAt)) row.ms = Math.max(0, ts - entry.startedAt)
    else if (Number.isFinite(entry.ms)) row.ms = Math.max(0, Math.round(entry.ms))

    // Fire-and-forget by design: logging must never delay or break the action it
    // is describing. A write failure is reported to the app log and dropped.
    chain = chain.then(async () => {
      try {
        await ensureDir()
        await appendFile(file, `${JSON.stringify(row)}\n`)
        await trim()
      } catch (e) {
        log(`action log write failed: ${e?.message || e}`)
      }
    })
    return row
  }

  /** Keep the newest KEEP_LINES once the file passes MAX_BYTES. Housekeeping only. */
  async function trim() {
    try {
      const s = await stat(file)
      if (s.size <= MAX_BYTES) return
      const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
      const tmp = `${file}.${randomUUID()}.tmp`
      await writeFile(tmp, `${lines.slice(-KEEP_LINES).join('\n')}\n`)
      await rename(tmp, file)
      log(`action log trimmed to the newest ${KEEP_LINES} entries`)
    } catch { /* never fatal */ }
  }

  /**
   * Newest first. Every filter is optional and they AND together.
   *
   * `action` matches a prefix, so 'inbox' finds inbox.stage, inbox.accept and
   * inbox.deny — which is how you actually want to read this file.
   */
  async function read({ limit = 100, action = null, actor = null, status = null, since = null, correlationId = null, target = null } = {}) {
    let raw = ''
    try { raw = await readFile(file, 'utf8') } catch { return { entries: [], total: 0 } }
    const sinceTs = since ? (Number.isFinite(Number(since)) ? Number(since) : Date.parse(since)) : null
    const out = []
    const lines = raw.split('\n')
    let total = 0
    // Walk backwards: newest first, and stop as soon as the page is full.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (action && !String(row.action || '').startsWith(action)) continue
      if (actor && row.actor !== actor) continue
      if (status && row.status !== status) continue
      if (correlationId && row.correlationId !== correlationId) continue
      if (target && row.target !== target) continue
      if (sinceTs && !(row.ts >= sinceTs)) continue
      total++
      if (out.length < limit) out.push(row)
    }
    return { entries: out, total }
  }

  /**
   * Counts for the page header and for a model asking "did anything fail today".
   * Deliberately computed over a window rather than the whole file.
   */
  async function summary({ since = Date.now() - 24 * 60 * 60 * 1000 } = {}) {
    const { entries } = await read({ limit: Number.MAX_SAFE_INTEGER, since })
    const byStatus = {}
    const byAction = {}
    const byActor = {}
    for (const e of entries) {
      byStatus[e.status] = (byStatus[e.status] || 0) + 1
      const top = String(e.action).split('.')[0]
      byAction[top] = (byAction[top] || 0) + 1
      byActor[e.actor] = (byActor[e.actor] || 0) + 1
    }
    return { since: new Date(since).toISOString(), count: entries.length, byStatus, byAction, byActor }
  }

  return { file, record, read, summary }
}
