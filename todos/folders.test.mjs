// Task folders: a task filed under one of the owner's chat projects or folders
// (migration 013, todos/folders.mjs), through the service, the HTTP shape and the
// agent tools.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createTodoCommands } from './commands.mjs';
import { closeTodoDatabase, openTodoDatabase } from './db.mjs';
import { fileSheetItems, folderAdoption, folderPath, normName, resolveFolder, sheetDefaultFolder } from './folders.mjs';
import { createTodoMcpTools } from './mcp.mjs';
import * as migration013 from './migrations/013-folders.mjs';
import { createTodoService } from './service.mjs';

const NOW = '2026-11-16T12:00:00.000Z';
const PROJECTS = [
  { id: 'north', name: 'Work - Northwind', parentId: null },
  { id: 'rd', name: 'r+d', parentId: 'north' },
  { id: 'globex', name: 'globex', parentId: 'north' },
  { id: 'gizmo', name: 'Gizmo Labs', parentId: null },
  { id: 'party', name: 'Birthday party', parentId: null },
];
const cleanups = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function fixture({ projects = PROJECTS, chat = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'totem-todo-folders-'));
  const db = openTodoDatabase({ file: join(directory, 'todos.db'), now: () => NOW });
  let sequence = 0;
  const audit = [];
  const service = createTodoService({
    db,
    now: () => NOW,
    makeId: () => `t-${++sequence}`,
    actionLog: { record(entry) { audit.push(entry); } },
    folderExists: id => projects.some(p => p.id === id),
  });
  const commands = createTodoCommands({ service, maintenance: { async purgeDeleted() { return { purged: 0 }; } } });
  const linked = [];
  const tools = createTodoMcpTools({
    service,
    commands,
    fetchedAt: () => NOW,
    folders: {
      list: async () => projects,
      chat: async () => chat,
      linkChat: async (_session, c, taskId) => { linked.push({ threadId: c.threadId, taskId }); },
    },
  });
  cleanups.push(() => { closeTodoDatabase(db); rmSync(directory, { recursive: true, force: true }); });
  return { db, service, commands, tools, audit, linked };
}

test('folder names resolve by id, path, name and a word of a project name', () => {
  assert.deepEqual(resolveFolder(PROJECTS, 'rd'), { id: 'rd' });
  assert.deepEqual(resolveFolder(PROJECTS, 'Work - Northwind / r+d'), { id: 'rd' });
  assert.deepEqual(resolveFolder(PROJECTS, 'work northwind'), { id: 'north' });
  assert.deepEqual(resolveFolder(PROJECTS, 'northwind'), { id: 'north' });
  assert.deepEqual(resolveFolder(PROJECTS, 'r+d'), { id: 'rd' });
  assert.deepEqual(resolveFolder(PROJECTS, 'gizmo labs'), { id: 'gizmo' });
  assert.deepEqual(resolveFolder(PROJECTS, 'Personal'), { id: null });
  assert.deepEqual(resolveFolder(PROJECTS, null), { id: null });
  assert.equal(resolveFolder(PROJECTS, 'Initech'), null);
  // A folder name used by two projects is ambiguous until named by its path.
  const twice = [...PROJECTS, { id: 'f-77', name: 'Globex', parentId: 'gizmo' }];
  assert.deepEqual(resolveFolder(twice, 'GLOBEX ').ambiguous.sort(), ['Gizmo Labs / Globex', 'Work - Northwind / globex']);
  assert.deepEqual(resolveFolder(twice, 'Gizmo Labs / globex'), { id: 'f-77' });
  assert.equal(folderPath(PROJECTS, 'rd'), 'Work - Northwind / r+d');
  assert.equal(folderPath(PROJECTS, 'gone'), null);
  assert.equal(normName('Gizmo Labs HQ'), 'gizmolabshq');
});

