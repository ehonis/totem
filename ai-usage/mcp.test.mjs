import assert from 'node:assert/strict'
import test from 'node:test'
import { createUsageMcpTools, USAGE_MCP_TOOL_DEFINITIONS } from './mcp.mjs'

const H = 3600_000
const now = Date.UTC(2026, 10, 12, 12)
const SECRET = 'sk-ant-oat01-' + 'q'.repeat(40)
const redact = (s) => String(s).replaceAll(SECRET, '[redacted]')

const account = {
  id: 'claude:proxy:a.json', backend: 'claude', label: 'a.json', displayName: 'Work seat', source: 'cliproxy', plan: 'max',
  state: 'ok', headroomPct: 60, fetchedAt: now, accessToken: SECRET, refreshToken: SECRET, authFile: '/x/.credentials.json',
  meters: [{ key: 'session:', label: '5-hour limit', usedPct: 40, remainingPct: 60, resetsAt: now + H }],
}
const snapshot = { ok: true, updatedAt: now, providers: { claude: 'Claude' }, accounts: [account], pools: [], proxy: { configured: true } }
const samples = [
  { t: now - 3 * H, accountId: account.id, provider: 'claude', source: 'passive', windows: { five_hour: { used: 99, resetAtMs: now - H, windowMinutes: 300 } } },
  { t: now - 2 * H, accountId: account.id, provider: 'claude', source: 'active', windows: { five_hour: { used: 100, resetAtMs: now - H, windowMinutes: 300 } } },
  { t: now - 2 * H, accountId: 'codex:proxy:c.json', provider: 'codex', source: 'passive', windows: { primary: { used: 10, resetAtMs: now + H, windowMinutes: 300 } } },
]

function tools(overrides = {}) {
  const calls = { history: 0 }
  const t = createUsageMcpTools({
    snapshot: async () => snapshot,
    history: async () => { calls.history++; return { supported: true, samples } },
    accounts: () => [account, { id: 'cursor:default', backend: 'cursor', label: 'default', source: 'local' }],
    configured: () => true,
    tz: 'UTC',
    now: () => now,
    redact,
    ...overrides,
  })
  return { t, calls }
}

test('five read-only tools, each with a title and an output schema requiring fetchedAt', () => {
  assert.deepEqual(USAGE_MCP_TOOL_DEFINITIONS.map((d) => d.name), [
    'totem_usage_get_current', 'totem_usage_get_history', 'totem_usage_limit_report', 'totem_usage_forecast', 'totem_usage_plan',
  ])
  for (const d of USAGE_MCP_TOOL_DEFINITIONS) {
    assert.ok(d.title)
    assert.deepEqual(d.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    assert.ok(d.outputSchema.required.includes('fetchedAt'))
    assert.match(d.description, d.name.endsWith('_plan') ? /before scheduling or starting AI work/ : /hitting limits/)
  }
})

test('the forecast and the plan read the snapshot and a week of history, and say when there is none', async () => {
  const { t, calls } = tools()
  const forecast = await t.totem_usage_forecast({ provider: 'claude' })
  assert.deepEqual(forecast.providers.map((p) => p.provider), ['claude'])
  assert.equal(forecast.accounts[0].name, 'Work seat')
  assert.equal(forecast.historyNote, undefined)
  assert.ok(!JSON.stringify(forecast).includes(SECRET))
  const plan = await t.totem_usage_plan({ size: 'small' })
  assert.equal(plan.fits, true)
  assert.equal(plan.best.accountId, account.id)
  assert.equal(calls.history, 1) // one proxy read serves both within a minute

  const { t: none } = tools({ configured: () => false })
  const idle = await none.totem_usage_forecast({})
  assert.match(idle.historyNote, /CLIProxy is not set up.*projected idle/)
  assert.equal(idle.accounts.length, 1)
})

test('the limit report names accounts, counts the capped window once and carries its method', async () => {
  const { t } = tools()
  const out = await t.totem_usage_limit_report({ days: 1 })
  assert.equal(out.supported, true)
  const work = out.accounts.find((a) => a.accountId === account.id)
  assert.equal(work.name, 'Work seat')
  assert.equal(work.windows[0].hits, 1)
  assert.equal(work.windows[0].blockedHours, 2)
  assert.match(out.summary[0], /^Claude \(Work seat\): hit the 5-hour cap once in 0\.1 days of readings \(of the 1 day asked for\), blocked ~2 h/)
  assert.ok(out.method.length >= 4)
  assert.deepEqual(out.noHistory.map((a) => a.accountId), ['cursor:default'])
  const claudeOnly = await t.totem_usage_limit_report({ provider: 'claude' })
  assert.deepEqual(claudeOnly.accounts.map((a) => a.provider), ['claude'])
})

test('history is read from the proxy once a minute however many tools ask', async () => {
  const { t, calls } = tools()
  await t.totem_usage_limit_report({})
  const out = await t.totem_usage_get_history({ accountId: account.id })
  assert.equal(calls.history, 1)
  assert.equal(out.supported, true)
  assert.deepEqual(out.accounts.map((a) => a.accountId), [account.id])
  assert.equal(out.range.days, 7)
})

test('no proxy, an old proxy or a failing one answers "no history", with a reason and no secret', async () => {
  const off = await tools({ configured: () => false }).t.totem_usage_limit_report({})
  assert.equal(off.supported, false)
  assert.match(off.reason, /not set up/)
  const old = await tools({ history: async () => ({ supported: false, samples: [] }) }).t.totem_usage_get_history({})
  assert.match(old.reason, /keeps no quota history/)
  const failing = await tools({ history: async () => { throw new Error(`401 for ${SECRET}`) } }).t.totem_usage_limit_report({})
  assert.equal(failing.supported, false)
  assert.doesNotMatch(JSON.stringify(failing), /sk-ant/)
})

test('no output carries a token, a credential path or a raw credential field', async () => {
  const { t } = tools({ snapshot: async () => ({ ...snapshot, accounts: [{ ...account, state: 'error', error: `Bearer ${SECRET}` }] }) })
  const all = JSON.stringify([
    await t.totem_usage_get_current({}),
    await t.totem_usage_get_history({ days: 21 }),
    await t.totem_usage_limit_report({ days: 21 }),
  ])
  assert.doesNotMatch(all, /sk-ant|credentials\.json|accessToken|refreshToken|authFile|auth_index/)
  assert.match(all, /Work seat/)
})

test('a poller that is down says so instead of reporting 0%', async () => {
  const { t } = tools({ snapshot: async () => ({ ok: false, error: 'AI usage polling is unavailable (boom)', accounts: [] }) })
  const out = await t.totem_usage_get_current({})
  assert.deepEqual(out.accounts, [])
  assert.match(out.error, /unavailable/)
})
