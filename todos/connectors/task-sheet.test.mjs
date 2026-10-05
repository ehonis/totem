import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createGoogleSheetsClient } from './google-sheets-client.mjs';
import { closeTodoDatabase, openTodoDatabase } from '../db.mjs';
import { createTodoService } from '../service.mjs';
import { runTodoCli } from '../cli.mjs';
import { createTaskSheetConnector, unconfiguredTaskSheetHealth } from './task-sheet-sync.mjs';
import {
  ACTION_ITEMS,
  buildCreationRow,
  buildSchemaBootstrap,
  buildUpdateSet,
  eligibleActionItem,
  parseActionItemRow,
  resolveActionItemSchema,
  validateStableIds,
  configureTaskSheet,
} from './task-sheet-policy.mjs';
import { seedVentureTags, TEST_VENTURE_TAGS } from '../test-support.mjs';

// An invented sheet, owner and colleague; the connector is configured the way the
// bridge configures it from TASK_SHEET_* at startup.
configureTaskSheet({
  spreadsheetId: 'test-spreadsheet-id',
  spreadsheetTitle: 'Example HQ',
  tab: 'Action Items',
  sheetId: 0,
  assignees: ['Alex', 'Alex & Sam'],
  ventureTags: () => TEST_VENTURE_TAGS,
});

