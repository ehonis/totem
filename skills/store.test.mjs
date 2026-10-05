import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillStore } from './store.mjs'

let root
let dir
let seedDir

async function seedSkill(id, text) {
  await mkdir(join(seedDir, id), { recursive: true })
  await writeFile(join(seedDir, id, 'SKILL.md'), text)
}

const store = () => createSkillStore({ dir, seedDir })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'totem-skills-'))
  dir = join(root, 'data', 'skills')
  seedDir = join(root, 'seeds')
  await mkdir(seedDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('seeds shipped skills on first boot', async () => {
  await seedSkill('daily-brief', '---\nname: Daily brief\nicon: sun\n---\n\nBrief me.')
  const s = store()
  assert.deepEqual(await s.seed(), ['daily-brief'])
  const all = await s.list()
  assert.equal(all.length, 1)
  assert.equal(all[0].name, 'Daily brief')
  assert.equal(all[0].kind, 'seeded')
  assert.equal(all[0].modified, false)
})

test('seeding twice installs nothing the second time', async () => {
  await seedSkill('a', '---\nname: A\n---\nbody')
  const s = store()
  await s.seed()
  assert.deepEqual(await s.seed(), [])
})

test('a seed added later is backfilled without clearing data', async () => {
  await seedSkill('a', '---\nname: A\n---\nbody')
  const s = store()
  await s.seed()
  await seedSkill('b', '---\nname: B\n---\nbody')
  assert.deepEqual(await s.seed(), ['b'])
  assert.equal((await s.list()).length, 2)
})

// The property that makes editing a built-in safe: a deploy cannot revert it.
test('an edited seeded skill is never overwritten by a later seed pass', async () => {
  await seedSkill('a', '---\nname: A\n---\noriginal body')
  const s = store()
  await s.seed()
  await s.update('a', { body: 'my edited body' })
  await s.seed()
  const skill = await s.get('a')
  assert.equal(skill.body, 'my edited body')
  assert.equal(skill.modified, true)
})

test('reset restores the shipped default', async () => {
  await seedSkill('a', '---\nname: A\n---\noriginal body')
  const s = store()
  await s.seed()
  await s.update('a', { body: 'edited', name: 'Renamed' })
  const result = await s.reset('a')
  assert.equal(result.ok, true)
  const skill = await s.get('a')
  assert.equal(skill.body, 'original body')
  assert.equal(skill.name, 'A')
  assert.equal(skill.modified, false)
})

test('reset refuses for a skill with no shipped default', async () => {
  const s = store()
  const created = await s.create({ name: 'Mine', body: 'x' })
  const result = await s.reset(created.id)
  assert.equal(result.ok, false)
  assert.match(result.error, /no shipped default/)
})

// The other half of "nothing is locked": a built-in you delete stays deleted.
test('a deleted seeded skill is not resurrected by the next boot', async () => {
  await seedSkill('a', '---\nname: A\n---\nbody')
  const s = store()
  await s.seed()
  assert.equal((await s.remove('a')).ok, true)
  assert.deepEqual(await s.seed(), [])
  assert.equal(await s.get('a'), null)
})

test('a deleted seeded skill can still be brought back deliberately', async () => {
  await seedSkill('a', '---\nname: A\n---\nbody')
  const s = store()
  await s.seed()
  await s.remove('a')
  assert.equal((await s.reset('a')).ok, true)
  assert.equal((await s.get('a')).body, 'body')
})

test('every field of a seeded skill is editable', async () => {
  await seedSkill('a', '---\nname: A\ndescription: old\nicon: sun\ncommand: /a\n---\nbody')
  const s = store()
  await s.seed()
  const updated = await s.update('a', {
    name: 'New name', description: 'new', iconName: 'moon', command: '$b', body: 'new body', requires: ['plaud'],
  })
  assert.equal(updated.name, 'New name')
  assert.equal(updated.description, 'new')
  assert.equal(updated.iconName, 'moon')
  assert.equal(updated.command, '$b')
  assert.equal(updated.body, 'new body')
  assert.deepEqual(updated.requires, ['plaud'])
})

test('renaming does not change the id jobs reference', async () => {
  await seedSkill('plaud-action-items-ingest', '---\nname: Plaud\n---\nbody')
  const s = store()
  await s.seed()
  const updated = await s.update('plaud-action-items-ingest', { name: 'Something else entirely' })
  assert.equal(updated.id, 'plaud-action-items-ingest')
})

test('create derives a slug id and avoids collisions', async () => {
  const s = store()
  const first = await s.create({ name: 'My Skill', body: 'a' })
  const second = await s.create({ name: 'My Skill!', body: 'b' })
  assert.equal(first.id, 'my-skill')
  assert.equal(second.id, 'my-skill-2')
  assert.equal(first.kind, 'user')
})

test('commands are normalized to one leading prefix', async () => {
  const s = store()
  assert.equal((await s.create({ name: 'A', command: 'todos' })).command, '/todos')
  assert.equal((await s.create({ name: 'B', command: '$$morning' })).command, '$morning')
  assert.equal((await s.create({ name: 'C', command: '//week ahead' })).command, '/week-ahead')
})

test('commandMap indexes enabled skills by command', async () => {
  const s = store()
  await s.create({ name: 'A', command: '/a', body: 'x' })
  await s.create({ name: 'B', command: '/b', body: 'y', enabled: false })
  const map = await s.commandMap()
  assert.equal(map.get('/a').name, 'A')
  assert.equal(map.has('/b'), false)
})

test('render fills variables and reports the ones nobody supplied', async () => {
  const s = store()
  const created = await s.create({ name: 'A', body: 'Now is {{now}}, read {{inboxFile}}, miss {{nope}}.' })
  const out = await s.render(created.id, { now: 'Monday', inboxFile: '/i.md' })
  assert.equal(out.text, 'Now is Monday, read /i.md, miss .')
  assert.deepEqual(out.missing, ['nope'])
})

test('render returns null for an unknown skill', async () => {
  assert.equal(await store().render('nope', {}), null)
})

test('variables are listed for the editor', async () => {
  const s = store()
  const created = await s.create({ name: 'A', body: 'x {{now}} y {{stateFile}}' })
  assert.deepEqual((await s.get(created.id)).variables.sort(), ['now', 'stateFile'])
})

test('a hand-edited file with broken frontmatter still loads', async () => {
  const s = store()
  await mkdir(join(dir, 'busted'), { recursive: true })
  await writeFile(join(dir, 'busted', 'SKILL.md'), 'no frontmatter at all, just a prompt')
  const skill = await s.get('busted')
  assert.equal(skill.name, 'busted')
  assert.equal(skill.body, 'no frontmatter at all, just a prompt')
})

test('an edit made in a text editor is picked up without a restart', async () => {
  await seedSkill('a', '---\nname: A\n---\noriginal')
  const s = store()
  await s.seed()
  assert.equal((await s.get('a')).body, 'original')
  // Someone edits the file directly while the bridge is running.
  await writeFile(join(dir, 'a', 'SKILL.md'), '---\nname: A\n---\nchanged on disk')
  assert.equal((await s.get('a')).body, 'changed on disk')
})

test('concurrent updates to one skill do not lose a write', async () => {
  const s = store()
  const created = await s.create({ name: 'A', body: 'x' })
  await Promise.all([
    s.update(created.id, { description: 'one' }),
    s.update(created.id, { iconName: 'moon' }),
  ])
  const skill = await s.get(created.id)
  // Both mutations serialized through the lock, so neither clobbered the other.
  assert.equal(skill.description, 'one')
  assert.equal(skill.iconName, 'moon')
})

test('the body cap is enforced', async () => {
  const s = store()
  const created = await s.create({ name: 'A', body: 'x'.repeat(50_000) })
  assert.equal(created.body.length, 40_000)
})

test('a skill file on disk is readable Markdown, not escaped JSON', async () => {
  const s = store()
  const created = await s.create({ name: 'A', description: 'Does a thing.', body: 'Line one.\n\nLine two.' })
  const text = await readFile(join(dir, created.id, 'SKILL.md'), 'utf8')
  assert.match(text, /^---\n/)
  assert.match(text, /name: A/)
  assert.match(text, /\nLine one\.\n\nLine two\.\n$/)
})
