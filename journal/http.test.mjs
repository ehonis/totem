import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJournalStore } from './store.mjs'
import { createJournalService } from './service.mjs'
import { createJournalHttpHandler } from './http.mjs'

async function listen({ maxAudioBytes } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'journal-http-'))
  const store = createJournalStore({ dir: join(root, 'journal') })
  const service = createJournalService({
    store,
    transcriber: { status: async () => ({ ready: true, missing: [] }), transcribe: async () => ({ text: 'Hi.', segments: [], durationSec: 2, ms: 1 }) },
    audioDir: join(root, 'audio'),
    brainDir: join(root, 'brain'),
    ingest: async () => 'ok',
    schedule: () => {},
  })
  const handler = createJournalHttpHandler({ service, maxAudioBytes })
  const server = createServer(async (req, res) => {
    if (await handler(req, res, new URL(req.url, 'http://x'))) return
    res.writeHead(404); res.end('fallthrough')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise((r) => server.close(r)) }
}

test('audio upload creates an entry from raw bytes plus query facts', async () => {
  const s = await listen()
  try {
    const res = await fetch(`${s.base}/api/journal/entries?duration=12.6&recordedAt=2026-09-16T11:00:00.000Z`, {
      method: 'POST', headers: { 'content-type': 'audio/mp4' }, body: Buffer.from('abc'),
    })
    assert.equal(res.status, 201)
    const { entry } = await res.json()
    assert.equal(entry.source, 'voice')
    assert.equal(entry.durationSec, 13)
    assert.equal(entry.recordedAt, '2026-09-16T11:00:00.000Z')
    assert.equal(entry.audio.mime, 'audio/mp4')
    assert.equal(entry.audio.bytes, 3)
    assert.equal(entry.audio.kept, true)
    assert.equal(entry.audio.pinned, false)
    assert.ok(entry.audio.keepUntil, 'a saved recording carries its own deadline')
    assert.equal(entry.status, 'transcribing')

    const list = await (await fetch(`${s.base}/api/journal`)).json()
    assert.equal(list.entries.length, 1)
    assert.equal(list.engine.ready, true)
    assert.equal(list.settings.ingestDelayMinutes, 10)
  } finally { await s.close() }
})

test('oversized audio is refused before it is stored', async () => {
  const s = await listen({ maxAudioBytes: 10 })
  try {
    const res = await fetch(`${s.base}/api/journal/entries`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.alloc(11) })
    assert.equal(res.status, 413)
    const body = await res.json()
    assert.equal(body.error.code, 'AUDIO_TOO_LARGE')
    assert.equal((await (await fetch(`${s.base}/api/journal`)).json()).entries.length, 0)
  } finally { await s.close() }
})

test('typed entries, skip, ingest-now, patch, delete, and settings all round-trip', async () => {
  const s = await listen()
  try {
    const created = await (await fetch(`${s.base}/api/journal/entries`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Typed it.' }),
    })).json()
    const id = created.entry.id
    assert.equal(created.entry.status, 'transcribed')

    let r = await fetch(`${s.base}/api/journal/entries/${id}/skip`, { method: 'POST' })
    assert.equal((await r.json()).entry.ingest.state, 'skipped')
    r = await fetch(`${s.base}/api/journal/entries/${id}/ingest`, { method: 'POST' })
    assert.equal((await r.json()).entry.ingest.state, 'queued')
    r = await fetch(`${s.base}/api/journal/entries/${id}/retry`, { method: 'POST' })
    assert.equal(r.status, 409)

    r = await fetch(`${s.base}/api/journal/entries/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Typed' }) })
    assert.equal((await r.json()).entry.title, 'Typed')

    r = await fetch(`${s.base}/api/journal/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ingestDelayMinutes: 2, vocabulary: 'Robin', provider: 'claude', model: 'sonnet', effort: 'high', keepAudioDays: 30 }) })
    assert.deepEqual((await r.json()).settings, {
      ingestDelayMinutes: 2, vocabulary: 'Robin', keepAudioDays: 30,
      provider: 'claude', model: 'sonnet', effort: 'high',
    })

    r = await fetch(`${s.base}/api/journal/entries/${id}`, { method: 'DELETE' })
    assert.equal((await r.json()).ok, true)
    r = await fetch(`${s.base}/api/journal/entries/${id}`)
    assert.equal(r.status, 404)

    // Empty typed body is a 400 with a code the UI can name.
    r = await fetch(`${s.base}/api/journal/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 400)
    assert.equal((await r.json()).error.code, 'EMPTY_TEXT')
  } finally { await s.close() }
})

test('the recording can be played back, kept, and deleted without touching the transcript', async () => {
  const s = await listen()
  try {
    const created = await (await fetch(`${s.base}/api/journal/entries?duration=4`, {
      method: 'POST', headers: { 'content-type': 'audio/mp4' }, body: Buffer.from('audio-bytes'),
    })).json()
    const id = created.entry.id

    // Playback: the real bytes, with a filename and no caching.
    let r = await fetch(`${s.base}/api/journal/entries/${id}/audio`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'audio/mp4')
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.match(r.headers.get('content-disposition'), /filename="/)
    assert.equal(await r.text(), 'audio-bytes')

    // Keep it: no deadline any more.
    r = await fetch(`${s.base}/api/journal/entries/${id}/keep-audio`, { method: 'POST' })
    let entry = (await r.json()).entry
    assert.equal(entry.audio.pinned, true)
    assert.equal(entry.audio.keepUntil, null)

    // Let it expire again: a fresh window, not an immediate delete.
    r = await fetch(`${s.base}/api/journal/entries/${id}/unkeep-audio`, { method: 'POST' })
    entry = (await r.json()).entry
    assert.equal(entry.audio.pinned, false)
    assert.ok(Date.parse(entry.audio.keepUntil) > Date.now())

    // Delete the audio by hand; the entry and its transcript stay.
    r = await fetch(`${s.base}/api/journal/entries/${id}/audio`, { method: 'DELETE' })
    entry = (await r.json()).entry
    assert.equal(entry.audio.kept, false)
    assert.ok(entry.audio.deletedAt)
    assert.equal((await fetch(`${s.base}/api/journal/entries/${id}/audio`)).status, 410)
    assert.equal((await fetch(`${s.base}/api/journal/entries/${id}`)).status, 200)
  } finally { await s.close() }
})

test('other /api paths fall through untouched', async () => {
  const s = await listen()
  try {
    const r = await fetch(`${s.base}/api/journals`)
    assert.equal(r.status, 404)
    assert.equal(await r.text(), 'fallthrough')
  } finally { await s.close() }
})
