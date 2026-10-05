// Run with: node --test ai-usage/registry.test.mjs
//
// Claude quota polling uses Claude Code's built-in OAuth client and writes its
// rotated token back; Cursor polling calls Cursor's private usage endpoint. A fresh
// install must do neither until asked; an install that already had them keeps them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeOAuthEnabled, collectAccounts, cursorUsageEnabled, ensureUsageOptIns, loadConfig, optInFromEnv } from './registry.mjs'

async function withConfig(contents, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-aiusage-'))
  const file = join(dir, 'ai-usage.json')
  if (contents) await writeFile(file, JSON.stringify(contents))
  const before = { config: process.env.AI_USAGE_CONFIG, flag: process.env.AI_USAGE_CLAUDE_OAUTH, cursor: process.env.AI_USAGE_CURSOR }
  process.env.AI_USAGE_CONFIG = file
  delete process.env.AI_USAGE_CLAUDE_OAUTH
  delete process.env.AI_USAGE_CURSOR
  try {
    return await fn(file)
  } finally {
    if (before.config === undefined) delete process.env.AI_USAGE_CONFIG
    else process.env.AI_USAGE_CONFIG = before.config
    if (before.flag === undefined) delete process.env.AI_USAGE_CLAUDE_OAUTH
    else process.env.AI_USAGE_CLAUDE_OAUTH = before.flag
    if (before.cursor === undefined) delete process.env.AI_USAGE_CURSOR
    else process.env.AI_USAGE_CURSOR = before.cursor
  }
}

test('a fresh install records both opt-in pollers as off', () => withConfig(null, async (file) => {
  assert.deepEqual(await ensureUsageOptIns({ existingInstall: false }), { claudeOAuthUsage: false, cursorUsage: false })
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.claudeOAuthUsage, false)
  assert.equal(saved.cursorUsage, false)
  const config = await loadConfig()
  assert.equal(claudeOAuthEnabled(config), false)
  assert.equal(cursorUsageEnabled(config), false)
}))

test('an existing install keeps both on, and the choice sticks', () => withConfig({ pollIntervalSeconds: 60 }, async (file) => {
  assert.deepEqual(await ensureUsageOptIns({ existingInstall: true }), { claudeOAuthUsage: true, cursorUsage: true })
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.cursorUsage, true)
  assert.equal(saved.pollIntervalSeconds, 60, 'other settings are kept')
  // A later boot never re-decides, whatever it thinks of the install.
  assert.deepEqual(await ensureUsageOptIns({ existingInstall: false }), { claudeOAuthUsage: true, cursorUsage: true })
}))

test('a poller added later inherits the recorded decision instead of re-judging the install', async () => {
  // A fresh install that booted once has a config file, so "existing data" is no
  // longer a fair test. Its recorded Claude choice is.
  await withConfig({ claudeOAuthUsage: false }, async () => {
    assert.deepEqual(await ensureUsageOptIns({ existingInstall: true }), { claudeOAuthUsage: false, cursorUsage: false })
  })
  await withConfig({ claudeOAuthUsage: true }, async () => {
    assert.deepEqual(await ensureUsageOptIns({ existingInstall: false }), { claudeOAuthUsage: true, cursorUsage: true })
  })
})

test('each env var overrides its stored setting both ways', () => withConfig({ claudeOAuthUsage: false, cursorUsage: false }, async () => {
  process.env.AI_USAGE_CLAUDE_OAUTH = 'true'
  process.env.AI_USAGE_CURSOR = 'yes'
  const config = await loadConfig()
  assert.equal(claudeOAuthEnabled(config), true)
  assert.equal(cursorUsageEnabled(config), true)
  assert.equal(optInFromEnv('cursorUsage'), true)
  process.env.AI_USAGE_CLAUDE_OAUTH = 'false'
  process.env.AI_USAGE_CURSOR = 'off'
  assert.equal(claudeOAuthEnabled({ claudeOAuthUsage: true }), false)
  assert.equal(cursorUsageEnabled({ cursorUsage: true }), false)
}))

test('the settings toggle works when no env var is set', () => withConfig({ cursorUsage: true }, async () => {
  assert.equal(optInFromEnv('cursorUsage'), false)
  assert.equal(cursorUsageEnabled(await loadConfig()), true)
}))

test('a poller that is off contributes no accounts, even listed by hand', () => withConfig(null, async () => {
  const config = {
    autoDiscover: false, hidden: [], accountNames: {}, providers: {},
    accounts: [{ backend: 'cursor', label: 'c' }, { backend: 'claude', label: 'a' }, { backend: 'codex', label: 'x' }],
  }
  const off = await collectAccounts({ ...config, cursorUsage: false, claudeOAuthUsage: false })
  assert.deepEqual(off.map((a) => a.backend), ['codex'])
  const on = await collectAccounts({ ...config, cursorUsage: true, claudeOAuthUsage: true })
  assert.deepEqual(on.map((a) => a.backend).sort(), ['claude', 'codex', 'cursor'])
}))
