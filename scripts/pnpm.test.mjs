import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NO_PNPM } from './pnpm.mjs'

const SCRIPT = fileURLToPath(new URL('./pnpm.mjs', import.meta.url))

test('with neither pnpm nor corepack on PATH it stops with what to install', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--version'], { env: { PATH: '/nonexistent' }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, new RegExp(NO_PNPM.slice(0, 40).replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')))
})

test('passes its arguments to the pnpm it finds', { skip: spawnSync('pnpm', ['--version']).status !== 0 && 'no pnpm here' }, () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--version'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/)
})
