import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSkillFile, serializeSkillFile, renderSkillBody, skillVariables } from './format.mjs'

test('parses frontmatter and body', () => {
  const { meta, body } = parseSkillFile([
    '---',
    'name: Plaud action items ingest',
    'description: Mine meetings into proposals.',
    'icon: inbox',
    'command: $plaud-meetings',
    'requires: [plaud]',
    '---',
    '',
    'GOAL: scan recent meetings.',
    '',
    'STEP 1 — list files.',
  ].join('\n'))
  assert.equal(meta.name, 'Plaud action items ingest')
  assert.equal(meta.command, '$plaud-meetings')
  assert.deepEqual(meta.requires, ['plaud'])
  assert.match(body, /^GOAL: scan recent meetings\./)
  assert.match(body, /STEP 1/)
})

test('parses the block list form', () => {
  const { meta } = parseSkillFile('---\nrequires:\n  - plaud\n  - todoist\nname: X\n---\nbody')
  assert.deepEqual(meta.requires, ['plaud', 'todoist'])
  assert.equal(meta.name, 'X')
})

test('a file with no frontmatter is a body-only skill, not an error', () => {
  const { meta, body } = parseSkillFile('just a bare prompt')
  assert.deepEqual(meta, {})
  assert.equal(body, 'just a bare prompt')
})

test('round-trips through serialize', () => {
  const meta = { name: 'A: tricky name', description: 'has, commas', icon: 'sun', requires: ['plaud'] }
  const body = 'Do the thing.\n\nThen the other thing.'
  const reparsed = parseSkillFile(serializeSkillFile(meta, body))
  assert.deepEqual(reparsed.meta, meta)
  assert.equal(reparsed.body, body)
})

test('serialize quotes values that would break the parser', () => {
  // An unquoted "A: tricky" would parse back with the value truncated at the colon.
  const text = serializeSkillFile({ name: 'A: tricky name' }, 'x')
  assert.match(text, /name: "A: tricky name"/)
})

test('booleans survive the round trip', () => {
  const { meta } = parseSkillFile(serializeSkillFile({ name: 'X', enabled: false }, 'b'))
  assert.equal(meta.enabled, false)
})

test('fills placeholders', () => {
  const { text, missing } = renderSkillBody('Now is {{now}}. Read {{inboxFile}}.', {
    now: 'Monday', inboxFile: '/data/inbox.md',
  })
  assert.equal(text, 'Now is Monday. Read /data/inbox.md.')
  assert.deepEqual(missing, [])
})

test('an unknown placeholder renders empty and is reported', () => {
  const { text, missing } = renderSkillBody('Read {{inboxFle}} now.', { inboxFile: '/x' })
  assert.equal(text, 'Read  now.')
  assert.deepEqual(missing, ['inboxFle'])
})

test('{{#x}} keeps its block only when x has a value', () => {
  const body = 'Consider recordings{{#since}} after {{since}}{{/since}}.'
  assert.equal(renderSkillBody(body, { since: '2026-08-01' }).text, 'Consider recordings after 2026-08-01.')
  assert.equal(renderSkillBody(body, { since: null }).text, 'Consider recordings.')
})

test('{{^x}} is the otherwise branch', () => {
  const body = '{{#since}}after {{since}}{{/since}}{{^since}}in the last 24 hours{{/since}}'
  assert.equal(renderSkillBody(body, { since: '2026-08-01' }).text, 'after 2026-08-01')
  assert.equal(renderSkillBody(body, { since: '' }).text, 'in the last 24 hours')
})

test('a dropped conditional does not report its inner variables as missing', () => {
  const { missing } = renderSkillBody('{{#since}}after {{since}}{{/since}}', { since: null })
  assert.deepEqual(missing, [])
})

test('an empty array is falsy for conditionals', () => {
  const body = '{{#items}}some{{/items}}{{^items}}none{{/items}}'
  assert.equal(renderSkillBody(body, { items: [] }).text, 'none')
  assert.equal(renderSkillBody(body, { items: ['a'] }).text, 'some')
})

test('arrays render one per line', () => {
  assert.equal(renderSkillBody('{{list}}', { list: ['a', 'b'] }).text, 'a\nb')
})

test('skillVariables reports every referenced name once', () => {
  assert.deepEqual(
    skillVariables('{{now}} {{#since}}{{since}}{{/since}} {{now}}').sort(),
    ['now', 'since'],
  )
})

test('an unclosed section marker does not leak into the prompt', () => {
  const { text } = renderSkillBody('before {{#oops}} after', { oops: true })
  assert.equal(text, 'before  after')
})
