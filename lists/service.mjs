import { randomUUID } from 'node:crypto';

import { withTodoTransaction } from '../todos/db.mjs';
import { ListDomainError } from './errors.mjs';

const fail = (code, message, options) => new ListDomainError(code, message, options);

function text(value, field, max = 300) {
  if (typeof value !== 'string' || !value.trim()) {
    throw fail('INVALID_LIST_FIELD', `${field} must be a non-empty string.`, { details: { field } });
  }
  return value.trim().slice(0, max);
}

export function createListService({ db, now = () => new Date().toISOString(), makeId = randomUUID, actionLog } = {}) {
  if (!db) throw new TypeError('createListService requires db');
  if (!actionLog || typeof actionLog.record !== 'function') throw new TypeError('createListService requires actionLog');

  const row = (id) => db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
  const requireList = (id) => {
    const found = row(id);
    if (!found) throw fail('LIST_NOT_FOUND', `List ${id} was not found.`, { status: 404, details: { id } });
    return found;
  };
  const itemRow = (id) => db.prepare('SELECT * FROM list_items WHERE id = ?').get(id);
  const requireItem = (id) => {
    const found = itemRow(id);
    if (!found) throw fail('LIST_ITEM_NOT_FOUND', `List item ${id} was not found.`, { status: 404, details: { id } });
    return found;
  };

  function dto(listRow) {
    const items = db.prepare('SELECT * FROM list_items WHERE list_id = ? ORDER BY position, id').all(listRow.id)
      .map((item) => ({
        id: item.id, listId: item.list_id, text: item.text, checked: Boolean(item.checked),
        position: item.position, createdAt: item.created_at, updatedAt: item.updated_at,
      }));
    const linkedTodos = db.prepare(`
      SELECT todos.id, todos.title, todos.status, todos.due_date, todos.completed_at
      FROM list_todos JOIN todos ON todos.id = list_todos.todo_id
      WHERE list_todos.list_id = ? ORDER BY list_todos.created_at, todos.id
    `).all(listRow.id).map((todo) => ({
      id: todo.id, title: todo.title, status: todo.status,
      dueDate: todo.due_date, completedAt: todo.completed_at,
    }));
    return {
      id: listRow.id, title: listRow.title, position: listRow.position,
      createdAt: listRow.created_at, updatedAt: listRow.updated_at,
      itemCount: items.length, checkedCount: items.filter((item) => item.checked).length,
      items, linkedTodos,
    };
  }

  function audit(action, target, context, summary, result) {
    actionLog.record({
      action, actor: context?.actor ?? 'unknown', target, status: 'ok', summary,
      why: context?.reason ?? summary, detail: { result },
      correlationId: context?.correlationId ?? randomUUID(),
    });
  }

  function mutate(meta, fn) {
    const value = withTodoTransaction(db, fn);
    audit(meta.action, meta.target, meta.context, meta.summary, meta.result);
    return value;
  }

  const nextListPosition = () => (db.prepare('SELECT MAX(position) AS max FROM lists').get()?.max ?? -1) + 1;
  const nextItemPosition = (listId) =>
    (db.prepare('SELECT MAX(position) AS max FROM list_items WHERE list_id = ?').get(listId)?.max ?? -1) + 1;

  async function listLists() {
    return db.prepare('SELECT * FROM lists ORDER BY position, id').all().map(dto);
  }

  async function getList(id) { return dto(requireList(id)); }

  async function createList(input = {}, context = {}) {
    const title = text(input.title, 'title', 120);
    const items = Array.isArray(input.items) ? input.items : [];
    const todoIds = Array.isArray(input.todoIds) ? [...new Set(input.todoIds)] : [];
    const id = input.id ?? makeId();
    const stamp = now();
    mutate({ action: 'list.create', target: id, context, summary: `Created list ${title}`, result: 'created' }, () => {
      db.prepare('INSERT INTO lists (id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, title, input.position ?? nextListPosition(), stamp, stamp);
      let position = 0;
      for (const value of items) {
        const itemText = text(typeof value === 'string' ? value : value?.text, 'items[].text');
        db.prepare('INSERT INTO list_items (id, list_id, text, checked, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(makeId(), id, itemText, value?.checked === true ? 1 : 0, position++, stamp, stamp);
      }
      for (const todoId of todoIds) {
        if (!db.prepare('SELECT 1 FROM todos WHERE id = ?').get(todoId)) {
          throw fail('TODO_NOT_FOUND', `Task ${todoId} was not found.`, { status: 404, details: { todoId } });
        }
        db.prepare('INSERT INTO list_todos (list_id, todo_id, created_at) VALUES (?, ?, ?)').run(id, todoId, stamp);
      }
    });
    return { list: dto(row(id)) };
  }

  async function updateList(id, patch = {}, context = {}) {
    const current = requireList(id);
    const title = Object.hasOwn(patch, 'title') ? text(patch.title, 'title', 120) : current.title;
    const position = Object.hasOwn(patch, 'position') ? Number(patch.position) : current.position;
    if (!Number.isFinite(position)) throw fail('INVALID_LIST_FIELD', 'position must be a number.', { details: { field: 'position' } });
    const stamp = now();
    mutate({ action: 'list.update', target: id, context, summary: `Updated list ${title}`, result: 'updated' }, () => {
      db.prepare('UPDATE lists SET title = ?, position = ?, updated_at = ? WHERE id = ?').run(title, position, stamp, id);
    });
    return { list: dto(row(id)) };
  }

  async function deleteList(id, context = {}) {
    const current = requireList(id);
    mutate({ action: 'list.delete', target: id, context, summary: `Deleted list ${current.title}`, result: 'deleted' }, () => {
      db.prepare('DELETE FROM lists WHERE id = ?').run(id);
    });
    return { ok: true, id, deleted: true };
  }

  async function addItems(listId, values, context = {}) {
    requireList(listId);
    const inputs = Array.isArray(values) ? values : [values];
    if (!inputs.length) throw fail('INVALID_LIST_FIELD', 'items must contain at least one item.');
    const stamp = now();
    const ids = [];
    mutate({ action: 'list.item.add', target: listId, context, summary: `Added ${inputs.length} list item${inputs.length === 1 ? '' : 's'}`, result: 'created' }, () => {
      let position = nextItemPosition(listId);
      for (const value of inputs) {
        const itemText = text(typeof value === 'string' ? value : value?.text, 'items[].text');
        const id = makeId();
        db.prepare('INSERT INTO list_items (id, list_id, text, checked, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, listId, itemText, value?.checked === true ? 1 : 0, position++, stamp, stamp);
        ids.push(id);
      }
      db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(stamp, listId);
    });
    return { itemIds: ids, list: dto(row(listId)) };
  }

  async function updateItem(id, patch = {}, context = {}) {
    const current = requireItem(id);
    const itemText = Object.hasOwn(patch, 'text') ? text(patch.text, 'text') : current.text;
    const checked = Object.hasOwn(patch, 'checked') ? (patch.checked === true ? 1 : 0) : current.checked;
    const position = Object.hasOwn(patch, 'position') ? Number(patch.position) : current.position;
    if (!Number.isFinite(position)) throw fail('INVALID_LIST_FIELD', 'position must be a number.', { details: { field: 'position' } });
    const stamp = now();
    mutate({ action: 'list.item.update', target: id, context, summary: `Updated list item ${itemText}`, result: 'updated' }, () => {
      db.prepare('UPDATE list_items SET text = ?, checked = ?, position = ?, updated_at = ? WHERE id = ?')
        .run(itemText, checked, position, stamp, id);
      db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(stamp, current.list_id);
    });
    return { list: dto(row(current.list_id)) };
  }

  async function deleteItem(id, context = {}) {
    const current = requireItem(id);
    mutate({ action: 'list.item.delete', target: id, context, summary: `Removed list item ${current.text}`, result: 'deleted' }, () => {
      db.prepare('DELETE FROM list_items WHERE id = ?').run(id);
      db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(now(), current.list_id);
    });
    return { list: dto(row(current.list_id)) };
  }

  async function linkTodo(listId, todoId, context = {}) {
    requireList(listId);
    const todo = db.prepare('SELECT id, title FROM todos WHERE id = ?').get(todoId);
    if (!todo) throw fail('TODO_NOT_FOUND', `Task ${todoId} was not found.`, { status: 404, details: { todoId } });
    const stamp = now();
    mutate({ action: 'list.todo.link', target: listId, context, summary: `Linked task ${todo.title}`, result: 'linked' }, () => {
      db.prepare('INSERT OR IGNORE INTO list_todos (list_id, todo_id, created_at) VALUES (?, ?, ?)').run(listId, todoId, stamp);
      db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(stamp, listId);
    });
    return { list: dto(row(listId)) };
  }

  async function unlinkTodo(listId, todoId, context = {}) {
    requireList(listId);
    mutate({ action: 'list.todo.unlink', target: listId, context, summary: 'Unlinked task from list', result: 'unlinked' }, () => {
      db.prepare('DELETE FROM list_todos WHERE list_id = ? AND todo_id = ?').run(listId, todoId);
      db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(now(), listId);
    });
    return { list: dto(row(listId)) };
  }

  return { listLists, getList, createList, updateList, deleteList, addItems, updateItem, deleteItem, linkTodo, unlinkTodo };
}
