// journal/service.mjs — the life of a voice journal entry.
//
//   record on the phone ──▶ save ──▶ transcribing ──▶ transcribed ──▶ (grace) ──▶ ingested
//                                        │                                │
//                                        ▼                                ▼
//                                      failed                          skipped
//
// Three rules, each of them the owner's:
//
//   1. **The audio is temporary, but not instantly.** It is kept for
//      `keepAudioDays` (default 14) after the transcript exists, so a recording can
//      be played back or saved off before it goes, rather than the original
//      delete-on-transcribe. `keepUntil` is stamped on the
//      entry at save time, so changing the setting never retroactively destroys
//      audio that was promised a longer life. Pinning ("Keep audio") opts one entry
//      out for good; "Delete audio" takes it now. A failed transcription always
//      keeps its audio at least 24 h so Retry has something to work with.
//   2. **Save starts a ten-minute clock.** The ingest — the AI folding the entry into
//      the brain, logging habits, staging proposals — waits `ingestDelayMinutes`
//      from save, and "Don't ingest" wins any time before it runs. The clock runs
//      from save, not from the end of transcription, because that is when he lets
//      go of it; if whisper takes longer than the grace period the ingest follows
//      transcription immediately.
//   3. **Ingest writes the words down first.** Before any model sees the entry, the
//      transcript is appended to the brain's journal/YYYY-MM-DD.md page. The
//      digest can fail, be re-run, be edited; the record of what he said is on disk
//      either way. Skipping the ingest skips that too — an entry he chose not to
//      ingest leaves nothing in the brain.
//
// The service knows nothing about HTTP, whisper's flags, or which agent runs the
// skill: `transcriber` and `ingest` are injected, which is what makes the
// lifecycle testable with fakes in a few milliseconds.
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { newEntryId } from './store.mjs'
import { describeIngestResult, ingestFailure, journalBlock, localDate, longDate, parseIngestResult, previousDate } from './text.mjs'

const AUDIO_EXT = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'video/mp4': 'mp4',
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac',
}
// Whatever the retention setting says, a failed transcription keeps its recording
// this long — otherwise Retry is a button that cannot work.
const FAILED_AUDIO_FLOOR_MS = 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const MAX_TITLE = 120
const MAX_TRANSCRIPT = 200_000

export class JournalError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'JournalError'
    this.code = code
    this.status = status
  }
}

const audioExtension = (mime) => AUDIO_EXT[String(mime || '').toLowerCase().split(';')[0].trim()] || 'bin'

