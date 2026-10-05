// Run with: node --test todos/venture-tags.test.mjs
//
// Venture tags are the install's own list, not a fixed one. A fresh install has
// none; the owner adds, renames, recolours and removes them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openTodoDatabase } from './db.mjs'
import { createTodoService } from './service.mjs'

function fresh() {
  const db = openTodoDatabase({ file: join(mkdtempSync(join(tmpdir(), 'totem-vt-')), 'todos.db') })
  const audits = []
  const service = createTodoService({ db, actionLog: { record: (e) => audits.push(e) } })
  return { db, service, audits }
}

test('a fresh install has no venture tags, so a Ventures task is refused with a pointer', () => {
  const { service } = fresh()
  assert.deepEqual(service.listVentureTags(), [])
  assert.throws(() => service.create({ title: 'x', area: 'Ventures', ventureTag: 'Acme' }), {
    code: 'INVALID_VENTURE_TAG', message: /No venture tags are configured/,
  })
  assert.equal(service.create({ title: 'personal' }).area, 'Personal')
})

test('configured tags are accepted, case-folded to their configured spelling, and audited', () => {
  const { service, audits } = fresh()
  service.saveVentureTags([{ name: 'Acme', color: '#112233' }, { name: 'Globex' }])
  assert.deepEqual(service.listVentureTags(), [{ name: 'Acme', color: '#112233' }, { name: 'Globex', color: null }])
  assert.equal(service.create({ title: 'x', area: 'Ventures', ventureTag: 'acme' }).ventureTag, 'Acme')
  assert.throws(() => service.create({ title: 'y', area: 'Ventures', ventureTag: 'Initech' }), /one of: Acme, Globex/)
  assert.ok(audits.some((a) => a.action === 'todo.venture_tags.update'))
})

test('renaming a tag moves every task that carries it', () => {
  const { service } = fresh()
  service.saveVentureTags([{ name: 'Acme' }])
  const task = service.create({ title: 'x', area: 'Ventures', ventureTag: 'Acme' })
  service.saveVentureTags([{ name: 'Acme Corp', previousName: 'Acme' }])
  assert.equal(service.get(task.id).ventureTag, 'Acme Corp')
})

test('a tag still in use cannot be removed; an unused one can', () => {
  const { service } = fresh()
  service.saveVentureTags([{ name: 'Acme' }, { name: 'Globex' }])
  service.create({ title: 'x', area: 'Ventures', ventureTag: 'Acme' })
  assert.throws(() => service.saveVentureTags([{ name: 'Globex' }]), { code: 'VENTURE_TAG_IN_USE' })
  assert.deepEqual(service.saveVentureTags([{ name: 'Acme' }]).map((t) => t.name), ['Acme'])
})

test('a task keeps a tag that later left the list, but cannot switch to an unknown one', () => {
  const { db, service } = fresh()
  service.saveVentureTags([{ name: 'Acme' }])
  const task = service.create({ title: 'x', area: 'Ventures', ventureTag: 'Acme' })
  // Simulate a list edited elsewhere (e.g. a restore) that no longer has Acme.
  db.prepare("UPDATE todo_preferences SET value_json = '[]' WHERE key = 'ventureTags'").run()
  assert.equal(service.update(task.id, { title: 'renamed' }).ventureTag, 'Acme')
  assert.throws(() => service.update(task.id, { ventureTag: 'Other' }), { code: 'INVALID_VENTURE_TAG' })
})

test('bad lists are refused whole', () => {
  const { service } = fresh()
  assert.throws(() => service.saveVentureTags([{ name: 'A' }, { name: 'a' }]), /unique/)
  assert.throws(() => service.saveVentureTags([{ name: '' }]), /needs a name/)
  assert.throws(() => service.saveVentureTags([{ name: 'A', color: 'red' }]), /invalid color/)
  assert.throws(() => service.saveVentureTags('A'), /must be an array/)
  assert.deepEqual(service.listVentureTags(), [])
})

test('swapping two tag names swaps their tasks, not merges them', () => {
  const { service } = fresh()
  service.saveVentureTags([{ name: 'Acme' }, { name: 'Globex' }])
  const a = service.create({ title: 'a', area: 'Ventures', ventureTag: 'Acme' })
  const g = service.create({ title: 'g', area: 'Ventures', ventureTag: 'Globex' })
  service.saveVentureTags([{ name: 'Globex', previousName: 'Acme' }, { name: 'Acme', previousName: 'Globex' }])
  assert.equal(service.get(a.id).ventureTag, 'Globex')
  assert.equal(service.get(g.id).ventureTag, 'Acme')
})

test('a chain A->B, B->C moves each tag one step, not A all the way to C', () => {
  const { service } = fresh()
  service.saveVentureTags([{ name: 'Acme' }, { name: 'Globex' }])
  const a = service.create({ title: 'a', area: 'Ventures', ventureTag: 'Acme' })
  const g = service.create({ title: 'g', area: 'Ventures', ventureTag: 'Globex' })
  service.saveVentureTags([{ name: 'Globex', previousName: 'Acme' }, { name: 'Initech', previousName: 'Globex' }])
  assert.equal(service.get(a.id).ventureTag, 'Globex')
  assert.equal(service.get(g.id).ventureTag, 'Initech')
  assert.deepEqual(service.listVentureTags().map((t) => t.name), ['Globex', 'Initech'])
})

test('one tag cannot be renamed to two names at once', () => {
  const { service } = fresh()
  service.saveVentureTags([{ name: 'Acme' }])
  assert.throws(() => service.saveVentureTags([{ name: 'B', previousName: 'Acme' }, { name: 'C', previousName: 'Acme' }]), /only be renamed to one/)
})
