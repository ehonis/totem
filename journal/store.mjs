// journal/store.mjs — voice journal entries on disk.
//
// One JSON file per entry under data/journal/entries/, the same shape the thread
// store uses and for the same reason: an entry is written a handful of times over
// its life (recorded → transcribed → ingested) by one person, and a directory of
// small files is trivially inspectable, backed up by any tool, and impossible to
// corrupt as a whole. This is deliberately *not* a table in data/todos.db — adding
// one there bumps the task export's formatVersion and makes every older snapshot
// unrestorable (see AGENTS.md § Gotchas), which a journal has no business doing.
//
// The audio a recording arrives as is NOT an entry field. It lives in
// data/journal/audio/ and is kept for `keepAudioDays` (default 14) so a recording
// can be listened back to or saved off before it goes; the entry itself only
// records where it was, how big it was, and when it stops being kept. The words
// remain the durable record — the audio is a grace period, not an archive.
//
// Writes are serialized behind one mutex and land atomically (tmp + rename), so a
// transcription finishing while he edits the title cannot lose either change.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ENTRY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export const ENTRY_STATUSES = ['transcribing', 'transcribed', 'failed']
export const INGEST_STATES = ['queued', 'running', 'done', 'skipped', 'failed']

// What a fresh install says about names. Product names the repo already knows;
// the people and places in the owner's life belong in data/, not in code, and the
// Journal view has a field for them. JOURNAL_VOCABULARY overrides the default for
// an install that never saved its own list.
export const DEFAULT_VOCABULARY = process.env.JOURNAL_VOCABULARY || 'Totem, Plaud, Strava, WHOOP, Todoist'

export const DEFAULT_SETTINGS = Object.freeze({
  // How long "Don't ingest" stays available after Save, in minutes. The clock
  // starts at save, not at the end of transcription: the window is measured from
  // the moment the recording is let go, however long whisper takes.
  ingestDelayMinutes: 10,
  // Spelling hints handed to whisper as its initial prompt.
  vocabulary: DEFAULT_VOCABULARY,
  // How long a recording survives after it has been transcribed. The transcript is
  // the durable record, but a fortnight is long enough to notice you wanted the
  // audio — to keep a bit of tape, or to hear a passage whisper mangled. 0 deletes
  // the moment the words exist. A pinned entry ignores this entirely.
  keepAudioDays: 14,
  // Which agent digests an entry. Empty means "whatever the Providers tab has as
  // the default", which is what every other scheduled job does — but the digest is
  // the one job where the model choice is worth pinning: it reads twenty minutes of
  // rambling and has to come back with the right five facts, and the default is
  // chosen for chat latency rather than for that. Empty model = the provider's own
  // default; `effort` only means anything to codex and claude.
  provider: '',
  model: '',
  effort: '',
})

export const isEntryId = (id) => typeof id === 'string' && ENTRY_ID_RE.test(id)

/** A new id: sortable by time when listed, unique past that. */
export function newEntryId(now = Date.now()) {
  return `j_${new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 6)}`
}