export function createJournalService({
  store,
  transcriber,
  audioDir,
  brainDir,
  ingest,
  notify = async () => {},
  actionLog = { record: () => {} },
  log = () => {},
  now = () => Date.now(),
  timeZone = 'America/New_York',
  // Deferred scheduling hook so a test can run ticks by hand instead of on timers.
  schedule = (fn) => setTimeout(fn, 0),
} = {}) {
  if (!store || !transcriber || !audioDir || !brainDir || !ingest) {
    throw new TypeError('createJournalService requires store, transcriber, audioDir, brainDir and ingest')
  }

  let transcribeChain = Promise.resolve()
  let ingestRunning = false
  let lastPurgeAt = 0

  const iso = (t = now()) => new Date(t).toISOString()
  const audioPath = (entry) => (entry?.audio?.file ? join(audioDir, entry.audio.file) : null)

  // ---- shape --------------------------------------------------------------

  async function newEntry({ recordedAt, source, durationSec = null }) {
    const settings = await store.readSettings()
    const at = now()
    const recorded = recordedAt && Number.isFinite(Date.parse(recordedAt)) ? new Date(recordedAt).toISOString() : iso(at)
    return {
      id: newEntryId(at),
      createdAt: iso(at),
      updatedAt: iso(at),
      recordedAt: recorded,
      // The local day the entry belongs to. Morning entries talk about yesterday,
      // but the page they land on is the day they were spoken; the skill is told both.
      date: localDate(recorded, timeZone),
      durationSec: Number.isFinite(Number(durationSec)) && Number(durationSec) > 0 ? Math.round(Number(durationSec)) : null,
      source,
      title: null,
      audio: null,
      transcript: null,
      status: 'transcribing',
      error: null,
      ingest: {
        state: 'queued',
        at: iso(at + settings.ingestDelayMinutes * 60_000),
        startedAt: null,
        completedAt: null,
        error: null,
        result: null,
        journalFile: null,
      },
    }
  }

  // ---- create -------------------------------------------------------------

  /** A recording from the phone. Written to disk, then transcribed in the background. */
  async function createFromAudio({ buffer, mime, recordedAt, durationSec }) {
    if (!buffer?.length) throw new JournalError('EMPTY_AUDIO', 'The recording is empty.')
    const entry = await newEntry({ recordedAt, source: 'voice', durationSec })
    const file = `${entry.id}.${audioExtension(mime)}`
    await mkdir(audioDir, { recursive: true })
    await writeFile(join(audioDir, file), buffer)
    const settings = await store.readSettings()
    entry.audio = {
      file,
      mime: String(mime || 'application/octet-stream').split(';')[0].trim(),
      bytes: buffer.length,
      deletedAt: null,
      // Stamped now, from the setting in force now. A later change to the setting
      // moves the deadline for later recordings, never for this one.
      keepUntil: settings.keepAudioDays > 0 ? iso(now() + settings.keepAudioDays * DAY_MS) : null,
      pinned: false,
    }
    await store.put(entry)
    actionLog.record({
      action: 'journal.record', actor: 'ethan', channel: 'journal', target: entry.id, status: 'ok',
      summary: `saved a ${entry.durationSec ? `${entry.durationSec}s ` : ''}voice journal entry (${buffer.length} bytes, ${entry.audio.mime})`,
      detail: { source: 'voice', bytes: buffer.length, mime: entry.audio.mime, ingestAt: entry.ingest.at }, correlationId: entry.id,
    })
    queueTranscription(entry.id)
    return entry
  }

  /** A typed entry — no mic, no whisper. Goes straight to the grace period. */
  async function createFromText({ text, recordedAt }) {
    const clean = String(text ?? '').trim()
    if (!clean) throw new JournalError('EMPTY_TEXT', 'Write something first.')
    if (clean.length > MAX_TRANSCRIPT) throw new JournalError('TEXT_TOO_LONG', `An entry is at most ${MAX_TRANSCRIPT} characters.`)
    const entry = await newEntry({ recordedAt, source: 'text' })
    entry.status = 'transcribed'
    entry.transcript = { text: clean, segments: [], language: null, model: null, ms: 0, completedAt: entry.createdAt }
    await store.put(entry)
    actionLog.record({
      action: 'journal.record', actor: 'ethan', channel: 'journal', target: entry.id, status: 'ok',
      summary: `saved a typed journal entry (${clean.length} chars)`,
      detail: { source: 'text', chars: clean.length, ingestAt: entry.ingest.at }, correlationId: entry.id,
    })
    scheduleTick()
    return entry
  }

  // ---- transcription --------------------------------------------------------

  function queueTranscription(id) {
    transcribeChain = transcribeChain.then(() => runTranscription(id)).catch((e) => log(`journal ${id}: transcription chain error`, e?.message || e))
    return transcribeChain
  }

  async function runTranscription(id) {
    const entry = await store.get(id)
    if (!entry || entry.status !== 'transcribing') return
    const file = audioPath(entry)
    if (!file) {
      await store.update(id, { status: 'failed', error: 'no audio to transcribe' })
      return
    }
    const startedAt = now()
    try {
      const settings = await store.readSettings()
      const result = await transcriber.transcribe({ audioFile: file, prompt: settings.vocabulary })
      const next = await store.update(id, (current) => ({
        ...current,
        status: 'transcribed',
        error: null,
        durationSec: result.durationSec ? Math.round(result.durationSec) : current.durationSec,
        transcript: {
          text: result.text,
          segments: result.segments || [],
          language: result.language || null,
          model: result.model || null,
          ms: result.ms || (now() - startedAt),
          completedAt: iso(),
        },
      }))
      // The recording is NOT deleted here any more. The words are safe, but the
      // audio is kept until `keepUntil` (or for good, if pinned) so it can still be
      // played back or saved off — see purgeStaleAudio, which is the only thing
      // that removes it on a clock.
      void file
      actionLog.record({
        action: 'journal.transcribe', actor: 'whisper', channel: 'journal', target: id, status: 'ok',
        summary: `transcribed ${result.durationSec}s in ${result.ms}ms (${result.model || 'whisper'})`,
        detail: { durationSec: result.durationSec, chars: result.text.length, segments: result.segments?.length || 0, model: result.model }, startedAt, correlationId: id,
      })
      if (!next) return // deleted while transcribing; the audio is gone with it
      scheduleTick()
    } catch (e) {
      const message = e?.message || String(e)
      log(`journal ${id}: transcription failed: ${message}`)
      await store.update(id, { status: 'failed', error: message })
      actionLog.record({
        action: 'journal.transcribe', actor: 'whisper', channel: 'journal', target: id, status: 'error',
        summary: 'transcription failed', error: message, startedAt, correlationId: id,
      })
      await notify({
        level: 'error', category: 'journal.failed',
        title: 'Journal entry could not be transcribed',
        body: `${message}. The recording is kept for a retry from the Journal tab.`,
        url: '/productivity/journal',
        tag: `journal:${id}`,
      }).catch(() => {})
    }
  }

  /** Entries left mid-transcription by a restart: pick them up, or say why not. */
  async function recover() {
    let queued = 0
    for (const entry of await store.list()) {
      if (entry.status !== 'transcribing') continue
      const file = audioPath(entry)
      const present = file ? await stat(file).then(() => true, () => false) : false
      if (present) { queueTranscription(entry.id); queued += 1 }
      else await store.update(entry.id, { status: 'failed', error: 'the bridge restarted before transcription finished and the audio is gone' })
    }
    if (queued) log(`journal: resumed ${queued} transcription(s) after restart`)
    scheduleTick()
    return queued
  }

  // ---- the grace period and the ingest ---------------------------------------

  function scheduleTick() { schedule(() => tick().catch((e) => log('journal tick error', e?.message || e))) }

  /**
   * Run whatever is due: at most one ingest per call (they are agent runs, and two
   * at once would compete for the same brain repo), then a cheap audio purge.
   * Called from the bridge's job tick and after any state change that could make
   * something due.
   */
  async function tick() {
    if (!ingestRunning) {
      const due = (await store.list())
        .filter((e) => e.status === 'transcribed' && e.ingest?.state === 'queued' && Date.parse(e.ingest.at) <= now())
        .sort((a, b) => String(a.ingest.at).localeCompare(String(b.ingest.at)))
      if (due.length) {
        ingestRunning = true
        try { await ingestEntry(due[0].id) }
        finally { ingestRunning = false }
        // More than one due (a backlog after downtime): come back for the next
        // without waiting for the job tick.
        if (due.length > 1) scheduleTick()
      }
    }
    if (now() - lastPurgeAt > 60 * 60_000) {
      lastPurgeAt = now()
      await purgeStaleAudio().catch((e) => log('journal audio purge error', e?.message || e))
    }
  }

  async function ingestEntry(id) {
    const entry = await store.get(id)
    if (!entry || entry.status !== 'transcribed' || entry.ingest?.state !== 'queued') return null
    const startedAt = now()
    await store.update(id, (c) => ({ ...c, ingest: { ...c.ingest, state: 'running', startedAt: iso(startedAt), error: null } }))
    let journalFile = null
    try {
      journalFile = await appendToBrain(entry)
      const reply = await ingest({
        entry,
        transcript: entry.transcript.text,
        recordedAt: entry.recordedAt,
        entryDate: entry.date,
        entryDateLong: longDate(entry.date),
        previousDate: previousDate(entry.date),
        previousDateLong: longDate(previousDate(entry.date)),
        journalFile,
        durationMin: entry.durationSec ? Math.max(1, Math.round(entry.durationSec / 60)) : null,
      })
      // An agent that was killed or said nothing is a failed digest, not a quiet
      // one. Raising here puts the entry in `failed` with a Retry button and a
      // push, instead of a green card that filed nothing — which is exactly what
      // a 3-minute timeout on a 20-minute entry produced before this existed.
      const nonAnswer = ingestFailure(reply)
      if (nonAnswer) throw new Error(nonAnswer)
      const result = parseIngestResult(reply)
      const next = await store.update(id, (c) => ({
        ...c,
        title: c.title || result.title || null,
        ingest: {
          ...c.ingest, state: 'done', completedAt: iso(), error: null, journalFile,
          result: { ...result, reply: String(reply || '').slice(0, 20_000) },
        },
      }))
      actionLog.record({
        action: 'journal.ingest', actor: 'agent', channel: 'journal', target: id, status: 'ok',
        summary: `ingested journal entry: ${describeIngestResult(result)}`,
        detail: { journalFile, memory: result.memory, proposals: result.proposals, habits: result.habits, goals: result.goals, parsed: result.parsed },
        startedAt, correlationId: id,
      })
      await notify({
        level: 'info', category: 'journal.ingested',
        title: result.title ? `Journal: ${result.title}` : 'Journal digested',
        body: describeIngestResult(result),
        url: result.proposals.length ? '/inbox' : '/productivity/journal',
        tag: `journal:${id}`,
      }).catch(() => {})
      return next
    } catch (e) {
      const message = e?.message || String(e)
      log(`journal ${id}: ingest failed: ${message}`)
      await store.update(id, (c) => ({ ...c, ingest: { ...c.ingest, state: 'failed', completedAt: iso(), error: message, journalFile } }))
      actionLog.record({
        action: 'journal.ingest', actor: 'agent', channel: 'journal', target: id, status: 'error',
        summary: 'journal ingest failed', error: message, startedAt, correlationId: id,
      })
      await notify({
        level: 'error', category: 'journal.failed',
        title: 'Journal entry could not be digested',
        body: `${message}. The transcript is safe; retry from the Journal tab.`,
        url: '/productivity/journal',
        tag: `journal:${id}`,
      }).catch(() => {})
      return null
    }
  }

  /** Append the transcript to brain/journal/YYYY-MM-DD.md; returns the relative path. */
  async function appendToBrain(entry) {
    const rel = `journal/${entry.date}.md`
    const full = join(brainDir, rel)
    await mkdir(join(brainDir, 'journal'), { recursive: true })
    let existing = ''
    try { existing = await readFile(full, 'utf8') } catch (e) { if (e?.code !== 'ENOENT') throw e }
    const block = journalBlock({
      recordedAt: entry.recordedAt, timeZone, source: entry.source, durationSec: entry.durationSec,
      text: entry.transcript.text, segments: entry.transcript.segments, title: entry.title,
    })
    const head = existing ? '' : `# Journal — ${longDate(entry.date)}\n\nSpoken (or typed) entries from Totem's voice journal, verbatim. The digest of each — what went into events/, profile/, people/ and the inbox — is the agent's job; this page is the record.\n\n`
    const marker = `<!-- totem-journal:${entry.id} -->`
    // Back-compat: pages written before the 2026-10-02 rename carry `vesper-journal:`.
    // Can go once data/brain/journal has no old markers left.
    const legacyMarker = `<!-- vesper-journal:${entry.id} -->`
    if (existing.includes(marker) || existing.includes(legacyMarker)) return rel // a re-ingest never writes the words twice
    const sep = existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : ''
    await writeFile(full, `${existing}${sep}${head}${marker}\n${block}\n`)
    return rel
  }

  /**
   * Remove recordings whose keep-window has run out, plus any orphan on disk.
   *
   * The rules, in order: a file no entry owns goes (a crash mid-save, a deleted
   * entry); a pinned entry never goes; a failed transcription survives at least
   * `FAILED_AUDIO_FLOOR_MS` whatever else is true, so Retry keeps working; after
   * that `keepUntil` decides, and a missing `keepUntil` means "not kept" and goes
   * on the next sweep. Runs hourly off the journal tick.
   */
  async function purgeStaleAudio() {
    let names
    try { names = await readdir(audioDir) } catch (e) { if (e?.code === 'ENOENT') return 0; throw e }
    if (!names.length) return 0
    const entries = await store.list()
    const byFile = new Map(entries.filter((e) => e.audio?.file).map((e) => [e.audio.file, e]))
    let removed = 0
    for (const name of names) {
      const full = join(audioDir, name)
      const owner = byFile.get(name)
      if (!owner) {
        await rm(full, { force: true }).catch(() => {})
        removed += 1
        continue
      }
      if (owner.audio?.pinned) continue
      let age = 0
      try { age = now() - (await stat(full)).mtimeMs } catch { continue }
      if (owner.status === 'failed' && age < FAILED_AUDIO_FLOOR_MS) continue
      const keepUntil = owner.audio?.keepUntil ? Date.parse(owner.audio.keepUntil) : 0
      if (keepUntil && keepUntil > now()) continue
      await rm(full, { force: true }).catch(() => {})
      removed += 1
      await store.update(owner.id, (c) => ({ ...c, audio: c.audio ? { ...c.audio, deletedAt: iso() } : null }))
    }
    if (removed) log(`journal: purged ${removed} expired recording(s)`)
    return removed
  }

  /** Delete one entry's recording now, on purpose. The transcript is untouched. */
  async function deleteAudio(id) {
    const entry = await require(id)
    if (!entry.audio || entry.audio.deletedAt) throw new JournalError('NO_AUDIO', 'That recording is already gone.', 409)
    const file = audioPath(entry)
    if (file) await rm(file, { force: true }).catch(() => {})
    const next = await store.update(id, (c) => ({ ...c, audio: c.audio ? { ...c.audio, deletedAt: iso(), pinned: false } : null }))
    actionLog.record({
      action: 'journal.delete_audio', actor: 'ethan', channel: 'journal', target: id, status: 'ok',
      summary: 'deleted the recording for a journal entry (transcript kept)', correlationId: id,
    })
    return next
  }

  /** Pin a recording so no sweep can take it, or let it back onto the clock. */
  async function setAudioPinned(id, pinned) {
    const entry = await require(id)
    if (!entry.audio || entry.audio.deletedAt) throw new JournalError('NO_AUDIO', 'That recording is already gone.', 409)
    const keep = Boolean(pinned)
    // Unpinning restarts the clock rather than letting the next sweep take it,
    // which would make "stop keeping" a surprise delete button.
    const days = Math.max(1, (await store.readSettings()).keepAudioDays)
    const next = await store.update(id, (c) => ({
      ...c,
      audio: c.audio ? {
        ...c.audio,
        pinned: keep,
        ...(keep ? {} : { keepUntil: iso(now() + days * DAY_MS) }),
      } : null,
    }))
    actionLog.record({
      action: 'journal.pin_audio', actor: 'ethan', channel: 'journal', target: id, status: 'ok',
      summary: keep ? 'kept this recording indefinitely' : 'let this recording expire again', correlationId: id,
    })
    return next
  }

  /** The bytes, for playing back or downloading. Throws when it is gone. */
  async function readAudio(id) {
    const entry = await require(id)
    const file = audioPath(entry)
    if (!file || entry.audio?.deletedAt) throw new JournalError('NO_AUDIO', 'That recording has been deleted.', 410)
    let buffer
    try { buffer = await readFile(file) }
    catch { throw new JournalError('NO_AUDIO', 'That recording is no longer on disk.', 410) }
    return { buffer, mime: entry.audio.mime || 'application/octet-stream', filename: `${entry.date}-${entry.id}.${entry.audio.file.split('.').pop()}` }
  }

  // ---- decisions ------------------------------------------------------------

  async function require(id) {
    const entry = await store.get(id)
    if (!entry) throw new JournalError('NOT_FOUND', 'That journal entry no longer exists.', 404)
    return entry
  }

  /** "Don't ingest." Wins any time before the ingest has started. */
  async function skipIngest(id) {
    const entry = await require(id)
    if (entry.ingest.state === 'running') throw new JournalError('INGEST_RUNNING', 'The digest is already running; it can be undone by hand from the brain, not cancelled.', 409)
    if (entry.ingest.state === 'done') throw new JournalError('ALREADY_INGESTED', 'This entry has already been digested.', 409)
    const next = await store.update(id, (c) => ({ ...c, ingest: { ...c.ingest, state: 'skipped', completedAt: iso(), error: null } }))
    actionLog.record({ action: 'journal.skip', actor: 'ethan', channel: 'journal', target: id, status: 'ok', summary: 'chose not to ingest this journal entry', correlationId: id })
    return next
  }

  /** Skip the rest of the countdown — or run again after a skip, failure, or earlier ingest. */
  async function ingestNow(id) {
    const entry = await require(id)
    if (entry.ingest.state === 'running') throw new JournalError('INGEST_RUNNING', 'The digest is already running.', 409)
    if (entry.status === 'failed') throw new JournalError('NOT_TRANSCRIBED', 'Transcription failed; retry it first.', 409)
    const next = await store.update(id, (c) => ({ ...c, ingest: { ...c.ingest, state: 'queued', at: iso(), error: null } }))
    actionLog.record({
      action: 'journal.ingest_now', actor: 'ethan', channel: 'journal', target: id, status: 'ok',
      summary: entry.ingest.state === 'done' ? 'asked for this journal entry to be digested again' : 'asked for this journal entry to be digested now', correlationId: id,
    })
    scheduleTick()
    return next
  }

  /** Try whisper again on a kept recording. */
  async function retryTranscription(id) {
    const entry = await require(id)
    if (entry.status !== 'failed') throw new JournalError('NOT_FAILED', 'Only a failed transcription can be retried.', 409)
    const file = audioPath(entry)
    const present = file ? await stat(file).then(() => true, () => false) : false
    if (!present) throw new JournalError('AUDIO_GONE', 'The recording is no longer on disk (recordings are kept for a day after a failure). Record it again.', 410)
    const next = await store.update(id, { status: 'transcribing', error: null })
    queueTranscription(id)
    return next
  }

  /** Title and transcript are his to correct; nothing else is editable. */
  async function update(id, patch = {}) {
    await require(id)
    return store.update(id, (c) => {
      const next = { ...c }
      if (patch.title !== undefined) {
        const t = String(patch.title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
        next.title = t || null
      }
      if (patch.transcript !== undefined) {
        const text = String(patch.transcript ?? '').trim()
        if (!text) throw new JournalError('EMPTY_TEXT', 'A transcript cannot be emptied; delete the entry instead.')
        if (text.length > MAX_TRANSCRIPT) throw new JournalError('TEXT_TOO_LONG', `An entry is at most ${MAX_TRANSCRIPT} characters.`)
        if (c.status !== 'transcribed') throw new JournalError('NOT_TRANSCRIBED', 'Wait for the transcript before editing it.', 409)
        // An edited transcript loses its timestamps: the segments no longer line up.
        next.transcript = { ...c.transcript, text, segments: [], editedAt: iso() }
      }
      return next
    })
  }

  async function remove(id) {
    const entry = await require(id)
    const file = audioPath(entry)
    if (file) await rm(file, { force: true }).catch(() => {})
    await store.remove(id)
    actionLog.record({ action: 'journal.delete', actor: 'ethan', channel: 'journal', target: id, status: 'ok', summary: `deleted journal entry${entry.title ? ` "${entry.title}"` : ''}`, correlationId: id })
    return { ok: true, id }
  }

  // ---- reads --------------------------------------------------------------

  async function list() {
    return (await store.list()).map(publicEntry)
  }

  async function get(id) {
    return publicEntry(await require(id))
  }

  async function status() {
    const engine = await transcriber.status()
    const entries = await store.list()
    return {
      engine,
      counts: {
        total: entries.length,
        transcribing: entries.filter((e) => e.status === 'transcribing').length,
        waiting: entries.filter((e) => e.status === 'transcribed' && e.ingest.state === 'queued').length,
        failed: entries.filter((e) => e.status === 'failed' || e.ingest.state === 'failed').length,
      },
      settings: await store.readSettings(),
      timeZone,
    }
  }

  const getSettings = () => store.readSettings()
  const setSettings = (patch) => store.writeSettings(patch)

  return {
    createFromAudio, createFromText,
    list, get, status, getSettings, setSettings,
    skipIngest, ingestNow, retryTranscription, update, remove,
    deleteAudio, setAudioPinned, readAudio,
    tick, recover, purgeStaleAudio,
    // exposed for tests
    _runTranscription: runTranscription, _ingestEntry: ingestEntry,
  }
}

/** The entry as the dashboard sees it: no server paths, the audio reduced to facts. */
export function publicEntry(entry) {
  if (!entry) return null
  const { audio, ...rest } = entry
  return {
    ...rest,
    audio: audio ? {
      mime: audio.mime,
      bytes: audio.bytes,
      kept: !audio.deletedAt,
      pinned: Boolean(audio.pinned),
      keepUntil: audio.pinned ? null : (audio.keepUntil || null),
      deletedAt: audio.deletedAt || null,
    } : null,
  }
}
