import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RECOVERY_GREEN,
  RECOVERY_RED,
  RECOVERY_YELLOW,
  recoveryColor,
  recoveryGradientStops,
} from './recoveryLine.ts'

test('uses WHOOP recovery zone boundaries', () => {
  assert.equal(recoveryColor(0), RECOVERY_RED)
  assert.equal(recoveryColor(33), RECOVERY_RED)
  assert.equal(recoveryColor(34), RECOVERY_YELLOW)
  assert.equal(recoveryColor(66), RECOVERY_YELLOW)
  assert.equal(recoveryColor(67), RECOVERY_GREEN)
  assert.equal(recoveryColor(100), RECOVERY_GREEN)
})

test('builds score-positioned color stops at WHOOP zone boundaries', () => {
  const stops = recoveryGradientStops([
    { stats: { recovery: 20 } },
    { stats: {} },
    { stats: { recovery: 52 } },
    { stats: { recovery: 80 } },
  ])

  assert.deepEqual(stops, [
    { offset: '0%', color: RECOVERY_RED },
    { offset: '21.667%', color: RECOVERY_RED },
    { offset: '23.333%', color: RECOVERY_YELLOW },
    { offset: '76.667%', color: RECOVERY_YELLOW },
    { offset: '78.333%', color: RECOVERY_GREEN },
    { offset: '100%', color: RECOVERY_GREEN },
  ])
})

test('does not invent a recovery gradient without readings', () => {
  assert.deepEqual(recoveryGradientStops([{ stats: {} }, {}]), [])
})
