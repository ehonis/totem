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

test('the sheet credentials path is env-only and never sent back as a path', () => {
  const keys = bridge.slice(bridge.indexOf('const INTEGRATION_KEYS = ['), bridge.indexOf(']', bridge.indexOf('const INTEGRATION_KEYS = [')))
  assert.doesNotMatch(keys, /GOOGLE_SHEETS_CREDENTIALS_FILE/)
  assert.match(bridge, /state: !GOOGLE_SHEETS_CREDENTIALS_FILE \? 'unset' : existsSync\(GOOGLE_SHEETS_CREDENTIALS_FILE\) \? 'found' : 'missing'/)
})

test('usage profile paths need the opt-in', () => {
  const start = bridge.indexOf('if (patch.addAccount) {')
  assert.match(bridge.slice(start, start + 400), /if \(!EXEC_CONFIG_EDITABLE\) throw/)
})

test('agent API keys are masked to the last four characters', async () => {
  const { maskSecret } = await import('../ai/settings.mjs')
  assert.equal(maskSecret('sk-ant-0123456789wxyz'), '••••wxyz')
  assert.equal(maskSecret('short'), '••••')
})
