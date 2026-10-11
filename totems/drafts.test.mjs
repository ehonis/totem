// node --test totems/drafts.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraftStore, mergeDraft, isPending, PENDING_STALE_MS } from './drafts.mjs'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-drafts-'))
  try { await fn(createDraftStore(dir), dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('a draft is saved, merged, listed newest first and removed', () => withStore(async (store, dir) => {
  await store.save('draft-aaa1', { description: 'first', draft: { name: 'A' } })
  await new Promise((r) => setTimeout(r, 5))
  await store.save('draft-bbb2', { description: 'second' })
  const merged = await store.save('draft-aaa1', { choice: { provider: 'codex', model: 'gpt-6-luna', effort: 'huge' } })
  assert.equal(merged.description, 'first', 'fields not in the patch are kept')
  assert.deepEqual(merged.draft, { name: 'A' })
  assert.deepEqual(merged.choice, { provider: 'codex', model: 'gpt-6-luna', effort: '' })
  assert.deepEqual((await store.list()).map((d) => d.id), ['draft-aaa1', 'draft-bbb2'])
  await store.remove('draft-aaa1')
  assert.equal(await store.get('draft-aaa1'), null)
  assert.deepEqual((await readdir(dir)).sort(), ['draft-bbb2.json'], 'no temp files left behind')
}))

test('a draft that is gone stays gone when a late write says so', () => withStore(async (store) => {
  assert.equal(await store.save('draft-gone1', { description: 'x' }, { create: false }), null)
  assert.equal(await store.get('draft-gone1'), null)
}))

test('bad ids never reach the filesystem', () => withStore(async (store) => {
  assert.equal(await store.get('../../etc/passwd'), null)
  await assert.rejects(store.save('../x', {}))
}))

test('concurrent writes to one draft all land', () => withStore(async (store) => {
  await Promise.all([
    store.save('draft-race1', { description: 'd' }),
    store.save('draft-race1', { draft: { name: 'N' } }),
    store.save('draft-race1', { choice: { provider: 'claude', model: '' } }),
  ])
  const d = await store.get('draft-race1')
  assert.equal(d.description, 'd')
  assert.deepEqual(d.draft, { name: 'N' })
  assert.equal(d.choice.provider, 'claude')
}))

test('messages are cleaned and bounded; a stale pending turn reads as finished', () => {
  const rec = mergeDraft(null, { messages: [{ role: 'owner', text: ' hi ' }, { role: 'system', text: 'no' }, { role: 'builder', text: 'ok', questions: ['q1', ''], error: true }, { role: 'owner', text: '' }] }, 1000)
  assert.deepEqual(rec.messages.map((m) => [m.role, m.text]), [['owner', 'hi'], ['builder', 'ok']])
  assert.deepEqual(rec.messages[1].questions, ['q1'])
  assert.equal(rec.messages[1].error, true)
  const pending = mergeDraft(rec, { pending: { text: 'go', startedAt: 1000 } }, 1000)
  assert.equal(isPending(pending, 2000), true)
  assert.equal(isPending(pending, 1000 + PENDING_STALE_MS + 1), false)
  assert.equal(mergeDraft(pending, { pending: null }).pending, null)
})
