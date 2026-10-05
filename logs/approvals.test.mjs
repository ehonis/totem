// Run with: node --test logs/approvals.test.mjs
//
// These tests specify the approval boundary. A failure can mean an assistant can
// act without the owner, keep acting after revocation, or lose a valid lease early.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApprovalStore } from './approvals.mjs'

const WHAT = 'Lets this conversation run staged commands and agent jobs'
const WHY = 'So the owner can approve the working session once instead of every command'
const HOUR = 60 * 60 * 1000

async function freshStore(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-approvals-'))
  const file = join(dir, 'approvals.json')
  const notified = []
  const store = createApprovalStore({ file, onRequest: (lease) => { notified.push(lease) }, ...opts })
  return { store, file, notified }
}

async function requestLease(store, requestedBy = 'chatgpt') {
  return store.request({ explanation: WHAT, why: WHY, requestedBy })
}

test('a request is inert and never tells the requester the code', async () => {
  const { store, notified } = await freshStore()
  const lease = await requestLease(store)

  assert.equal(lease.status, 'pending')
  assert.match(lease.approvalSessionId, /^[0-9a-f-]{36}$/)
  assert.equal(lease.code, undefined)
  assert.equal(lease.useCount, 0)
  assert.equal(notified.length, 1)
  assert.match(notified[0].code, /^\d{6}$/)
})

test('an explanation and a why are both mandatory', async () => {
  const { store } = await freshStore()
  await assert.rejects(() => store.request({ why: WHY }), /explanation is required/)
  await assert.rejects(() => store.request({ explanation: WHAT }), /why is required/)
  await assert.rejects(() => store.request({ explanation: 'do it', why: 'because' }), /explanation is required/)
})

test('a pending lease cannot authorize an action', async () => {
  const { store } = await freshStore()
  const lease = await requestLease(store)
  await assert.rejects(
    () => store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' }),
    /still waiting on the owner's approval/,
  )
})

test('a guessed code cannot activate a pending lease', async () => {
  const { store } = await freshStore()
  const lease = await requestLease(store)
  for (const code of ['000000', '123456', '999999', '', 'abcdef']) {
    await assert.rejects(
      () => store.authorize({ approvalSessionId: lease.approvalSessionId, code, requestedBy: 'chatgpt' }),
      /still waiting on the owner's approval/,
    )
  }
})

test('one approved lease authorizes repeatedly and slides one hour from every use', async () => {
  let clock = 1_000_000
  const { store } = await freshStore({ ttlMs: HOUR, now: () => clock })
  const lease = await requestLease(store)
  const approved = await store.approve({ approvalSessionId: lease.approvalSessionId })
  assert.equal(approved.expiresAt, new Date(clock + HOUR).toISOString())

  clock += 50 * 60_000
  const first = await store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' })
  assert.equal(first.status, 'approved')
  assert.equal(first.useCount, 1)
  assert.equal(first.expiresAt, new Date(clock + HOUR).toISOString())

  clock += 50 * 60_000
  const second = await store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' })
  assert.equal(second.useCount, 2)
  assert.equal(second.expiresAt, new Date(clock + HOUR).toISOString())
})

test('the out-of-band code approves the lease on its first authorized use', async () => {
  const { store, notified } = await freshStore()
  const lease = await requestLease(store)
  const used = await store.authorize({
    approvalSessionId: lease.approvalSessionId,
    code: notified[0].code,
    requestedBy: 'chatgpt',
  })
  assert.equal(used.status, 'approved')
  assert.equal(used.useCount, 1)
  assert.ok(used.decidedAt)
})

test('a lease is bound to the requesting MCP client', async () => {
  const { store } = await freshStore()
  const lease = await requestLease(store, 'chatgpt')
  await store.approve({ approvalSessionId: lease.approvalSessionId })
  await assert.rejects(
    () => store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'claude' }),
    /belongs to chatgpt, not claude/,
  )
})

