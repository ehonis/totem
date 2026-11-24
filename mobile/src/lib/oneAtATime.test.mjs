import test from 'node:test'
import assert from 'node:assert/strict'
import { oneAtATime } from './oneAtATime.ts'

function gated() {
  const runs = []
  const task = () => new Promise((resolve) => { runs.push(resolve) })
  return { runs, task }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

test('a call while one is out waits for it, then runs once for everyone who called meanwhile', async () => {
  const { runs, task } = gated()
  const sync = oneAtATime(task)
  const first = sync()
  const second = sync()
  const third = sync()
  assert.equal(second, third)
  assert.equal(runs.length, 1)
  runs[0]()
  await first
  await settle()
  assert.equal(runs.length, 2)
  runs[1]()
  await Promise.all([second, third])
  assert.equal(runs.length, 2)
  // Idle again: the next call runs at once.
  const fourth = sync()
  assert.equal(runs.length, 3)
  runs[2]()
  await fourth
})

test('a run that fails does not stop the next', async () => {
  let n = 0
  const sync = oneAtATime(async () => { n++; if (n === 1) throw new Error('down') })
  const a = sync()
  const b = sync()
  await a
  await b
  assert.equal(n, 2)
})
