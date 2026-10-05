import test from 'node:test'
import assert from 'node:assert/strict'
import { partitionApprovalLeases } from './approvalLeases.ts'

test('separates active reusable leases from pending and historical rows', () => {
  const rows = [
    { approvalSessionId: 'pending', status: 'pending' },
    { approvalSessionId: 'active', status: 'approved', useCount: 3 },
    { approvalSessionId: 'revoked', status: 'revoked' },
    { approvalSessionId: 'expired', status: 'expired' },
  ]

  const result = partitionApprovalLeases(rows)

  assert.deepEqual(result.pending.map((row) => row.approvalSessionId), ['pending'])
  assert.deepEqual(result.active.map((row) => row.approvalSessionId), ['active'])
  assert.deepEqual(result.decided.map((row) => row.approvalSessionId), ['revoked', 'expired'])
})

test('legacy approved grants stay in history rather than becoming active sessions', () => {
  const rows = [
    { approvalSessionId: 'legacy', status: 'approved', legacy: true },
    { approvalSessionId: 'session', status: 'approved' },
  ]

  const result = partitionApprovalLeases(rows)

  assert.deepEqual(result.active.map((row) => row.approvalSessionId), ['session'])
  assert.deepEqual(result.decided.map((row) => row.approvalSessionId), ['legacy'])
})
