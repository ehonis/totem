import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, createJournalStore, isEntryId, newEntryId, normalizeSettings } from './store.mjs'

const fresh = async () => createJournalStore({ dir: await mkdtemp(join(tmpdir(), 'journal-store-')) })

const entry = (id, recordedAt) => ({ id, recordedAt, status: 'transcribing', ingest: { state: 'queued' } })

test('ids are filename-safe and sort by time', () => {
  const a = newEntryId(Date.parse('2026-09-16T11:00:00Z'))
  const b = newEntryId(Date.parse('2026-09-17T11:00:00Z'))
  assert.ok(isEntryId(a) && isEntryId(b))
  assert.ok(a < b)
  assert.equal(isEntryId('../etc/passwd'), false)
})

test('put, list newest-first, get, update, remove', async () => {
  const store = await fresh()
  await store.put(entry('j_a', '2026-09-15T12:00:00.000Z'))
  await store.put(entry('j_b', '2026-09-16T12:00:00.000Z'))
  assert.deepEqual((await store.list()).map((e) => e.id), ['j_b', 'j_a'])

  const updated = await store.update('j_a', { status: 'transcribed' })
  assert.equal(updated.status, 'transcribed')
  assert.ok(updated.updatedAt)
  assert.equal((await store.get('j_a')).status, 'transcribed')

  // A functional update sees the current row and may replace it whole.
  const replaced = await store.update('j_a', (c) => ({ ...c, title: 'Legs' }))
  assert.equal(replaced.title, 'Legs')

  assert.equal(await store.update('j_missing', { title: 'x' }), null)
  assert.ok(await store.remove('j_b'))
  assert.equal(await store.get('j_b'), null)
  assert.equal(await store.remove('j_b'), null)
})

test('concurrent updates to one entry are serialized, so neither write is lost', async () => {
  const store = await fresh()
  await store.put({ ...entry('j_c', '2026-09-16T12:00:00.000Z'), count: 0 })
  await Promise.all(Array.from({ length: 25 }, () => store.update('j_c', (c) => ({ ...c, count: c.count + 1 }))))
  assert.equal((await store.get('j_c')).count, 25)
})

test('an unreadable entry file is skipped, not fatal', async () => {
  const store = await fresh()
  await store.put(entry('j_ok', '2026-09-16T12:00:00.000Z'))
  await writeFile(join(store.entriesDir, 'j_bad.json'), '{not json')
  assert.deepEqual((await store.list()).map((e) => e.id), ['j_ok'])
})

test('settings default, persist, and are clamped', async () => {
  const store = await fresh()
  assert.deepEqual(await store.readSettings(), { ...DEFAULT_SETTINGS })
  const next = await store.writeSettings({ ingestDelayMinutes: 3, vocabulary: '  Robin,   Fairview ' })
  assert.equal(next.ingestDelayMinutes, 3)
  assert.equal(next.vocabulary, 'Robin, Fairview')
  assert.equal(next.keepAudioDays, 14)
  assert.equal((await store.readSettings()).ingestDelayMinutes, 3)
  assert.equal(JSON.parse(await readFile(join(store.dir, 'settings.json'), 'utf8')).ingestDelayMinutes, 3)

  assert.equal(normalizeSettings({ ingestDelayMinutes: -4 }).ingestDelayMinutes, 0)
  assert.equal(normalizeSettings({ ingestDelayMinutes: 'soon' }).ingestDelayMinutes, DEFAULT_SETTINGS.ingestDelayMinutes)
  assert.equal(normalizeSettings({ ingestDelayMinutes: 99_999 }).ingestDelayMinutes, 1440)
})

test('the digest agent is validated, but the model id is deliberately not', async () => {
  const store = await fresh()
  const saved = await store.writeSettings({ provider: 'Claude', model: 'composer-2.5[fast=true]', effort: 'HIGH' })
  assert.equal(saved.provider, 'claude')
  // Cursor ids carry parameters; validating against a catalog would reject ids the
  // CLI accepts, and resolveModelChoice already corrects a stale one at run time.
  assert.equal(saved.model, 'composer-2.5[fast=true]')
  assert.equal(saved.effort, 'high')

  // A provider that does not exist would fail every future digest at spawn time,
  // so it is dropped back to "use the default" instead of being persisted.
  assert.equal(normalizeSettings({ provider: 'gpt5000' }).provider, '')
  assert.equal(normalizeSettings({ effort: 'whenever' }).effort, '')
  assert.equal(normalizeSettings({ keepAudioDays: -3 }).keepAudioDays, 0)
  assert.equal(normalizeSettings({ keepAudioDays: 9999 }).keepAudioDays, 365)
})
