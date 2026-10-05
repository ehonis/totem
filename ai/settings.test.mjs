// Run with: node --test ai/settings.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAiSettings, maskSecret } from './settings.mjs'

async function fresh(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-ai-'))
  const file = join(dir, 'ai-settings.json')
  const settings = createAiSettings({ file, env })
  await settings.load()
  return { settings, file, env }
}

test('nothing configured: no keys, nothing put into the environment', async () => {
  const { settings, env } = await fresh()
  assert.ok(settings.describe().every((k) => k.source === null && k.masked === null))
  assert.deepEqual(env, {})
})

test('a stored key reaches the environment, masked on the way out, in a 0600 file', async () => {
  const { settings, file, env } = await fresh()
  const out = await settings.updateKeys({ ANTHROPIC_API_KEY: 'sk-ant-1234567890abcd' })
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-1234567890abcd')
  const row = out.find((k) => k.name === 'ANTHROPIC_API_KEY')
  assert.equal(row.source, 'settings')
  assert.equal(row.masked, '••••abcd')
  assert.ok(!JSON.stringify(out).includes('sk-ant-1234567890abcd'), 'the value never leaves describe()')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.match(await readFile(file, 'utf8'), /sk-ant-1234567890abcd/)
})

test('removing a stored key takes it out of the environment', async () => {
  const { settings, env } = await fresh()
  await settings.updateKeys({ OPENAI_API_KEY: 'sk-openai-abcdefgh' })
  await settings.updateKeys({ OPENAI_API_KEY: null })
  assert.equal(env.OPENAI_API_KEY, undefined)
})

test('the real environment wins and cannot be changed from the dashboard', async () => {
  const { settings, env } = await fresh({ OPENAI_API_KEY: 'from-env-value-xyz9' })
  const row = settings.describe().find((k) => k.name === 'OPENAI_API_KEY')
  assert.equal(row.source, 'env')
  assert.equal(row.masked, '••••xyz9')
  await assert.rejects(() => settings.updateKeys({ OPENAI_API_KEY: 'other' }), /server environment/)
  assert.equal(env.OPENAI_API_KEY, 'from-env-value-xyz9')
})

test('stored keys come back after a restart', async () => {
  const { settings, file } = await fresh()
  await settings.updateKeys({ CURSOR_API_KEY: 'cursor-key-0000' })
  const env = {}
  await createAiSettings({ file, env }).load()
  assert.equal(env.CURSOR_API_KEY, 'cursor-key-0000')
})

test('unknown key names are refused', async () => {
  const { settings } = await fresh()
  await assert.rejects(() => settings.updateKeys({ PATH: '/tmp' }), /unknown key/)
})

test('short values mask fully', () => {
  assert.equal(maskSecret('abc'), '••••')
  assert.equal(maskSecret(''), null)
})

test('the Test button names a credentials failure plainly', async () => {
  const { authFailureMessage } = await import('./settings.mjs')
  const codex401 = 'codex produced no output — unexpected status 401 Unauthorized: Missing bearer [redacted] in header'
  assert.match(authFailureMessage(codex401, { provider: 'Codex', fix: 'codex login' }), /Codex rejected its credentials\. Check the API key in Settings -> AI or run `codex login`/)
  assert.ok(authFailureMessage('Invalid API key · Please run /login', { provider: 'Claude Code' }))
  assert.equal(authFailureMessage('ok'), null)
  assert.equal(authFailureMessage('rate limited, try later'), null)
})
