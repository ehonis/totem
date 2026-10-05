import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJournalStore } from './store.mjs'
import { createJournalService } from './service.mjs'

const T0 = Date.parse('2026-09-16T11:00:00.000Z') // 07:00 EDT

async function harness({ transcribe, ingest, delayMinutes } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'journal-svc-'))
  const store = createJournalStore({ dir: join(root, 'journal') })
  if (delayMinutes !== undefined) await store.writeSettings({ ingestDelayMinutes: delayMinutes })
  let clock = T0
  const notes = []
  const records = []
  const ingestCalls = []
  const pending = []
  const service = createJournalService({
    store,
    transcriber: {
      status: async () => ({ ready: true, missing: [] }),
      transcribe: transcribe || (async () => ({ text: 'Went to the gym. Then work.', segments: [{ start: 0, end: 3, text: 'Went to the gym.' }, { start: 3, end: 5, text: 'Then work.' }], language: 'en', model: 'small', durationSec: 5, ms: 40 })),
    },
    audioDir: join(root, 'audio'),
    brainDir: join(root, 'brain'),
    ingest: ingest || (async (ctx) => { ingestCalls.push(ctx); return 'Filed it.\nJOURNAL_RESULT: {"title":"Gym day","summary":"Legs.","memory":["events/2026-09.md"],"habits":["gym"],"proposals":["P9"]}' }),
    notify: async (n) => { notes.push(n) },
    actionLog: { record: (r) => records.push(r) },
    now: () => clock,
    // Deferred work is collected so a test decides when it runs.
    schedule: (fn) => pending.push(fn),
  })
  const flush = async () => { while (pending.length) await pending.shift()() }
  return { root, store, service, notes, records, ingestCalls, flush, tick: (ms) => { clock += ms }, at: () => clock }
}

test('a recording is saved, transcribed, and its audio deleted the moment the words exist', async () => {
  const h = await harness()
  const entry = await h.service.createFromAudio({ buffer: Buffer.from('fake-audio'), mime: 'audio/mp4', recordedAt: new Date(T0).toISOString(), durationSec: 5.4 })
  assert.equal(entry.status, 'transcribing')
  assert.equal(entry.source, 'voice')
  assert.equal(entry.date, '2026-09-16')
  assert.equal(entry.ingest.state, 'queued')
  assert.equal(entry.ingest.at, new Date(T0 + 10 * 60_000).toISOString())
  assert.deepEqual(await readdir(join(h.root, 'audio')), [`${entry.id}.m4a`])

  await h.service._runTranscription(entry.id)
  const after = await h.store.get(entry.id)
  assert.equal(after.status, 'transcribed')
  assert.equal(after.transcript.text, 'Went to the gym. Then work.')
  assert.equal(after.durationSec, 5)
  // The recording is KEPT now — for keepAudioDays, so it can still be played back.
  assert.equal(after.audio.deletedAt, null)
  assert.equal(after.audio.keepUntil, new Date(T0 + 14 * 86_400_000).toISOString())
  assert.deepEqual(await readdir(join(h.root, 'audio')), [`${entry.id}.m4a`])
  // The dashboard never sees a server path.
  const pub = await h.service.get(entry.id)
  assert.equal(pub.audio.kept, true)
  assert.equal(pub.audio.bytes, 10)
  assert.equal(pub.audio.file, undefined)
})

test('a recording is kept for the retention window, then swept', async () => {
  const h = await harness()
  const entry = await h.service.createFromAudio({ buffer: Buffer.from('x'), mime: 'audio/mp4' })
  await h.service._runTranscription(entry.id)

  // Inside the window: nothing is taken.
  h.tick(13 * 86_400_000)
  assert.equal(await h.service.purgeStaleAudio(), 0)
  assert.deepEqual(await readdir(join(h.root, 'audio')), [`${entry.id}.m4a`])

  // Past it: gone, and the entry says so.
  h.tick(2 * 86_400_000)
  assert.equal(await h.service.purgeStaleAudio(), 1)
  assert.deepEqual(await readdir(join(h.root, 'audio')), [])
  assert.ok((await h.store.get(entry.id)).audio.deletedAt)
})

