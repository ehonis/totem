import test from 'node:test'
import assert from 'node:assert/strict'

import { sheetFeedLine } from './sheetFeedLine.ts'

const NOW = Date.parse('2026-11-09T15:00:00Z')
const item = { id: 'sheet:0:5:0a1b2c3d', row: 5, title: 'Row', who: 'Alex', priority: null, status: '', dueDate: null, notes: '', url: '' }

test('not set up: says so, and what to set', () => {
  assert.equal(sheetFeedLine({ configured: false, items: [], reason: 'Set TASK_SHEET_ID in Settings → Tasks.' }, NOW), 'Not set up. Set TASK_SHEET_ID in Settings → Tasks.')
})

test('read: how many open rows, and when', () => {
  const fetchedAt = new Date(NOW - 3 * 60_000).toISOString()
  assert.equal(sheetFeedLine({ configured: true, items: [item, item], fetchedAt, stale: false, error: null }, NOW), '2 open rows for you, read 3 min ago.')
  assert.equal(sheetFeedLine({ configured: true, items: [item], fetchedAt: new Date(NOW).toISOString(), stale: false, error: null }, NOW), '1 open row for you, read just now.')
})

test('a failed read keeps the last good rows and names the error', () => {
  const fetchedAt = new Date(NOW - 10 * 60_000).toISOString()
  assert.equal(
    sheetFeedLine({ configured: true, items: [item], fetchedAt, stale: true, error: 'HTTP 503' }, NOW),
    'Showing 1 open row read 10 min ago. Last read failed: HTTP 503',
  )
  assert.equal(sheetFeedLine({ configured: true, items: [], fetchedAt: null, stale: true, error: 'sign-in failed' }, NOW), 'Not read yet. Last read failed: sign-in failed')
})
