import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApprovalStore } from './approvals.mjs'
import { createApprovalController } from './approval-controller.mjs'

const EXPLANATION = 'Lets this conversation resolve staged commands and agent jobs'
const WHY = 'The current work needs several commands without repeated approval prompts'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'totem-approval-controller-'))
  const approvals = createApprovalStore({ file: join(dir, 'approvals.json') })
  const resolved = []
  const logged = []
  const controller = createApprovalController({
    approvals,
    resolveInboxItem: async (args) => {
      resolved.push(args)
      return { ok: true, id: args.id, action: args.action, note: `resolved ${args.id}` }
    },
    actionLog: { record: (entry) => { logged.push(entry) } },
    actorForSession: (session) => String(session?.client || 'unknown').toLowerCase(),
  })
  return { approvals, controller, resolved, logged }
}

async function approvedLease(approvals, requestedBy = 'chatgpt') {
  const lease = await approvals.request({ explanation: EXPLANATION, why: WHY, requestedBy })
  await approvals.approve({ approvalSessionId: lease.approvalSessionId })
  return lease
}

test('one approved session resolves multiple proposal ids', async () => {
  const { approvals, controller, resolved } = await fixture()
  const lease = await approvedLease(approvals)
  const session = { client: 'ChatGPT' }

  const first = await controller.resolveInbox({
    id: 'P1', action: 'accept', approvalSessionId: lease.approvalSessionId,
  }, session)
  const second = await controller.resolveInbox({
    id: 'P2', action: 'accept', approvalSessionId: lease.approvalSessionId,
  }, session)

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.deepEqual(resolved.map((row) => row.id), ['P1', 'P2'])
  assert.equal((await approvals.status({ approvalSessionId: lease.approvalSessionId })).useCount, 2)
  assert.equal(second.approvalSessionId, lease.approvalSessionId)
})

test('pending, missing, and revoked sessions never reach inbox resolution', async () => {
  const { approvals, controller, resolved, logged } = await fixture()
  const pending = await approvals.request({ explanation: EXPLANATION, why: WHY, requestedBy: 'chatgpt' })

  for (const approvalSessionId of [pending.approvalSessionId, 'missing-session']) {
    const result = await controller.resolveInbox({ id: 'P1', action: 'accept', approvalSessionId }, { client: 'ChatGPT' })
    assert.equal(result.blocked, true)
  }

  await approvals.approve({ approvalSessionId: pending.approvalSessionId })
  await approvals.revoke({ approvalSessionId: pending.approvalSessionId, reason: 'done' })
  const revoked = await controller.resolveInbox({
    id: 'P1', action: 'accept', approvalSessionId: pending.approvalSessionId,
  }, { client: 'ChatGPT' })

  assert.equal(revoked.blocked, true)
  assert.equal(resolved.length, 0)
  assert.equal(logged.filter((row) => row.status === 'denied').length, 3)
})

test('the out-of-band code activates a pending session on first resolution', async () => {
  let ownerLease
  const dir = await mkdtemp(join(tmpdir(), 'totem-approval-code-'))
  const approvals = createApprovalStore({
    file: join(dir, 'approvals.json'),
    onRequest: (lease) => { ownerLease = lease },
  })
  const controller = createApprovalController({
    approvals,
    resolveInboxItem: async (args) => ({ ok: true, id: args.id, action: args.action, note: 'running' }),
    actionLog: { record() {} },
    actorForSession: (session) => String(session?.client || 'unknown').toLowerCase(),
  })
  const lease = await approvals.request({ explanation: EXPLANATION, why: WHY, requestedBy: 'chatgpt' })

  const result = await controller.resolveInbox({
    id: 'P9', action: 'accept', approvalSessionId: lease.approvalSessionId, code: ownerLease.code,
  }, { client: 'ChatGPT' })

  assert.equal(result.ok, true)
  assert.equal((await approvals.status({ approvalSessionId: lease.approvalSessionId })).status, 'approved')
})

test('dashboard decisions are logged against the reusable session id', async () => {
  const { controller, logged } = await fixture()
  const requested = await controller.requestSession({ explanation: EXPLANATION, why: WHY }, { client: 'ChatGPT' })
  await controller.approveSession({ approvalSessionId: requested.approvalSessionId })
  await controller.revokeSession({ approvalSessionId: requested.approvalSessionId, reason: 'finished' })

  assert.deepEqual(logged.map((row) => row.action), [
    'approval.approve',
    'approval.revoke',
  ])
  assert.ok(logged.every((row) => row.target === requested.approvalSessionId))
})

test('responses carry tellOwner, with tellEthan as a same-value deprecated alias', async () => {
  const { approvals, controller } = await fixture()
  const requested = await controller.requestSession({ explanation: EXPLANATION, why: WHY }, { client: 'ChatGPT' })
  assert.match(requested.tellOwner, /Approve this conversation/)
  assert.equal(requested.tellEthan, requested.tellOwner)

  await approvals.approve({ approvalSessionId: requested.approvalSessionId })
  const resolved = await controller.resolveInbox({ id: 'P1', action: 'accept', approvalSessionId: requested.approvalSessionId }, { client: 'ChatGPT' })
  assert.equal(resolved.tellOwner, 'Accepted P1: resolved P1')
  assert.equal(resolved.tellEthan, resolved.tellOwner)
})