const directories = [];
const databases = [];
afterEach(() => {
  for (const db of databases.splice(0)) closeTodoDatabase(db);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const metadata = {
  spreadsheetId: ACTION_ITEMS.spreadsheetId,
  properties: { title: 'Example HQ', timeZone: 'America/New_York' },
  sheets: [{ properties: { sheetId: 0, title: 'Action Items', gridProperties: { columnCount: 12 } } }],
};
const headers = ['Task Name', 'Who', 'Priority', 'Status', 'Due Date', 'Notes & Links', 'Tag', 'Totem ID'];

test('resolves columns by exact row-4 headers rather than fixed letters', () => {
  const schema = resolveActionItemSchema({ metadata, headerValues: headers });
  assert.equal(schema.columns.title, 0);
  assert.equal(schema.columns.totemId, 7);
  assert.equal(schema.timeZone, 'America/New_York');
  assert.equal(schema.dataStartRow, 5);
});

test('still reads the id column under its pre-rename "Vesper ID" header', () => {
  // Back-compat with the live sheet until its header is renamed; see LEGACY_ID_HEADER.
  const schema = resolveActionItemSchema({ metadata, headerValues: [...headers.slice(0, -1), 'Vesper ID'] });
  assert.equal(schema.columns.totemId, 7);
});

test('schema resolution rejects missing, duplicate, and wrong-sheet headers before writes', () => {
  assert.throws(() => resolveActionItemSchema({ metadata, headerValues: headers.slice(0, -1) }), /Totem ID/);
  assert.throws(() => resolveActionItemSchema({ metadata, headerValues: [...headers, 'Tag'] }), /duplicate/i);
  assert.throws(() => resolveActionItemSchema({ metadata: { ...metadata, spreadsheetId: 'wrong' }, headerValues: headers }), /spreadsheet/i);
  assert.throws(() => resolveActionItemSchema({ metadata: { ...metadata, properties: { ...metadata.properties, title: 'Wrong' } }, headerValues: headers }), /title/i);
});

test('stable ids must be unique before any connector write', () => {
  assert.deepEqual(validateStableIds([{ totemId: '' }, { totemId: 'one' }, { totemId: 'two' }]), ['one', 'two']);
  assert.throws(() => validateStableIds([{ totemId: 'same' }, { totemId: 'same' }]), /duplicate.*same/i);
});

test('auto-tracks only unfinished exact Alex assignments with a valid venture tag', () => {
  assert.equal(eligibleActionItem({ who: 'Alex', status: 'Not Started', tag: 'Acme' }), true);
  assert.equal(eligibleActionItem({ who: 'Alex & Sam', status: 'In Progress', tag: 'Initech' }), true);
  assert.equal(eligibleActionItem({ who: 'ethan', status: 'Not Started', tag: 'Globex' }), false);
  assert.equal(eligibleActionItem({ who: 'Alex', status: 'Done', tag: 'Acme' }), false);
  assert.equal(eligibleActionItem({ who: 'Alex', status: 'Waiting', tag: 'Acme' }), false);
  assert.equal(eligibleActionItem({ who: 'Alex', status: 'Not Started', tag: '' }), false);
});

test('creation initializes Who and Status while later updates exclude both fields', () => {
  const input = { title: 'Launch', ventureTag: 'Initech', priority: 4, dueDate: '2026-10-01', notes: 'Call Sam', totemId: 'task-1' };
  assert.deepEqual(buildCreationRow(input), {
    title: 'Launch', who: 'Alex', priority: 'High', status: 'Not Started',
    dueDate: '2026-10-01', notes: 'Call Sam', tag: 'Initech', totemId: 'task-1',
    ownedAtCreate: { who: 'Alex', status: 'Not Started' },
  });
  assert.deepEqual(Object.keys(buildUpdateSet(input)).sort(), ['dueDate', 'notes', 'priority', 'tag', 'title']);
});

test('parses row values through resolved headers and preserves the stable id', () => {
  const schema = resolveActionItemSchema({ metadata, headerValues: headers });
  assert.deepEqual(parseActionItemRow({ headers: schema, values: ['Door', 'Alex & Sam', 'Medium', 'In Progress', '2026-10-01', 'Link', 'Acme', 'task-42'] }), {
    title: 'Door', who: 'Alex & Sam', priority: 3, priorityLabel: 'Medium', status: 'In Progress',
    dueDate: '2026-10-01', notes: 'Link', tag: 'Acme', totemId: 'task-42',
  });
});

test('schema bootstrap adds Tag validation and hides Totem ID without touching existing columns', () => {
  const bootstrap = buildSchemaBootstrap({ metadata, headerValues: headers.slice(0, 6) });
  assert.deepEqual(bootstrap.headerValues, [{ range: "'Action Items'!H4:I4", values: [['Tag', 'Totem ID']] }]);
  assert.equal(bootstrap.requests[0].setDataValidation.range.startColumnIndex, 7);
  assert.equal(bootstrap.requests[0].setDataValidation.range.startRowIndex, 4);
  assert.equal(bootstrap.requests[1].updateDimensionProperties.properties.hiddenByUser, true);
});

test('Sheets client exchanges one scoped service-account assertion and reuses its token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'totem-sheets-client-'));
  directories.push(directory);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentialsFile = join(directory, 'service-account.json');
  writeFileSync(credentialsFile, JSON.stringify({
    client_email: 'totem@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth2.googleapis.com/token',
  }));
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push([String(url), init]);
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'token-value', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ spreadsheetId: ACTION_ITEMS.spreadsheetId }), { status: 200 });
  };
  const client = createGoogleSheetsClient({ credentialsFile, fetch, now: () => Date.parse('2026-09-12T12:00:00.000Z') });

  await client.getMetadata(ACTION_ITEMS.spreadsheetId);
  await client.getMetadata(ACTION_ITEMS.spreadsheetId);

  assert.equal(calls.filter(([url]) => url.includes('oauth2')).length, 1);
  const assertion = new URLSearchParams(calls[0][1].body).get('assertion');
  const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url'));
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer token-value');
});

function row(overrides = {}) {
  return {
    title: 'Fix the door', who: 'Alex', priority: 'Medium', status: 'Not Started',
    dueDate: '', notes: '', tag: 'Acme', totemId: '', ...overrides,
  };
}

function rowValues(item) {
  return [item.title, item.who, item.priority, item.status, item.dueDate, item.notes, item.tag, item.totemId];
}