test('a task carries its folder through create, update, list filters and its next occurrence', () => {
  const { service } = fixture();
  const filed = service.create({ title: 'Timesheets', folderId: 'north', dueDate: '2026-11-16', recurrence: 'weekly' });
  const loose = service.create({ title: 'Oil change' });
  assert.equal(filed.folderId, 'north');
  assert.equal(loose.folderId, null);
  assert.deepEqual(service.list({ folderId: 'north' }).map(t => t.id), [filed.id]);
  assert.deepEqual(service.list({ folderId: 'none' }).map(t => t.id), [loose.id]);

  assert.equal(service.update(loose.id, { folderId: 'rd' }).folderId, 'rd');
  assert.equal(service.update(loose.id, { title: 'Oil change soon' }).folderId, 'rd', 'a patch without folderId keeps it');
  assert.equal(service.update(loose.id, { folderId: null }).folderId, null);

  service.complete(filed.id);
  const next = service.list({ status: 'todo' }).find(t => t.title === 'Timesheets');
  assert.ok(next && next.id !== filed.id);
  assert.equal(next.folderId, 'north');
});

test('a folder that is malformed or does not exist is refused, and nothing changes', () => {
  const { service } = fixture();
  assert.throws(() => service.create({ title: 'x', folderId: '../etc' }), { code: 'INVALID_FOLDER' });
  assert.throws(() => service.create({ title: 'x', folderId: 'nope' }), { code: 'UNKNOWN_FOLDER' });
  const task = service.create({ title: 'y' });
  assert.throws(() => service.update(task.id, { folderId: 'nope' }), { code: 'UNKNOWN_FOLDER' });
  assert.equal(service.get(task.id).folderId, null);
  assert.equal(service.list().length, 1);
});

test('a task already under a folder that was since deleted can still be edited', () => {
  let projects = PROJECTS;
  const directory = mkdtempSync(join(tmpdir(), 'totem-todo-folders-'));
  const db = openTodoDatabase({ file: join(directory, 'todos.db'), now: () => NOW });
  cleanups.push(() => { closeTodoDatabase(db); rmSync(directory, { recursive: true, force: true }); });
  const service = createTodoService({ db, now: () => NOW, actionLog: { record() {} }, folderExists: id => projects.some(p => p.id === id) });
  const task = service.create({ title: 'z', folderId: 'party' });
  projects = PROJECTS.filter(p => p.id !== 'party');
  assert.equal(service.update(task.id, { title: 'z2' }).folderId, 'party');
});

test('a removed folder\'s tasks move to its project, or become unfiled, in one audit line', () => {
  const { service, audit } = fixture();
  const a = service.create({ title: 'a', folderId: 'rd' });
  const b = service.create({ title: 'b', folderId: 'rd' });
  const c = service.create({ title: 'c', folderId: 'gizmo' });
  const before = audit.length;
  assert.equal(service.refileFolder('rd', 'north'), 2);
  assert.deepEqual([a, b].map(t => service.get(t.id).folderId), ['north', 'north']);
  assert.equal(audit.length, before + 1);
  assert.equal(service.refileFolder('gizmo', null), 1);
  assert.equal(service.get(c.id).folderId, null);
  assert.equal(service.refileFolder('nothing-here', null), 0);
});

test('adopting folders files only unfiled tasks, once', () => {
  const { service } = fixture();
  const a = service.create({ title: 'a' });
  const b = service.create({ title: 'b', folderId: 'gizmo' });
  assert.equal(service.adoptFolders([{ id: a.id, folderId: 'north' }, { id: b.id, folderId: 'north' }, { id: 'missing', folderId: 'north' }], 'foldersAdopted'), 1);
  assert.equal(service.get(a.id).folderId, 'north');
  assert.equal(service.get(b.id).folderId, 'gizmo', 'a task already filed keeps its folder');
  service.update(a.id, { folderId: null });
  assert.equal(service.adoptFolders([{ id: a.id, folderId: 'north' }], 'foldersAdopted'), null, 'it runs once');
  assert.equal(service.get(a.id).folderId, null);
  // Preferences keep only their own keys: the marker is not a preference.
  assert.equal(Object.hasOwn(service.getPreferences(), 'foldersAdopted'), false);
});

