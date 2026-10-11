// node --test chat/reach.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatReach, limitReach, reachRules, browserRules, WORK_RULES, COMPUTER_RULES } from './reach.mjs'
import { createBrowserManager } from '../browser/manager.mjs'
import { callBrowserTool, browserToolDescriptors } from '../browser/tools.mjs'

test('a dashboard or app chat gets the browser, the long budget, and computer use where the account has it', () => {
  const codex = chatReach({ channel: 'web', driver: 'codex', browserReady: true, computerUseAvailable: true })
  assert.deepEqual({ browser: codex.browser, computerUse: codex.computerUse, longBudget: codex.longBudget }, { browser: true, computerUse: true, longBudget: true })

  // Other accounts simply have no computer use: no error, no switch to Codex.
  for (const driver of ['claude', 'cursor', 'opencode']) {
    const r = chatReach({ channel: 'web', driver, browserReady: true, computerUseAvailable: true })
    assert.equal(r.computerUse, false, driver)
    assert.equal(r.browser, true, driver)
    assert.equal(r.longBudget, true, driver)
  }
  // Codex whose probe found no desktop tools (Linux) has none either.
  assert.equal(chatReach({ channel: 'web', driver: 'codex', browserReady: true, computerUseAvailable: false }).computerUse, false)
  // No Chromium installed (or BROWSER_ENABLED=false): no browser, still the long budget.
  const bare = chatReach({ channel: 'web', driver: 'claude', browserReady: false })
  assert.equal(bare.browser, false)
  assert.equal(bare.longBudget, true)
})

test('voice turns, the phone shortcut and jobs get none of it', () => {
  const all = { driver: 'codex', browserReady: true, computerUseAvailable: true, body: { mode: 'computer', browser: true } }
  for (const r of [chatReach({ ...all, channel: 'web', voice: true }), chatReach({ ...all, channel: 'http' }), chatReach({ ...all, channel: 'job' })]) {
    assert.equal(r.browser, false)
    assert.equal(r.computerUse, false)
    assert.equal(r.longBudget, false)
    assert.deepEqual(r.asked, { browser: false, computer: false })
  }
})

test("older clients' mode and browser fields are hints, never errors", () => {
  const base = { channel: 'web', driver: 'codex', browserReady: true, computerUseAvailable: true }
  for (const body of [{}, { mode: 'chat' }, { mode: 'task' }, { mode: 'computer' }, { mode: 'nonsense' }, { browser: true }, { browser: 'yes' }, null]) {
    const r = chatReach({ ...base, body })
    assert.equal(r.browser, true)
    assert.equal(r.computerUse, true)
    assert.equal(r.longBudget, true)
  }
  assert.deepEqual(chatReach({ ...base, body: { mode: 'computer', browser: true } }).asked, { browser: true, computer: true })
  assert.deepEqual(chatReach({ ...base, body: { mode: 'task' } }).asked, { browser: false, computer: false })
  // A computer toggle on an account without computer use is not a hint about something absent.
  assert.equal(chatReach({ ...base, driver: 'claude', body: { mode: 'computer' } }).asked.computer, false)
})

test('runAgent never hands the phone shortcut a browser, and never runs computer use', () => {
  const browser = { token: 't', url: 'http://127.0.0.1:1/agent-mcp' }
  assert.deepEqual(limitReach('http', { timeoutMs: 5, browser, features: ['computer_use'] }), { timeoutMs: 5 })
  // A totem whose own switch granted the browser keeps it; computer use is still dropped.
  assert.deepEqual(limitReach('job', { browser, features: ['computer_use'], network: true }), { browser, network: true })
  assert.deepEqual(limitReach('job', { browser: null }), {})
})

test('the prompt leaves the decision to the agent, and asks when unsure', () => {
  assert.equal(reachRules({}), '')
  const both = reachRules({ browser: true, computerUse: true })
  assert.match(both, /a browser and this computer's desktop/)
  assert.match(both, /not by default/)
  assert.match(both, /Prefer an API/)
  assert.match(both, /ask him first in one short question/)
  assert.match(reachRules({ browser: true }), /drive the browser for this/)
  assert.doesNotMatch(reachRules({ browser: true }), /desktop/)
  assert.match(reachRules({ computerUse: true }), /drive the desktop for this/)
  assert.match(reachRules({ browser: true, asked: { browser: true } }), /turned the browser on for this message/)
  assert.doesNotMatch(browserRules('totem-browser'), /asked for the browser/)
  assert.match(WORK_RULES, /end to end/)
  assert.match(COMPUTER_RULES, /Never type a password/)
})

test('offering the browser costs nothing: Chromium starts on the first tool call that needs a page', async () => {
  let launches = 0
  const loadPlaywright = async () => ({ chromium: { launch: async () => { launches++; throw new Error('no real browser in this test') } } })
  const manager = createBrowserManager({ executablePath: '/bin/true', loadPlaywright })
  // What a run does just by being offered it: the CLI connects and lists the tools.
  assert.equal(manager.available(), true)
  assert.ok(browserToolDescriptors().length > 5)
  assert.deepEqual(manager.sessionKeys(), [])
  const status = await callBrowserTool(manager, 'preview_status', {}, { key: 'thread-a' })
  assert.equal(status.structuredContent.visible, false)
  assert.equal(launches, 0)
  // The agent decides to open a page: now it launches.
  const opened = await callBrowserTool(manager, 'preview_open', { url: 'https://example.com' }, { key: 'thread-a' })
  assert.ok(opened.isError)
  assert.equal(launches, 1)
})
