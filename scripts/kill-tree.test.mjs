import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { AGENT_SPAWN, descendants, killTree } from './kill-tree.mjs'

test('descendants walks the whole tree, odd process names included', () => {
  const proc = mkdtempSync(join(tmpdir(), 'proc-'))
  const add = (pid, comm, ppid) => { mkdirSync(join(proc, String(pid))); writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0`) }
  add(10, 'cursor-agent', 1)
  add(11, 'zsh', 10)
  add(12, 'sleep) (x', 11)
  add(20, 'other', 1)
  assert.deepEqual(descendants(10, { proc }).sort(), [11, 12])
  assert.deepEqual(descendants(20, { proc }), [])
})

test('killTree takes a grandchild in its own session with it', { skip: process.platform === 'win32' }, async () => {
  // The shape cursor-agent leaves behind: a command in a new session under the CLI.
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    const g = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    console.log(g.pid)
    setInterval(() => {}, 1000)
  `])
  const grandchild = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))))
  killTree(child)
  await new Promise((r) => setTimeout(r, 200))
  assert.throws(() => process.kill(grandchild, 0))
})

test('descendants falls back to ps where there is no /proc', { skip: process.platform === 'win32' }, async () => {
  const child = spawn('sleep', ['30'])
  try {
    assert.ok(descendants(process.pid, { proc: '/no/such/proc' }).includes(child.pid))
  } finally { child.kill('SIGKILL') }
})

test('killTree reaches what a dead launcher left holding its pipes, and the run closes', { skip: process.platform === 'win32' }, async () => {
  // The shape npm's `codex` has: a launcher that starts the real binary with
  // inherited stdio. Here the launcher dies first, so the binary is reparented
  // and no longer anyone's descendant, yet still holds our stdout open.
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    const g = spawn('sleep', ['30'], { stdio: 'inherit' })
    console.log(g.pid)
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 100)
  `], { ...AGENT_SPAWN })
  const orphan = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))))
  await new Promise((r) => child.once('exit', r))
  process.kill(orphan, 0) // still running, launcher gone
  const closed = new Promise((r) => child.once('close', r))
  killTree(child)
  await closed
  await new Promise((r) => setTimeout(r, 100))
  assert.throws(() => process.kill(orphan, 0))
})