test('keeping a recording pins it past every sweep, and unkeeping restarts the clock', async () => {
  const h = await harness()
  const entry = await h.service.createFromAudio({ buffer: Buffer.from('x'), mime: 'audio/mp4' })
  await h.service._runTranscription(entry.id)
  await h.service.setAudioPinned(entry.id, true)

  h.tick(400 * 86_400_000)
  assert.equal(await h.service.purgeStaleAudio(), 0)
  assert.deepEqual(await readdir(join(h.root, 'audio')), [`${entry.id}.m4a`])
  // A pinned entry reports no deadline rather than one long past.
  assert.equal((await h.service.get(entry.id)).audio.keepUntil, null)
  assert.equal((await h.service.get(entry.id)).audio.pinned, true)

  // Unkeeping must not be a surprise delete: it starts a fresh window.
  await h.service.setAudioPinned(entry.id, false)
  assert.equal(await h.service.purgeStaleAudio(), 0)
  assert.deepEqual(await readdir(join(h.root, 'audio')), [`${entry.id}.m4a`])
})

test('deleting a recording by hand leaves the transcript alone', async () => {
  const h = await harness()
  const entry = await h.service.createFromAudio({ buffer: Buffer.from('x'), mime: 'audio/mp4' })
  await h.service._runTranscription(entry.id)
  assert.equal((await h.service.readAudio(entry.id)).buffer.toString(), 'x')

  await h.service.deleteAudio(entry.id)
  assert.deepEqual(await readdir(join(h.root, 'audio')), [])
  const after = await h.store.get(entry.id)
  assert.ok(after.audio.deletedAt)
  assert.equal(after.transcript.text, 'Went to the gym. Then work.')
  await assert.rejects(h.service.readAudio(entry.id), /deleted/)
  await assert.rejects(h.service.deleteAudio(entry.id), /already gone/)
})

test('keepAudioDays 0 restores the delete-as-soon-as-transcribed behaviour', async () => {
  const h = await harness()
  await h.store.writeSettings({ keepAudioDays: 0 })
  const entry = await h.service.createFromAudio({ buffer: Buffer.from('x'), mime: 'audio/mp4' })
  assert.equal((await h.store.get(entry.id)).audio.keepUntil, null)
  await h.service._runTranscription(entry.id)
  assert.equal(await h.service.purgeStaleAudio(), 1)
  assert.deepEqual(await readdir(join(h.root, 'audio')), [])
})

