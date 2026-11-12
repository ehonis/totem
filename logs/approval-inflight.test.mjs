// Run with: node --test logs/approval-inflight.test.mjs
//
// An accepted action cut off by a restart must end as `uncertain`. A failure can
// mean it stays open and is accepted again (a second email), or is reported as
// failed and retried.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInflightLedger, settleInboxLine, settleLeftovers, UNCERTAIN_NOTE } from './approval-inflight.mjs'

async function fileIn() {
  return join(await mkdtemp(join(tmpdir(), 'totem-inflight-')), 'approval-inflight.json')
}

test('an action begun and never ended is handed back after a simulated restart', async () => {
  const file = await fileIn()
  const before = createInflightLedger({ file, bootId: 'boot-1' })
  await before.begin({ key: 'P7', id: 'P7', kind: 'email', action: 'accept', title: 'Email Sam: plans' })
  await before.begin({ key: 'P8', id: 'P8', kind: 'imessage', action: 'accept', title: 'Message Ana' })
  await before.end('P8')
  // Still running in this process: not a leftover.
  assert.deepEqual(await before.leftovers(), [])

  // The process dies here. A new one starts on the same file.
  const after = createInflightLedger({ file, bootId: 'boot-2' })
  const left = await after.leftovers()
  assert.deepEqual(left.map((e) => [e.id, e.kind, e.phase]), [['P7', 'email', 'accepting']])
  // Reading does not clear it: only settling does.
  assert.equal((await after.leftovers()).length, 1)
})

test('a new attempt cannot replace an unsettled leftover for the same proposal', async () => {
  const file = await fileIn()
  await createInflightLedger({ file, bootId: 'old' }).begin({ key: 'P7', id: 'P7', kind: 'email', action: 'accept' })
  const now = createInflightLedger({ file, bootId: 'new' })
  await assert.rejects(() => now.begin({ key: 'P7', id: 'P7', kind: 'email', action: 'accept' }), { status: 409, message: /check before retrying/ })
  assert.deepEqual((await now.leftovers()).map((e) => e.bootId), ['old'])
})

test('settling marks each line before clearing it, and a crash part way leaves the rest for next boot', async () => {
  const file = await fileIn()
  const old = createInflightLedger({ file, bootId: 'old' })
  await old.begin({ key: 'P3:run', id: 'P3', kind: 'command', action: 'accept', phase: 'running' })
  await old.begin({ key: 'P4', id: 'P4', kind: 'email', action: 'accept' })
  const order = []
  const ledger = createInflightLedger({ file, bootId: 'new' })
  await assert.rejects(() => settleLeftovers({
    ledger, today: '2026-10-30',
    settleLine: async (id, note) => { order.push(`line ${id}`); assert.match(note, /^uncertain 2026-10-30: /); if (id === 'P4') throw new Error('disk full') },
    record: (entry) => order.push(`log ${entry.id}`),
  }), /disk full/)
  // P3 was settled and cleared; P4's line was never written, so it is still there.
  assert.deepEqual(order, ['line P3', 'log P3', 'line P4'])
  assert.deepEqual((await ledger.leftovers()).map((e) => e.id), ['P4'])

  const settled = await settleLeftovers({ ledger, today: '2026-10-30', settleLine: async () => {}, record: () => {} })
  assert.deepEqual(settled.map((e) => e.id), ['P4'])
  assert.deepEqual(await ledger.leftovers(), [])
  assert.match(UNCERTAIN_NOTE, /check before retrying/)
})

test('an open inbox line ends as uncertain, not failed and not left open', () => {
  const text = [
    '- [ ] P1 | todo | Buy milk | src: journal',
    '- [ ] P12 | email | Email Sam: plans | account: work | email: inbox-prompts/P12.email.json',
    '',
  ].join('\n')
  const note = `uncertain 2026-10-30: ${UNCERTAIN_NOTE}`
  const next = settleInboxLine(text, 'P12', note)
  const lines = next.split('\n')
  assert.equal(lines[0], '- [ ] P1 | todo | Buy milk | src: journal')
  assert.equal(lines[1], `- [x] P12 | email | Email Sam: plans | account: work | email: inbox-prompts/P12.email.json | ${note}`)
  assert.match(lines[1], /check before retrying/)
  // P1 is not P12's prefix match, and an unknown id changes nothing.
  assert.equal(settleInboxLine(text, 'P1', 'x').split('\n')[1], text.split('\n')[1])
  assert.equal(settleInboxLine(text, 'P99', 'x'), null)
})

test('a resolved line (a command already marked running) gets the note appended', () => {
  const text = '- [x] P3 | command | Rebuild | command: inbox-prompts/P3.sh | confirmed 2026-10-30 → running, output P3'
  assert.equal(settleInboxLine(text, 'P3', 'uncertain 2026-10-30: check'), `${text} | uncertain 2026-10-30: check`)
})
