import test from 'node:test'
import assert from 'node:assert/strict'

import { indexRecoveryScores } from './recovery.mjs'

test('indexes only scored WHOOP recoveries by cycle id', () => {
  const scores = indexRecoveryScores([
    { cycle_id: 101, score_state: 'SCORED', score: { recovery_score: 72.4 } },
    { cycle_id: 102, score_state: 'PENDING_SCORE', score: { recovery_score: 88 } },
    { cycle_id: 103, score_state: 'SCORED', score: { recovery_score: null } },
    { cycle_id: 104, score: { recovery_score: 33.6 } },
  ])

  assert.deepEqual([...scores], [[101, 72], [104, 34]])
})

test('keeps the freshest scored recovery when WHOOP returns a cycle twice', () => {
  const scores = indexRecoveryScores([
    { cycle_id: 101, updated_at: '2026-08-20T08:00:00Z', score_state: 'SCORED', score: { recovery_score: 61 } },
    { cycle_id: 101, updated_at: '2026-08-20T09:00:00Z', score_state: 'SCORED', score: { recovery_score: 68 } },
  ])

  assert.equal(scores.get(101), 68)
})