test('migration 013 adds folder_id to an existing database and is idempotent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'totem-todo-013-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'x.db'));
  db.exec("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO todos VALUES ('t-1', 'kept')");
  migration013.migrate(db);
  migration013.migrate(db);
  assert.deepEqual(db.prepare('SELECT id, title, folder_id FROM todos').all().map(r => ({ ...r })), [{ id: 't-1', title: 'kept', folder_id: null }]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'todos_folder_id'").get().n, 1);
  db.close();
});

test('agents file a task by folder name and read each task\'s folder', async () => {
  const PROJECTS_LIVE = [...PROJECTS];
  const { tools, service } = fixture({ projects: PROJECTS_LIVE });
  const made = await tools.totem_create_task({ title: 'Invoice Globex', folder: 'Work - Northwind / globex' });
  assert.equal(made.todo.folderId, 'globex');
  assert.equal(made.todo.folder, 'Work - Northwind / globex');
  await tools.totem_create_task({ title: 'Seal sandals' });
  const read = await tools.totem_get_tasks({});
  assert.deepEqual(read.todos.map(t => [t.title, t.folder]).sort(), [['Invoice Globex', 'Work - Northwind / globex'], ['Seal sandals', 'Personal']]);
  assert.deepEqual((await tools.totem_get_tasks({ folder: 'Personal' })).todos.map(t => t.title), ['Seal sandals']);
  assert.deepEqual((await tools.totem_get_tasks({ folder: 'globex' })).todos.map(t => t.title), ['Invoice Globex']);
  // A task whose project was deleted is Personal to the filter as it is in the result.
  await tools.totem_create_task({ title: 'Orphan', folder: 'party' });
  PROJECTS_LIVE.splice(PROJECTS_LIVE.findIndex(p => p.id === 'party'), 1);
  assert.deepEqual((await tools.totem_get_tasks({ folder: 'Personal' })).todos.map(t => t.title).sort(), ['Orphan', 'Seal sandals']);

  const moved = await tools.totem_update_task({ id: made.todo.id, folder: 'gizmo' });
  assert.equal(moved.updated, true);
  assert.equal(service.get(made.todo.id).folderId, 'gizmo');
  await assert.rejects(tools.totem_update_task({ id: made.todo.id, folder: 'Initech' }), { code: 'FOLDER_NOT_FOUND' });
  await assert.rejects(tools.totem_create_task({ title: 'x', folder: 'gizmo', folderId: 'north' }), { code: 'ALIAS_CONFLICT' });
  assert.equal(service.get(made.todo.id).folderId, 'gizmo');

  const listed = await tools.totem_get_projects();
  assert.equal(listed.folders[0].name, 'Personal');
  assert.ok(listed.folders.some(f => f.path === 'Work - Northwind / r+d' && f.id === 'rd'));
});

test('a task made from a chat in a folder lands there and the chat names it', async () => {
  const { tools, linked } = fixture({ chat: { threadId: 'thread-1', projectId: 'rd', taskId: null } });
  const made = await tools.totem_create_task({ title: 'Follow up with r+d' });
  assert.equal(made.todo.folderId, 'rd');
  assert.equal(made.filedFromChat, true);
  assert.equal(made.linkedToChat, true);
  assert.deepEqual(linked, [{ threadId: 'thread-1', taskId: made.todo.id }]);
  // A folder the agent names wins over the chat's.
  const named = await tools.totem_create_task({ title: 'Personal errand', folder: 'Personal' });
  assert.equal(named.todo.folderId, null);
  assert.equal(named.filedFromChat, undefined);
});