function fakeSheet(rows = []) {
  const state = { rows: rows.map(item => ({ ...item })), failMetadataOnce: false, alwaysFailWrites: false, failBeforeCommit: false, failAfterCommit: false, calls: [], headers: [...headers] };
  const column = letter => letter.charCodeAt(0) - 'B'.charCodeAt(0);
  const client = {
    state,
    async getMetadata() { state.calls.push(['metadata']); if (state.failMetadataOnce) { state.failMetadataOnce = false; throw new Error('metadata unavailable'); } return metadata; },
    async readRange(spreadsheetId, range) {
      state.calls.push(['read', range]);
      const exact = /!B(\d+):I\1$/.exec(range);
      if (exact) {
        const item = state.rows[Number(exact[1]) - 5];
        return { values: item ? [rowValues(item)] : [] };
      }
      return { values: [state.headers, ...state.rows.map(rowValues)] };
    },
    async batchUpdateValues(spreadsheetId, data) {
      state.calls.push(['values', structuredClone(data)]);
      if (state.alwaysFailWrites) throw new Error('sheet still offline');
      if (state.failBeforeCommit) { state.failBeforeCommit = false; throw new Error('sheet offline'); }
      for (const update of data) {
        if (/!H4:I4$/.test(update.range)) {
          state.headers.splice(6, 2, ...update.values[0]);
          continue;
        }
        const full = /!B(\d+):I\1$/.exec(update.range);
        if (full) state.rows[Number(full[1]) - 5] = Object.fromEntries(headers.map((header, index) => [
          { 'Task Name': 'title', Who: 'who', Priority: 'priority', Status: 'status', 'Due Date': 'dueDate', 'Notes & Links': 'notes', Tag: 'tag', 'Totem ID': 'totemId' }[header],
          update.values[0][index] ?? '',
        ]));
        const cell = /!([B-I])(\d+):\1\2$/.exec(update.range);
        if (cell) {
          const item = state.rows[Number(cell[2]) - 5];
          const key = ['title', 'who', 'priority', 'status', 'dueDate', 'notes', 'tag', 'totemId'][column(cell[1])];
          item[key] = update.values[0][0] ?? '';
        }
      }
      if (state.failAfterCommit) { state.failAfterCommit = false; throw new Error('ambiguous write'); }
      return { totalUpdatedRows: data.length };
    },
    async batchUpdateSpreadsheet(spreadsheetId, requests) { state.calls.push(['spreadsheet', structuredClone(requests)]); return {}; },
  };
  return client;
}

function syncFixture(rows = []) {
  const directory = mkdtempSync(join(tmpdir(), 'totem-sheet-sync-'));
  directories.push(directory);
  const db = openTodoDatabase({ file: join(directory, 'todos.db'), now: () => '2026-09-12T12:00:00.000Z' });
  seedVentureTags(db);
  databases.push(db);
  let id = 0;
  const actions = [];
  const service = createTodoService({
    db,
    now: () => '2026-09-12T12:00:00.000Z',
    makeId: () => `task-${++id}`,
    actionLog: { record(entry) { actions.push(entry); } },
  });
  const client = fakeSheet(rows);
  const connector = createTaskSheetConnector({
    db, service, client,
    now: () => '2026-09-12T12:00:00.000Z',
    workerId: 'sheet-test',
    actionLog: { record(entry) { actions.push(entry); } },
    makeId: () => `sheet-${++id}`,
  });
  return { actions, client, connector, db, service };
}

test('explicit share creates one stable row and an ambiguous committed write never duplicates it', async () => {
  const { client, connector, service } = syncFixture();
  const task = service.create({ title: 'Launch Initech', area: 'Ventures', ventureTag: 'Initech' });
  client.state.failAfterCommit = true;

  const shared = await connector.share(task.id);
  await connector.reconcile();

  assert.equal(client.state.rows.filter(item => item.totemId === task.id).length, 1);
  assert.equal(shared.externalLinks[0].externalId, task.id);
});

test('reconcile claims only eligible blank-id rows and discovers a later Alex assignment', async () => {
  const { client, connector, service } = syncFixture([
    row({ title: 'Mine', who: 'Alex', tag: 'Acme' }),
    row({ title: 'Later', who: 'Sam', tag: 'Initech' }),
  ]);
  await connector.reconcile();
  assert.equal(service.list({ source: 'sheet' }).length, 1);
  assert.ok(client.state.rows[0].totemId);
  assert.equal(client.state.rows[1].totemId, '');

  client.state.rows[1].who = 'Alex & Sam';
  await connector.reconcile();
  assert.equal(service.list({ source: 'sheet' }).length, 2);
  assert.equal(new Set(client.state.rows.map(item => item.totemId)).size, 2);
});

test('Sheet completion owns done/reopen, open preserves focus, and reassignment archives', async () => {
  const { client, connector, service } = syncFixture([row({ totemId: 'sheet-1' })]);
  await connector.reconcile();
  const task = service.get('sheet-1');
  service.move(task.id, 'doing');
  await connector.reconcile();
  assert.equal(service.get(task.id).status, 'doing');
  client.state.rows[0].status = 'Done';
  await connector.reconcile();
  assert.equal(service.get(task.id).status, 'done');
  client.state.rows[0].status = 'Not Started';
  await connector.reconcile();
  assert.equal(service.get(task.id).status, 'todo');
  client.state.rows[0].who = 'Sam';
  await connector.reconcile();
  assert.ok(service.get(task.id).archivedAt);
});

