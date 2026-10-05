// Run with: node --test ai/install.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installMarkerPaths, isExistingInstall } from './install.mjs'

test('a checkout with nothing in data/ is a fresh install', () => {
  const root = mkdtempSync(join(tmpdir(), 'totem-install-'))
  assert.equal(isExistingInstall(root, { env: {} }), false)
})

test('the default data/ files mark an existing install', () => {
  const root = mkdtempSync(join(tmpdir(), 'totem-install-'))
  mkdirSync(join(root, 'data'))
  writeFileSync(join(root, 'data', 'todos.db'), '')
  assert.equal(isExistingInstall(root, { env: {} }), true)
})

test('overridden paths are where it looks, and the defaults are not', () => {
  const root = mkdtempSync(join(tmpdir(), 'totem-install-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'totem-elsewhere-'))
  const env = {
    TODO_DATABASE_FILE: join(elsewhere, 'tasks.sqlite'),
    PROVIDER_CONFIG_FILE: join(elsewhere, 'providers.json'),
    AI_USAGE_CONFIG: join(elsewhere, 'usage.json'),
  }
  assert.ok(installMarkerPaths(root, env).includes(env.TODO_DATABASE_FILE))
  assert.equal(isExistingInstall(root, { env }), false)
  writeFileSync(env.PROVIDER_CONFIG_FILE, '{}')
  assert.equal(isExistingInstall(root, { env }), true)

  // A stray default file does not count when the install keeps that file elsewhere.
  const root2 = mkdtempSync(join(tmpdir(), 'totem-install-'))
  mkdirSync(join(root2, 'data'))
  writeFileSync(join(root2, 'data', 'todos.db'), '')
  assert.equal(isExistingInstall(root2, { env: { TODO_DATABASE_FILE: join(elsewhere, 'none.db') } }), false)
})
