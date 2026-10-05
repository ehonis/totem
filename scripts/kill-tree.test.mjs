import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { descendants, killTree } from './kill-tree.mjs'

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

test('killTree takes a grandchild in its own session with it', { skip: process.platform !== 'linux' }, async () => {
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
