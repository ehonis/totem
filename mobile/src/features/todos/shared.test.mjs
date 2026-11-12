// The task list's logic is one copy shared with the web (#215): web/src/todos/
// {types,board,format,parse}.ts, mirrored byte for byte to mobile/src/lib/todos/.
// Their behaviour is tested once, on the web (web/src/todos/*.test.ts); this file
// checks that the copies have not drifted, that node loads the app's copies with no
// React Native or DOM, and that the app's old paths hand out the shared functions.
// Run with `node --test mobile/src/features/todos/*.test.mjs` (also in the root npm test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as libBoard from '../../lib/todos/board.ts'
import * as libFormat from '../../lib/todos/format.ts'
import * as libParse from '../../lib/todos/parse.ts'
import * as appBoard from './board.ts'
import * as appFormat from './format.ts'
import * as appParse from './compose/parse.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path) => readFileSync(join(repo, path), 'utf8')
const SHARED = ['types.ts', 'board.ts', 'format.ts', 'parse.ts']

test('the shared task files are the web’s, byte for byte', () => {
  for (const name of SHARED) {
    assert.equal(read(`mobile/src/lib/todos/${name}`), read(`web/src/todos/${name}`), `mobile/src/lib/todos/${name} has drifted from web/src/todos/${name}`)
  }
})

test('the shared modules import nothing but each other', () => {
  for (const name of SHARED) {
    const source = read(`web/src/todos/${name}`)
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm),
      // A side-effect import (`import 'x'`) has no `from`.
      ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1])
    for (const specifier of specifiers) assert.match(specifier, /^\.\/(types|board|format|parse)(\.ts)?$/, `${name} imports ${specifier}`)
    assert.doesNotMatch(source, /\bimport\s*\(/, `${name} has a dynamic import()`)
    assert.doesNotMatch(source, /\brequire\s*\(/, `${name} calls require()`)
  }
})

test('node loads the app’s copies and they answer', () => {
  const now = new Date(2026, 10, 4, 10)
  const list = libBoard.buildList([], [{ id: 'sheet:0:5:00000000', row: 5, title: 'Row', who: 'Alex', priority: 1, status: 'Not Started', dueDate: '2026-11-04', notes: '', url: 'https://example.test' }], { now })
  assert.deepEqual(list.sections.map((section) => section.key), ['today'])
  assert.equal(libFormat.dueText('2026-11-05', now), 'Tomorrow')
  assert.equal(libParse.parseQuickAdd('Call the bank tomorrow p2', { now }).dueDate, '2026-11-05')
})

test('the app’s old paths re-export the shared functions, not copies', () => {
  for (const [name, value] of Object.entries(libFormat)) assert.equal(appFormat[name], value, `features/todos/format.ts ${name}`)
  for (const [name, value] of Object.entries(libParse)) assert.equal(appParse[name], value, `features/todos/compose/parse.ts ${name}`)
  // Nothing of the board is the app's own any more: the Doing-pinned buildBoard went with Doing.
  assert.ok(!Object.keys(appBoard).includes('buildBoard'))
  for (const name of Object.keys(appBoard)) assert.equal(appBoard[name], libBoard[name], `features/todos/board.ts ${name}`)
})
