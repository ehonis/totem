// The drawer's task badges, a chat's strip and the link sheet read the web's task rules (web/src/work/groups.ts),
// copied byte for byte to mobile/src/lib/work/groups.ts, and the drawer's By task order reads
// web/src/tasksnav/lists.ts, copied to mobile/src/lib/tasksnav/lists.ts (tested on the web too). Their behaviour is tested
// once, on the web (web/src/work/groups.test.ts); this file checks the copy has not
// drifted, imports nothing at run time, and that node loads it as the app does.
// Run with `node --test mobile/src/features/work/*.test.mjs` (also in the root npm test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chatsByTask, dueLabel, fromSheet, fromTodo, resolveRef } from '../../lib/work/groups.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path) => readFileSync(join(repo, path), 'utf8')

test('lib/work/groups.ts is the web’s, byte for byte', () => {
  assert.equal(read('mobile/src/lib/work/groups.ts'), read('web/src/work/groups.ts'), 'mobile/src/lib/work/groups.ts has drifted from web/src/work/groups.ts')
})

test('lib/tasksnav/lists.ts (the drawer\u2019s By task order) is the web\u2019s, byte for byte', () => {
  assert.equal(read('mobile/src/lib/tasksnav/lists.ts'), read('web/src/tasksnav/lists.ts'), 'mobile/src/lib/tasksnav/lists.ts has drifted from web/src/tasksnav/lists.ts')
})

test('it imports only types, so it carries nothing of the web or React Native', () => {
  const source = read('web/src/work/groups.ts')
  for (const m of source.matchAll(/^\s*(import|export)\b([^'"]*?)from\s+['"]([^'"]+)['"]/gm)) {
    assert.match(m[2], /^\s*type\b/, `groups.ts has a value import from ${m[3]}`)
  }
  assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/)
})

const todo = (id, title, extra = {}) => ({
  id, title, status: 'todo', priority: 1, dueDate: null, updatedAt: '2026-11-18T10:00:00Z', folderId: null, ...extra,
})
const chat = (id, taskId, updatedAt) => ({ id, kind: 'regular', taskId, createdAt: updatedAt, updatedAt, messages: [{ id: 'm', role: 'user', content: 'hi', createdAt: updatedAt }] })

test('the app’s copy reads tasks and sheet rows onto one scale, with their chats', () => {
  const tasks = [
    fromTodo(todo('a', 'Call the gym', { folderId: 'f1', dueDate: '2026-11-18' })),
    fromSheet({ id: 'sheet:0:5:abc', title: 'Send the lease', dueDate: null, priority: 1, status: 'In Progress', url: 'https://example.com', folderId: 'p1' }),
  ]
  assert.equal(tasks[1].priority, 4, 'a sheet row’s High is the board’s most urgent')
  const threads = [chat('t1', 'a', 2), chat('t2', 'a', 5), chat('t3', 'sheet:0:9:abc', 3)]
  const linked = chatsByTask(threads, tasks)
  assert.deepEqual(linked.get('a').map((c) => c.id), ['t2', 't1'])
  // A sheet row that moved down the sheet keeps its chats (same tab, same title hash).
  assert.deepEqual(linked.get('sheet:0:5:abc').map((c) => c.id), ['t3'])
  assert.equal(resolveRef('sheet:0:9:abc', tasks), 'sheet:0:5:abc')
})

test('due labels are short enough for a drawer row', () => {
  const now = new Date(2026, 10, 18, 12)
  assert.deepEqual(dueLabel('2026-11-17', now), { text: 'Overdue', tone: 'overdue' })
  assert.deepEqual(dueLabel('2026-11-18T15:00', now), { text: 'Today', tone: 'today' })
  assert.deepEqual(dueLabel('2026-11-19', now), { text: 'Tomorrow', tone: 'soon' })
  assert.equal(dueLabel(null, now), null)
})