test('concurrent shared-field edits become conflicts without overwriting the meeting', async () => {
  const { client, connector, service } = syncFixture([row({ totemId: 'sheet-1' })]);
  await connector.reconcile();
  service.update('sheet-1', { title: 'Local title' });
  client.state.rows[0].title = 'Meeting title';

  await connector.reconcile();

  assert.equal(client.state.rows[0].title, 'Meeting title');
  assert.equal(service.get('sheet-1').title, 'Local title');
  assert.equal(connector.getHealth().conflicts[0].field, 'title');
});

test('remote-only fields pull locally and note append retries exactly once', async () => {
  const { client, connector, service } = syncFixture([row({ totemId: 'sheet-1' })]);
  await connector.reconcile();
  Object.assign(client.state.rows[0], { title: 'Meeting title', priority: 'High', dueDate: '2026-10-01', notes: 'Remote note', tag: 'Globex' });
  await connector.reconcile();
  const pulled = service.get('sheet-1');
  assert.deepEqual({ title: pulled.title, priority: pulled.priority, dueDate: pulled.dueDate, description: pulled.description, ventureTag: pulled.ventureTag }, {
    title: 'Meeting title', priority: 4, dueDate: '2026-10-01', description: 'Remote note', ventureTag: 'Globex',
  });

  client.state.failAfterCommit = true;
  await connector.appendNote('sheet-1', 'One append');
  await connector.reconcile();
  assert.equal(client.state.rows[0].notes.match(/One append/g)?.length, 1);
  assert.doesNotMatch(client.state.rows[0].notes, /totem-note/);
});

test('failed local shared-field writes persist retry intent without overwriting the Sheet', async () => {
  const { client, connector, db, service } = syncFixture([row({ totemId: 'sheet-1' })]);
  await connector.reconcile();
  client.state.failBeforeCommit = true;

  await assert.rejects(connector.updateLinked('sheet-1', { title: 'Local queued title' }), /sheet offline/);

  assert.equal(service.get('sheet-1').title, 'Local queued title');
  assert.equal(client.state.rows[0].title, 'Fix the door');
  assert.deepEqual({ ...db.prepare(`
    SELECT operation, status, attempts, last_error FROM sync_outbox
    WHERE connector = 'sheet' AND todo_id = ? AND status <> 'completed'
  `).get('sheet-1') }, {
    operation: 'update', status: 'retry', attempts: 1, last_error: 'sheet offline',
  });
  assert.equal(connector.getHealth().status, 'pending');
  assert.equal(connector.getHealth().pending, 1);
  assert.match(connector.getHealth().recovery, /retry/i);
});

test('failed explicit sharing keeps one durable row-create intent', async () => {
  const { client, connector, db, service } = syncFixture();
  const task = service.create({ title: 'Share later', area: 'Ventures', ventureTag: 'Globex' });
  client.state.failBeforeCommit = true;

  await assert.rejects(connector.share(task.id), /sheet offline/);

  assert.equal(client.state.rows.length, 0);
  assert.deepEqual({ ...db.prepare(`
    SELECT operation, status, attempts, last_error FROM sync_outbox
    WHERE connector = 'sheet' AND todo_id = ? AND status <> 'completed'
  `).get(task.id) }, {
    operation: 'create', status: 'retry', attempts: 1, last_error: 'sheet offline',
  });
});

test('failed note append keeps one durable marker-backed append intent', async () => {
  const { client, connector, db, service } = syncFixture([row({ totemId: 'sheet-1', notes: 'Existing' })]);
  await connector.reconcile();
  client.state.failBeforeCommit = true;

  await assert.rejects(connector.appendNote('sheet-1', 'Retry me'), /sheet offline/);

  assert.equal(service.get('sheet-1').notes.at(-1).body, 'Retry me');
  assert.equal(client.state.rows[0].notes, 'Existing');
  assert.deepEqual({ ...db.prepare(`
    SELECT operation, status, attempts, last_error FROM sync_outbox
    WHERE connector = 'sheet' AND todo_id = ? AND status <> 'completed'
  `).get('sheet-1') }, {
    operation: 'append-note', status: 'retry', attempts: 1, last_error: 'sheet offline',
  });
});