export function createJournalStore({ dir, log = () => {} }) {
  if (!dir) throw new TypeError('createJournalStore requires dir')
  const entriesDir = join(dir, 'entries')
  const settingsFile = join(dir, 'settings.json')
  let chain = Promise.resolve()

  function withLock(fn) {
    const run = chain.then(fn)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  async function writeAtomic(path, value) {
    await mkdir(join(path, '..'), { recursive: true })
    const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 2))
    await rename(tmp, path)
  }

  const entryFile = (id) => {
    if (!isEntryId(id)) throw new Error('bad journal entry id')
    return join(entriesDir, `${id}.json`)
  }

  async function readEntry(id) {
    try { return JSON.parse(await readFile(entryFile(id), 'utf8')) }
    catch (e) {
      if (e?.code === 'ENOENT') return null
      throw e
    }
  }

  /** Every entry, newest recording first. Unreadable files are logged and skipped. */
  async function list() {
    let names
    try { names = await readdir(entriesDir) }
    catch (e) {
      if (e?.code === 'ENOENT') return []
      throw e
    }
    const out = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try { out.push(JSON.parse(await readFile(join(entriesDir, name), 'utf8'))) }
      catch (e) { log(`journal: skipping unreadable ${name}: ${e?.message || e}`) }
    }
    return out.sort((a, b) => String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')))
  }

  const get = (id) => readEntry(id)

  /** Insert a whole entry. The caller shapes it; the store only makes it durable. */
  function put(entry) {
    if (!isEntryId(entry?.id)) throw new Error('bad journal entry id')
    return withLock(async () => {
      await writeAtomic(entryFile(entry.id), entry)
      return entry
    })
  }

  /**
   * Read-modify-write one entry under the lock. `fn` gets the current entry and
   * returns the next one (or a patch to merge). Returns null when the entry is gone,
   * so a transcription landing after a delete simply has nowhere to go.
   */
  function update(id, fn) {
    return withLock(async () => {
      const current = await readEntry(id)
      if (!current) return null
      const result = typeof fn === 'function' ? await fn(current) : fn
      const next = result && result.id === id ? result : { ...current, ...(result || {}) }
      next.updatedAt = new Date().toISOString()
      await writeAtomic(entryFile(id), next)
      return next
    })
  }

  function remove(id) {
    return withLock(async () => {
      const current = await readEntry(id)
      if (!current) return null
      await rm(entryFile(id), { force: true })
      return current
    })
  }

  async function readSettings() {
    let stored = {}
    try { stored = JSON.parse(await readFile(settingsFile, 'utf8')) || {} }
    catch (e) { if (e?.code !== 'ENOENT') log(`journal: settings unreadable, using defaults: ${e?.message || e}`) }
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...stored })
  }

  function writeSettings(patch) {
    return withLock(async () => {
      const next = normalizeSettings({ ...(await readSettings()), ...(patch || {}) })
      await writeAtomic(settingsFile, next)
      return next
    })
  }

  return { dir, entriesDir, list, get, put, update, remove, readSettings, writeSettings }
}

/** The agent ids a journal setting may name. Anything else falls back to the default. */
export const JOURNAL_PROVIDERS = ['cursor', 'codex', 'claude', 'opencode']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** Clamp what a settings write may say, so a bad PATCH can't disable the grace window. */
export function normalizeSettings(input = {}) {
  const minutes = Number(input.ingestDelayMinutes)
  const provider = String(input.provider ?? '').trim().toLowerCase()
  const effort = String(input.effort ?? '').trim().toLowerCase()
  return {
    ingestDelayMinutes: Number.isFinite(minutes) ? Math.min(24 * 60, Math.max(0, Math.round(minutes))) : DEFAULT_SETTINGS.ingestDelayMinutes,
    vocabulary: String(input.vocabulary ?? DEFAULT_SETTINGS.vocabulary).replace(/\s+/g, ' ').trim().slice(0, 1000),
    keepAudioDays: Number.isFinite(Number(input.keepAudioDays))
      ? Math.min(365, Math.max(0, Math.round(Number(input.keepAudioDays))))
      : DEFAULT_SETTINGS.keepAudioDays,
    // An unknown provider is dropped rather than persisted: a typo here would
    // otherwise fail every future digest at spawn time with "unknown agent provider".
    provider: JOURNAL_PROVIDERS.includes(provider) ? provider : '',
    // The model is deliberately NOT validated against a catalog. Cursor and
    // OpenCode accept ids this process never enumerates, and the catalogs move on
    // their own; `resolveModelChoice` already corrects a stale id at run time for
    // the two providers that can be checked. Length is the only real guard.
    model: String(input.model ?? '').trim().slice(0, 120),
    effort: EFFORTS.includes(effort) ? effort : '',
  }
}