test('a chat that already names a task keeps it; a chat outside any project files nothing', async () => {
  const { tools, linked } = fixture({ chat: { threadId: 'thread-2', projectId: null, taskId: 'other' } });
  const made = await tools.totem_create_task({ title: 'Loose' });
  assert.equal(made.todo.folderId, null);
  assert.equal(made.linkedToChat, undefined);
  assert.deepEqual(linked, []);
});

test('a sheet\'s rows land in the project its name starts with, unless a setting says otherwise', () => {
  const projects = [...PROJECTS, { id: 'giz', name: 'Gizmo', parentId: null }];
  assert.equal(sheetDefaultFolder(projects, 'Gizmo Labs HQ'), 'gizmo', 'the longest name that fits');
  assert.equal(sheetDefaultFolder(projects, 'Gizmo Labs HQ', 'none'), null);
  assert.equal(sheetDefaultFolder(projects, 'Gizmo Labs HQ', 'party'), 'party');
  assert.equal(sheetDefaultFolder(projects, 'Gizmo Labs HQ', 'deleted'), null);
  assert.equal(sheetDefaultFolder(projects, 'Quarterly plan'), null);
  // A folder inside a project is never picked automatically, nor a name under three letters.
  assert.equal(sheetDefaultFolder([{ id: 'x', name: 'Wa', parentId: null }, { id: 'f', name: 'Gizmo Labs', parentId: 'north' }], 'Gizmo Labs HQ'), null);
});

test('each sheet row gets its own filing, found again when the row moved, else the default', () => {
  const feed = {
    configured: true,
    title: 'Gizmo Labs HQ',
    items: [
      { id: 'sheet:0:9:aaaa', title: 'moved row' },
      { id: 'sheet:0:12:bbbb', title: 'filed row' },
      { id: 'sheet:0:13:cccc', title: 'taken out' },
      { id: 'sheet:0:14:dddd', title: 'loose' },
      { id: 'sheet:0:15:eeee', title: 'gone folder' },
    ],
  };
  const filings = {
    'sheet:0:4:aaaa': 'rd', // the row moved from 4 to 9
    'sheet:0:12:bbbb': 'party',
    'sheet:0:13:cccc': 'none',
    'sheet:0:15:eeee': 'deleted-project',
    'local-task': 'north',
  };
  const out = fileSheetItems(feed, filings, PROJECTS, '');
  assert.equal(out.defaultFolderId, 'gizmo');
  assert.deepEqual(out.items.map(i => [i.title, i.folderId, i.folderDefault ?? false]), [
    ['moved row', 'rd', false],
    ['filed row', 'party', false],
    ['taken out', null, false],
    ['loose', 'gizmo', true],
    ['gone folder', 'gizmo', true],
  ]);
  // With no default, an unfiled row is just unfiled.
  assert.deepEqual(fileSheetItems(feed, {}, PROJECTS, 'none').items.map(i => i.folderDefault ?? false), [false, false, false, false, false]);
});

test('the move from areas to folders keeps panel filings and maps venture tags to same-named projects', () => {
  const todos = [
    { id: 'filed', area: 'Personal', ventureTag: null, folderId: null },
    { id: 'wp-task', area: 'Ventures', ventureTag: 'Gizmo Labs', folderId: null },
    { id: 'initech', area: 'Ventures', ventureTag: 'Initech', folderId: null },
    { id: 'personal', area: 'Personal', ventureTag: null, folderId: null },
    { id: 'already', area: 'Ventures', ventureTag: 'Gizmo Labs', folderId: 'party' },
  ];
  const { entries } = folderAdoption({ filed: 'rd', 'sheet:0:1:aaaa': 'gizmo', stale: 'deleted' }, todos, PROJECTS);
  assert.deepEqual(entries, [{ id: 'filed', folderId: 'rd' }, { id: 'wp-task', folderId: 'gizmo' }]);
});