test('note publication never overwrites a concurrent local or meeting title edit', async () => {
  const { client, connector, service } = syncFixture([row({ totemId: 'sheet-1' })]);
  await connector.reconcile();
  service.update('sheet-1', { title: 'Local title' });
  client.state.rows[0].title = 'Meeting title';

  await connector.appendNote('sheet-1', 'Only publish this note');

  assert.equal(service.get('sheet-1').title, 'Local title');
  assert.equal(client.state.rows[0].title, 'Meeting title');
});

test('a narrow priority write does not resolve or overwrite an unrelated title conflict', async () => {
  const { client, connector, service } = syncFixture([row({ totemId: 'sheet-1' })]);
  await connector.reconcile();
  service.update('sheet-1', { title: 'Local title' });
  client.state.rows[0].title = 'Meeting title';

  await connector.updateLinked('sheet-1', { priority: 4 });

  assert.equal(service.get('sheet-1').title, 'Local title');
  assert.equal(client.state.rows[0].title, 'Meeting title');
  await connector.reconcile();
  assert.equal(connector.getHealth().conflicts[0].field, 'title');
});

test('a pull failure does not suppress a ready Sheet outbox write', async () => {
  const { client, connector, db, service } = syncFixture([row({ totemId: 'sheet-1' })]);
  await connector.reconcile();
  client.state.failBeforeCommit = true;
  await assert.rejects(connector.updateLinked('sheet-1', { title: 'Queued title' }), /sheet offline/);
  db.prepare("UPDATE sync_outbox SET next_attempt_at = ? WHERE connector = 'sheet' AND status = 'retry'")
    .run('2026-09-12T12:00:00.000Z');
  client.state.failMetadataOnce = true;

  const result = await connector.reconcile();

  assert.match(result.pullError, /metadata unavailable/);
  assert.equal(result.outbox.processed, 1);
  assert.equal(client.state.rows[0].title, 'Queued title');
  assert.equal(service.get('sheet-1').title, 'Queued title');
});

test('Sheet outbox reclaims expired leases and exhausts a bounded retry exactly once', async () => {
  const { actions, client, connector, db, service } = syncFixture([row({ totemId: 'sheet-1' })]);
  await connector.reconcile();
  const base = service.get('sheet-1').externalLinks[0].lastSyncSnapshot;
  db.prepare(`
    INSERT INTO sync_outbox (
      id, todo_id, connector, operation, payload, idempotency_key, status, attempts,
      lease_owner, lease_expires_at, created_at, updated_at
    ) VALUES ('expired-sheet', 'sheet-1', 'sheet', 'update', ?, 'expired-sheet', 'leased', 1,
      'dead-worker', '2026-09-12T11:59:00.000Z', ?, ?)
  `).run(JSON.stringify({ fields: { title: 'Recovered lease' }, base }), '2026-09-12T12:00:00.000Z', '2026-09-12T12:00:00.000Z');
  assert.equal((await connector.reconcile()).outbox.processed, 1);
  assert.equal(client.state.rows[0].title, 'Recovered lease');

  db.prepare(`
    INSERT INTO sync_outbox (
      id, todo_id, connector, operation, payload, idempotency_key, status, attempts,
      next_attempt_at, last_error, created_at, updated_at
    ) VALUES ('exhaust-sheet', 'sheet-1', 'sheet', 'update', ?, 'exhaust-sheet', 'retry', 4,
      ?, 'offline', ?, ?)
  `).run(JSON.stringify({ fields: { title: 'Never lands' }, base: { ...base, title: 'Recovered lease' } }), '2026-09-12T12:00:00.000Z', '2026-09-12T12:00:00.000Z', '2026-09-12T12:00:00.000Z');
  client.state.alwaysFailWrites = true;
  const exhausted = await connector.reconcile();
  assert.equal(exhausted.outbox.exhausted, 1);
  assert.deepEqual({ ...db.prepare(`SELECT status, attempts, lease_owner, lease_expires_at, last_error FROM sync_outbox WHERE id = 'exhaust-sheet'`).get() }, {
    status: 'exhausted', attempts: 5, lease_owner: null, lease_expires_at: null, last_error: 'sheet still offline',
  });
  await connector.reconcile();
  assert.equal(actions.filter(action => action.action === 'sheet.outbox.exhausted').length, 1);
});

