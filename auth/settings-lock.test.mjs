// Run with: node --test auth/settings-lock.test.mjs
//
// Settings a browser session must not be able to set: anything naming a program
// to run, a directory or file the server reads secrets from, or launch arguments.
// These are edited on the box (or opened up with TOTEM_ALLOW_UI_EXEC_CONFIG).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const bridge = readFileSync(join(import.meta.dirname, '..', 'bridge.mjs'), 'utf8')

test('the task sheet settings name no file the server reads', () => {
  const start = bridge.indexOf('const INTEGRATION_KEYS = [')
  const keys = bridge.slice(start, bridge.indexOf('\n]', start))
  assert.deepEqual([...keys.matchAll(/name: '(TASK_SHEET_\w+)'/g)].map((m) => m[1]),
    ['TASK_SHEET_ID', 'TASK_SHEET_TAB', 'TASK_SHEET_ASSIGNEES', 'TASK_SHEET_TITLE', 'TASK_SHEET_ACCOUNT'])
  // The service-account sync and its credentials file were retired.
  assert.doesNotMatch(bridge, /GOOGLE_SHEETS_CREDENTIALS_FILE|credentialsFile/)
})

test('usage profile paths need the opt-in', () => {
  const start = bridge.indexOf('if (patch.addAccount) {')
  assert.match(bridge.slice(start, start + 400), /if \(!EXEC_CONFIG_EDITABLE\) throw/)
})