test('the grace period is honoured: nothing ingests before the deadline, then it does', async () => {
  const h = await harness()
  const entry = await h.service.createFromText({ text: 'Rode 22 miles with Nolan.', recordedAt: new Date(T0).toISOString() })
  assert.equal(entry.status, 'transcribed')
  await h.service.tick()
  assert.equal(h.ingestCalls.length, 0)
  assert.equal((await h.store.get(entry.id)).ingest.state, 'queued')

  h.tick(10 * 60_000)
  await h.service.tick()
  assert.equal(h.ingestCalls.length, 1)
  const ctx = h.ingestCalls[0]
  assert.equal(ctx.transcript, 'Rode 22 miles with Nolan.')
  assert.equal(ctx.entryDate, '2026-09-16')
  assert.equal(ctx.previousDate, '2026-09-15')
  assert.equal(ctx.journalFile, 'journal/2026-09-16.md')

  const done = await h.store.get(entry.id)
  assert.equal(done.ingest.state, 'done')
  assert.equal(done.title, 'Gym day')
  assert.deepEqual(done.ingest.result.proposals, ['P9'])
  assert.equal(h.notes.length, 1)
  assert.equal(h.notes[0].category, 'journal.ingested')
  assert.equal(h.notes[0].url, '/inbox')
  assert.match(h.notes[0].body, /1 memory update · 1 proposal in the inbox · 1 habit logged/)

  // The words went into the brain before the agent ran, under a dated page.
  const page = await readFile(join(h.root, 'brain', 'journal', '2026-09-16.md'), 'utf8')
  assert.match(page, /^# Journal — Wednesday, September 16, 2026/)
  assert.match(page, /## 07:00 EDT · typed\n\nRode 22 miles with Nolan\./)
})

test('"don\'t ingest" wins inside the window, and leaves nothing in the brain', async () => {
  const h = await harness()
  const entry = await h.service.createFromText({ text: 'Private thoughts.' })
  await h.service.skipIngest(entry.id)
  h.tick(60 * 60_000)
  await h.service.tick()
  assert.equal(h.ingestCalls.length, 0)
  assert.equal((await h.store.get(entry.id)).ingest.state, 'skipped')
  await assert.rejects(readdir(join(h.root, 'brain', 'journal')), /ENOENT/)
  // Skipping twice is a no-op error, not a crash; a done entry can't be un-ingested.
  await h.service.skipIngest(entry.id)
})

test('"ingest now" skips the countdown, and can run a skipped entry after all', async () => {
  const h = await harness()
  const entry = await h.service.createFromText({ text: 'Actually do keep this.' })
  await h.service.skipIngest(entry.id)
  await h.service.ingestNow(entry.id)
  await h.flush()
  assert.equal(h.ingestCalls.length, 1)
  assert.equal((await h.store.get(entry.id)).ingest.state, 'done')
  // Re-ingesting never writes the transcript to the page twice.
  await h.service.ingestNow(entry.id)
  await h.flush()
  const page = await readFile(join(h.root, 'brain', 'journal', '2026-09-16.md'), 'utf8')
  assert.equal(page.match(/Actually do keep this\./g).length, 1)
  assert.equal(h.ingestCalls.length, 2)
})

test('a slow transcription past the deadline ingests as soon as the words land', async () => {
  const h = await harness({ delayMinutes: 1 })
  const entry = await h.service.createFromAudio({ buffer: Buffer.from('x'), mime: 'audio/webm' })
  h.tick(5 * 60_000)
  await h.service.tick() // still transcribing: nothing to ingest
  assert.equal(h.ingestCalls.length, 0)
  await h.service._runTranscription(entry.id)
  await h.flush()
  assert.equal(h.ingestCalls.length, 1)
})

test('a failed transcription keeps the audio, notifies, and can be retried', async () => {
  let fail = true
  const h = await harness({
    transcribe: async () => {
      if (fail) throw new Error('whisper exploded')
      return { text: 'Second time lucky.', segments: [], durationSec: 3, ms: 10 }
    },
  })
  const entry = await h.service.createFromAudio({ buffer: Buffer.from('x'), mime: 'audio/mp4' })
  await h.service._runTranscription(entry.id)
  const failed = await h.store.get(entry.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /exploded/)
  assert.deepEqual(await readdir(join(h.root, 'audio')), [`${entry.id}.m4a`])
  assert.equal(h.notes[0].category, 'journal.failed')

  await assert.rejects(h.service.ingestNow(entry.id), /retry it first/)
  fail = false
  await h.service.retryTranscription(entry.id)
  await new Promise((r) => setTimeout(r, 20)) // the queued transcription runs on its own chain
  assert.equal((await h.store.get(entry.id)).status, 'transcribed')
})

test('a failed ingest is recorded, notified, and re-runnable', async () => {
  let fail = true
  const h = await harness({ ingest: async () => { if (fail) throw new Error('agent quota'); return 'ok' } })
  const entry = await h.service.createFromText({ text: 'Hello.' })
  h.tick(11 * 60_000)
  await h.service.tick()
  const e1 = await h.store.get(entry.id)
  assert.equal(e1.ingest.state, 'failed')
  assert.match(e1.ingest.error, /quota/)
  assert.equal(h.notes.at(-1).category, 'journal.failed')
  fail = false
  await h.service.ingestNow(entry.id)
  await h.flush()
  const e2 = await h.store.get(entry.id)
  assert.equal(e2.ingest.state, 'done')
  assert.equal(e2.ingest.result.parsed, false) // no marker in "ok" — still a record
})

test('a timed-out agent run fails the entry instead of filing an empty digest', async () => {
  // Cursor answers a SIGKILLed run with prose, not an error. Before the guard this
  // produced a green "Digested" card that had filed absolutely nothing.
  const h = await harness({ ingest: async () => 'Agent timed out after 180 seconds. Try a narrower request.' })
  const entry = await h.service.createFromText({ text: 'A very long day.' })
  h.tick(11 * 60_000)
  await h.service.tick()
  const after = await h.store.get(entry.id)
  assert.equal(after.ingest.state, 'failed')
  assert.match(after.ingest.error, /ran out of time after 180s/)
  assert.equal(after.ingest.result, null)
  assert.equal(h.notes.at(-1).category, 'journal.failed')
  // The words still went to the brain first, so a retry has nothing to recover.
  const page = await readFile(join(h.root, 'brain', 'journal', '2026-09-16.md'), 'utf8')
  assert.match(page, /A very long day\./)
})

test('editing keeps title and transcript his, and nothing else', async () => {
  const h = await harness()
  const entry = await h.service.createFromText({ text: 'Original words.' })
  const edited = await h.service.update(entry.id, { title: '  A   title  ', transcript: 'Corrected words.', status: 'hacked' })
  assert.equal(edited.title, 'A title')
  assert.equal(edited.transcript.text, 'Corrected words.')
  assert.equal(edited.status, 'transcribed')
  await assert.rejects(h.service.update(entry.id, { transcript: '' }), /cannot be emptied/)
})

test('delete removes the entry and any recording still on disk', async () => {
  const h = await harness()
  const entry = await h.service.createFromAudio({ buffer: Buffer.from('x'), mime: 'audio/mp4' })
  await h.service.remove(entry.id)
  assert.equal(await h.store.get(entry.id), null)
  assert.deepEqual(await readdir(join(h.root, 'audio')), [])
  await assert.rejects(h.service.get(entry.id), /no longer exists/)
})

test('recover after a restart re-queues transcriptions whose audio survived', async () => {
  const h = await harness()
  // Two entries frozen mid-transcription by a restart, written straight to the
  // store so the service never saw them: one still has its recording, one lost it.
  const frozen = (id, file) => ({
    id, recordedAt: new Date(T0).toISOString(), date: '2026-09-16', source: 'voice', status: 'transcribing',
    audio: { file, mime: 'audio/mp4', bytes: 1, deletedAt: null },
    ingest: { state: 'queued', at: new Date(T0).toISOString() }, transcript: null, title: null,
  })
  await h.store.put(frozen('j_kept', 'j_kept.m4a'))
  await h.store.put(frozen('j_lost', 'gone.m4a'))
  await mkdir(join(h.root, 'audio'), { recursive: true })
  await writeFile(join(h.root, 'audio', 'j_kept.m4a'), 'x')
  const queued = await h.service.recover()
  assert.equal(queued, 1)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal((await h.store.get('j_kept')).status, 'transcribed')
  assert.equal((await h.store.get('j_lost')).status, 'failed')
})

test('the purge takes orphans at once and failed recordings only after a day', async () => {
  const h = await harness({ transcribe: async () => { throw new Error('nope') } })
  await h.store.writeSettings({ keepAudioDays: 0 }) // even with retention off…
  const failed = await h.service.createFromAudio({ buffer: Buffer.from('x'), mime: 'audio/mp4' })
  await h.service._runTranscription(failed.id)
  await writeFile(join(h.root, 'audio', 'orphan.m4a'), 'zz')
  // …a failed transcription keeps its audio, or Retry is a button that cannot work.
  assert.equal(await h.service.purgeStaleAudio(), 1)
  assert.deepEqual(await readdir(join(h.root, 'audio')), [`${failed.id}.m4a`])
  // The clock is fake but mtimes are real: age the file to the fake "yesterday".
  await utimes(join(h.root, 'audio', `${failed.id}.m4a`), new Date(T0), new Date(T0))
  h.tick(25 * 60 * 60_000)
  assert.equal(await h.service.purgeStaleAudio(), 1)
  assert.deepEqual(await readdir(join(h.root, 'audio')), [])
  assert.ok((await h.store.get(failed.id)).audio.deletedAt)
})

test('status reports the engine and the queue', async () => {
  const h = await harness()
  await h.service.createFromText({ text: 'a' })
  const s = await h.service.status()
  assert.equal(s.engine.ready, true)
  assert.equal(s.counts.waiting, 1)
  assert.equal(s.settings.ingestDelayMinutes, 10)
})