test('schema bootstrap is explicit, exact-id confirmed, and action logged', async () => {
  const { actions, client, connector } = syncFixture();
  client.state.headers = headers.slice(0, 6);
  await assert.rejects(connector.bootstrapSchema({ confirmSheetId: 'wrong' }), error => error.code === 'SHEET_CONFIRMATION_REQUIRED');

  await connector.bootstrapSchema({ confirmSheetId: ACTION_ITEMS.spreadsheetId });

  assert.deepEqual(client.state.headers, headers);
  assert.ok(client.state.calls.some(([kind]) => kind === 'spreadsheet'));
  assert.equal(actions.filter(action => action.action === 'sheet.schema.bootstrap').length, 1);
});

test('Sheet bootstrap CLI rejects a wrong confirmation before reading credentials', async () => {
  await assert.rejects(runTodoCli([
    'sheet-bootstrap-schema', '--confirm-sheet-id', 'wrong',
  ], { stdout: { write() {} } }), /exact spreadsheet id/i);
});

test('names no sheet or person of its own: unconfigured, nothing is eligible or writable', async () => {
  const policy = await import('./task-sheet-policy.mjs');
  const saved = policy.taskSheetSettings();
  try {
    policy.configureTaskSheet({ spreadsheetId: '', spreadsheetTitle: '', assignees: [] });
    assert.equal(policy.taskSheetConfigured(), false);
    assert.equal(eligibleActionItem({ who: 'Alex', status: 'Not Started', tag: 'Acme' }), false);
    assert.throws(() => resolveActionItemSchema({ metadata, headerValues: headers }), { code: 'TASK_SHEET_NOT_CONFIGURED' });
    assert.throws(() => buildCreationRow({ title: 'x', ventureTag: 'Acme', totemId: 't' }), { code: 'TASK_SHEET_NOT_CONFIGURED' });
  } finally {
    policy.configureTaskSheet(saved);
  }
});

test('the title check is optional; the tag list follows the install', async () => {
  const policy = await import('./task-sheet-policy.mjs');
  const saved = policy.taskSheetSettings();
  try {
    policy.configureTaskSheet({ spreadsheetTitle: '', ventureTags: () => ['Initech'] });
    resolveActionItemSchema({ metadata: { ...metadata, properties: { ...metadata.properties, title: 'Renamed' } }, headerValues: headers });
    assert.equal(eligibleActionItem({ who: 'Alex', status: 'Not Started', tag: 'Initech' }), true);
    assert.equal(eligibleActionItem({ who: 'Alex', status: 'Not Started', tag: 'Globex' }), false);
  } finally {
    policy.configureTaskSheet({ ...saved, ventureTags: () => saved.ventureTags });
  }
});

test('unconfigured: health names the missing setting and queued writes are kept', () => {
  const directory = mkdtempSync(join(tmpdir(), 'totem-sheet-unconfigured-'));
  directories.push(directory);
  const db = openTodoDatabase({ file: join(directory, 'todos.db'), now: () => '2026-10-04T12:00:00.000Z' });
  databases.push(db);
  db.prepare(`INSERT INTO todos (id, title, area, created_at, updated_at) VALUES ('t1', 'x', 'Personal', ?, ?)`).run('2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00.000Z');
  db.prepare(`
    INSERT INTO sync_outbox (id, todo_id, connector, operation, payload, idempotency_key, status, created_at, updated_at)
    VALUES ('o1', 't1', 'sheet', 'update', '{}', 'k1', 'pending', ?, ?)
  `).run('2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00.000Z');

  const health = unconfiguredTaskSheetHealth(db, ['TASK_SHEET_ID']);
  assert.equal(health.status, 'unconfigured');
  assert.deepEqual(health.missing, ['TASK_SHEET_ID']);
  assert.match(health.lastError, /needs TASK_SHEET_ID/);
  assert.equal(health.queued, 1);
  assert.match(health.lastError, /1 queued write\(s\) are kept/);
  assert.equal(db.prepare("SELECT status FROM sync_outbox WHERE id = 'o1'").get().status, 'pending', 'still queued');
});
