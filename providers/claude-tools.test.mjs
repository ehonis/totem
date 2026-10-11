import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  serverPrefix, parseInitEvent, probeClaudeTools, normalizeToolState, recordPull, applyToggle,
  toolView, claudeToolRules, normalizeAccess, claudePermissionMode, codexSandbox,
} from './claude-tools.mjs'

const INIT = {
  type: 'system', subtype: 'init',
  tools: ['Bash', 'Read', 'mcp__claude_ai_Microsoft_365__outlook_email_search', 'mcp__claude_ai_Microsoft_365__outlook_send_mail', 'mcp__claude_ai_Plaud_Web_MCP__list_files', 'mcp__plugin_cloudflare_cloudflare-docs__search'],
  mcp_servers: [
    { name: 'claude.ai Microsoft 365', status: 'connected', source: 'claudeai' },
    { name: 'claude.ai Plaud Web MCP', status: 'connected', source: 'claudeai' },
    { name: 'plugin:cloudflare:cloudflare-docs', status: 'connected', source: 'plugin' },
    { name: 'totem-gateway', status: 'pending', source: 'user' },
  ],
}

function pulled() {
  return recordPull(normalizeToolState({}), 'claude', parseInitEvent(INIT), new Date('2026-10-06T12:00:00Z'))
}

test('server names map to the prefixes Claude Code gives their tools', () => {
  assert.equal(serverPrefix('claude.ai Microsoft 365'), 'claude_ai_Microsoft_365')
  assert.equal(serverPrefix('plugin:cloudflare:cloudflare-docs'), 'plugin_cloudflare_cloudflare-docs')
  assert.equal(serverPrefix('totem-gateway'), 'totem-gateway')
})

test('the init event becomes servers with their tools; built-in tools are left out', () => {
  const { servers } = parseInitEvent(INIT)
  const m365 = servers.find((s) => s.prefix === 'claude_ai_Microsoft_365')
  assert.deepEqual(m365.tools, ['outlook_email_search', 'outlook_send_mail'])
  assert.equal(servers.find((s) => s.name === 'totem-gateway').tools.length, 0)
  assert.equal(parseInitEvent({ type: 'result' }), null)
})

test('a fresh install has no rules at all', () => {
  assert.deepEqual(claudeToolRules(normalizeToolState({})), { allow: [], deny: [] })
})

test('every server pulled is allowed whole, including one still connecting', () => {
  const rules = claudeToolRules(pulled())
  assert.ok(rules.allow.includes('mcp__claude_ai_Microsoft_365'))
  assert.ok(rules.allow.includes('mcp__totem-gateway'))
  assert.deepEqual(rules.deny, [])
})

test('switching a server off denies it and stops allowing it', () => {
  const s = applyToggle(pulled(), { server: 'claude.ai Microsoft 365', enabled: false })
  const rules = claudeToolRules(s)
  assert.ok(rules.deny.includes('mcp__claude_ai_Microsoft_365'))
  assert.ok(!rules.allow.includes('mcp__claude_ai_Microsoft_365'))
  assert.equal(toolView(s).servers.find((x) => x.prefix === 'claude_ai_Microsoft_365').enabledCount, 0)
})

test('switching one tool off denies just that tool', () => {
  const s = applyToggle(pulled(), { server: 'claude.ai Microsoft 365', tool: 'outlook_send_mail', enabled: false })
  const rules = claudeToolRules(s)
  assert.deepEqual(rules.deny, ['mcp__claude_ai_Microsoft_365__outlook_send_mail'])
  assert.ok(rules.allow.includes('mcp__claude_ai_Microsoft_365'))
})

test('one tool back on inside a switched-off server keeps the rest off', () => {
  let s = applyToggle(pulled(), { server: 'claude.ai Microsoft 365', enabled: false })
  s = applyToggle(s, { server: 'claude.ai Microsoft 365', tool: 'outlook_email_search', enabled: true })
  const rules = claudeToolRules(s)
  assert.deepEqual(rules.deny, ['mcp__claude_ai_Microsoft_365__outlook_send_mail'])
  assert.ok(rules.allow.includes('mcp__claude_ai_Microsoft_365'))
})

test('all off and all on', () => {
  const off = applyToggle(pulled(), { all: true, enabled: false })
  assert.equal(claudeToolRules(off).allow.length, 0)
  assert.equal(claudeToolRules(off).deny.length, 4)
  const on = applyToggle(off, { all: true, enabled: true })
  assert.deepEqual(claudeToolRules(on).deny, [])
})

test('a failed pull keeps the servers the last good one found', () => {
  const s = recordPull(pulled(), 'claude', { error: 'not logged in' })
  assert.equal(s.accounts.claude.error, 'not logged in')
  assert.equal(s.accounts.claude.servers.length, 4)
  assert.equal(s.accounts.claude.pulledAt, '2026-10-06T12:00:00.000Z')
})

test('the stored file survives junk', () => {
  const s = normalizeToolState({ accounts: { 'bad id!': {}, claude: { servers: [{ name: 5 }, { name: 'x', tools: ['a', 'a', 7] }] } }, disabled: { tools: 'nope' } })
  assert.deepEqual(Object.keys(s.accounts), ['claude'])
  assert.deepEqual(s.accounts.claude.servers[0].tools, ['a'])
  assert.deepEqual(s.disabled, { servers: [], tools: [] })
})

test('access modes: Full access by default, and what each means per CLI', () => {
  assert.equal(normalizeAccess(undefined), 'full')
  assert.equal(normalizeAccess('bogus'), 'full')
  assert.equal(claudePermissionMode('full'), 'bypassPermissions')
  assert.equal(claudePermissionMode('edits'), 'acceptEdits')
  assert.equal(claudePermissionMode('supervised'), null)
  assert.equal(codexSandbox('supervised'), 'read-only')
  assert.equal(codexSandbox('full'), 'danger-full-access')
  assert.equal(codexSandbox('edits'), null)
})

test('the probe reads the init line and kills the process', async () => {
  let killed = false
  const fake = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => { killed = true }
    setImmediate(() => child.stdout.write(`{"type":"system","subtype":"hook"}\n${JSON.stringify(INIT)}\n`))
    return child
  }
  const out = await probeClaudeTools({ cli: 'claude', spawnFn: fake })
  assert.equal(out.servers.length, 4)
  assert.ok(killed)
})

test('the probe fails with stderr when Claude exits first', async () => {
  const fake = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    setImmediate(() => { child.stderr.write('Invalid API key'); setImmediate(() => child.emit('close', 1)) })
    return child
  }
  await assert.rejects(probeClaudeTools({ cli: 'claude', spawnFn: fake }), /Invalid API key/)
})
