import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeTodoDatabase, openTodoDatabase } from '../todos/db.mjs';
import { createTodoService } from '../todos/service.mjs';
import { createListService } from './service.mjs';
import { seedVentureTags } from '../todos/test-support.mjs';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'totem-lists-'));
  const db = openTodoDatabase({ file: join(dir, 'todos.db'), now: () => '2026-09-17T12:00:00.000Z' });
  seedVentureTags(db);
  let next = 0;
  const events = [];
  const service = createListService({
    db, now: () => '2026-09-17T12:00:00.000Z', makeId: () => `id-${++next}`,
    actionLog: { record(event) { events.push(event); } },
  });
  return { db, service, events, close: () => closeTodoDatabase(db) };
}

test('creates a checklist and checks an item', async (t) => {
  const h = harness(); t.after(h.close);
  const { list } = await h.service.createList({ title: 'Groceries', items: ['Milk', { text: 'Eggs', checked: true }] });
  assert.equal(list.title, 'Groceries');
  assert.equal(list.itemCount, 2);
  assert.equal(list.checkedCount, 1);

  const changed = await h.service.updateItem(list.items[0].id, { checked: true });
  assert.equal(changed.list.checkedCount, 2);
  assert.equal(h.events.length, 2);
});

test('todo links are relational and cascade when the task disappears', async (t) => {
  const h = harness(); t.after(h.close);
  h.db.prepare(`
    INSERT INTO todos (id, title, description, area, venture_tag, status, outcome, priority, due_date, recurrence,
      snoozed_until, position, created_at, updated_at, completed_at, archived_at, deleted_at)
    VALUES ('todo-1', 'Visit store', '', 'Personal', NULL, 'todo', NULL, 1, NULL, NULL, NULL, 0,
      '2026-09-17T12:00:00.000Z', '2026-09-17T12:00:00.000Z', NULL, NULL, NULL)
  `).run();
  const { list } = await h.service.createList({ title: 'Groceries' });
  const linked = await h.service.linkTodo(list.id, 'todo-1');
  assert.deepEqual(linked.list.linkedTodos.map((todo) => todo.title), ['Visit store']);
  assert.equal(linked.list.items.length, 0);
  const todos = createTodoService({ db: h.db, actionLog: { record() {} } });
  assert.deepEqual(todos.get('todo-1').lists, [{ id: list.id, title: 'Groceries' }]);

  h.db.prepare('DELETE FROM todos WHERE id = ?').run('todo-1');
  assert.equal((await h.service.getList(list.id)).linkedTodos.length, 0);
});

test('deleting a list leaves its linked task untouched', async (t) => {
  const h = harness(); t.after(h.close);
  h.db.prepare(`
    INSERT INTO todos (id, title, description, area, venture_tag, status, outcome, priority, due_date, recurrence,
      snoozed_until, position, created_at, updated_at, completed_at, archived_at, deleted_at)
    VALUES ('todo-1', 'Visit store', '', 'Personal', NULL, 'todo', NULL, 1, NULL, NULL, NULL, 0,
      '2026-09-17T12:00:00.000Z', '2026-09-17T12:00:00.000Z', NULL, NULL, NULL)
  `).run();
  const { list } = await h.service.createList({ title: 'Groceries', todoIds: ['todo-1'] });
  await h.service.deleteList(list.id);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM todos WHERE id = ?').get('todo-1').n, 1);
});