test('one hour without an authorized use expires a lease permanently', async () => {
  let clock = 1_000_000
  const { store } = await freshStore({ ttlMs: HOUR, now: () => clock })
  const lease = await requestLease(store)
  await store.approve({ approvalSessionId: lease.approvalSessionId })
  clock += HOUR + 1
  await assert.rejects(
    () => store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' }),
    /expired/,
  )
  assert.equal((await store.status({ approvalSessionId: lease.approvalSessionId })).status, 'expired')
  await assert.rejects(() => store.approve({ approvalSessionId: lease.approvalSessionId }), /no pending approval/)
})

test('denying a pending lease blocks it permanently', async () => {
  const { store } = await freshStore()
  const lease = await requestLease(store)
  await store.deny({ approvalSessionId: lease.approvalSessionId, reason: 'not now' })
  await assert.rejects(
    () => store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' }),
    /denied this session: not now/,
  )
})

test('revoking an approved lease immediately blocks every later action', async () => {
  const { store } = await freshStore()
  const lease = await requestLease(store)
  await store.approve({ approvalSessionId: lease.approvalSessionId })
  await store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' })
  const revoked = await store.revoke({ approvalSessionId: lease.approvalSessionId, reason: 'work is done' })

  assert.equal(revoked.status, 'revoked')
  assert.equal(revoked.revokeReason, 'work is done')
  await assert.rejects(
    () => store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' }),
    /revoked this session: work is done/,
  )
})

test('pending requests are capped so a looping model cannot flood the queue', async () => {
  const { store } = await freshStore()
  for (let i = 0; i < 10; i++) await requestLease(store, `client-${i}`)
  await assert.rejects(() => requestLease(store, 'client-10'), /too many approvals already waiting/)
})

test('requester-facing status never exposes the code', async () => {
  const { store } = await freshStore()
  const lease = await requestLease(store)
  const status = await store.status({ approvalSessionId: lease.approvalSessionId })
  assert.equal(status.status, 'pending')
  assert.equal(status.code, undefined)
})

test('concurrent authorized uses all succeed without losing the use count', async () => {
  const { store } = await freshStore()
  const lease = await requestLease(store)
  await store.approve({ approvalSessionId: lease.approvalSessionId })
  const results = await Promise.all([
    store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' }),
    store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' }),
    store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' }),
  ])
  assert.deepEqual(results.map((row) => row.useCount), [1, 2, 3])
  assert.equal((await store.status({ approvalSessionId: lease.approvalSessionId })).useCount, 3)
})

test('legacy single-use rows remain visible but cannot authorize a session', async () => {
  const { store, file } = await freshStore()
  await writeFile(file, JSON.stringify({ grants: [{
    id: 'legacy-grant', kind: 'inbox', target: 'P1', code: '123456', status: 'approved',
    explanation: WHAT, why: WHY, requestedBy: 'chatgpt', requestedAt: 1, expiresAt: Date.now() + HOUR,
  }] }))

  const listed = await store.list()
  assert.equal(listed.grants[0].legacy, true)
  await assert.rejects(
    () => store.authorize({ approvalSessionId: 'legacy-grant', requestedBy: 'chatgpt' }),
    /legacy approval cannot authorize a session/,
  )
})

test('the stored lease retains audit fields while public views keep the code private', async () => {
  let clock = 1_000_000
  const { store, file } = await freshStore({ now: () => clock })
  const lease = await requestLease(store)
  await store.approve({ approvalSessionId: lease.approvalSessionId })
  clock += 500
  await store.authorize({ approvalSessionId: lease.approvalSessionId, requestedBy: 'chatgpt' })

  const saved = JSON.parse(await readFile(file, 'utf8')).grants[0]
  assert.equal(saved.schemaVersion, 2)
  assert.equal(saved.status, 'approved')
  assert.equal(saved.useCount, 1)
  assert.equal(saved.lastUsedAt, clock)
  assert.equal(saved.explanation, WHAT)
  assert.match(saved.code, /^\d{6}$/)
  assert.equal((await store.status({ approvalSessionId: lease.approvalSessionId })).code, undefined)
})
