import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClaudeAuthStatus } from './claude-auth.mjs'

test('a signed-in account is ready even when loginExpiresAt has passed', () => {
  const out = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    subscriptionType: 'team',
    loginExpiresAt: '2020-01-01T00:00:00.000Z',
  })
  assert.deepEqual(parseClaudeAuthStatus(out), { state: 'ready', detail: 'team plan, claude.ai login' })
})

test('loggedIn false is signed out', () => {
  assert.equal(parseClaudeAuthStatus('{"loggedIn": false}').state, 'logged-out')
})

test('anything that is not the status JSON falls back', () => {
  assert.equal(parseClaudeAuthStatus(''), null)
  assert.equal(parseClaudeAuthStatus("error: unknown command 'auth'"), null)
  assert.equal(parseClaudeAuthStatus('{"something": 1}'), null)
  assert.equal(parseClaudeAuthStatus('null'), null)
})
