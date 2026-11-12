// Run with: node --test away/store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AwayError, createAwayStore } from './store.mjs';
import { createAwayHttpHandler } from './http.mjs';

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'totem-away-'));
  const file = join(dir, 'away.json');
  const records = [];
  let n = 0;
  const make = () => createAwayStore({ file, makeId: () => `a${++n}`, now: () => '2026-10-30T12:00:00.000Z', actionLog: { record: (r) => records.push(r) } });
  return { file, records, make, store: make() };
}

test('create, update and delete persist across a reload, oldest first', async () => {
  const { store, make, records, file } = await harness();
  const later = store.create({ start: '2026-12-20', end: '2026-12-27', label: 'Holidays', kind: 'off' }, { actor: 'owner' });
  const first = store.create({ start: '2026-11-02', end: '2026-11-04', label: '  Lisbon  ', note: 'flight at 9' }, { actor: 'owner' });
  assert.equal(first.kind, 'trip');
  assert.equal(first.label, 'Lisbon');
  assert.deepEqual(make().snapshot().map((s) => s.id), [first.id, later.id]);

  const moved = store.update(first.id, { end: '2026-11-05', note: '' });
  assert.equal(moved.end, '2026-11-05');
  assert.equal('note' in moved, false);
  assert.equal(make().get(first.id).end, '2026-11-05');

  assert.deepEqual(store.remove(later.id), { ok: true, id: later.id, deleted: true });
  assert.deepEqual(make().snapshot().map((s) => s.id), [first.id]);
  assert.deepEqual(records.map((r) => r.action), ['away.create', 'away.create', 'away.update', 'away.delete']);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('a span is validated: real dates, end on or after start, a label and a known kind', async () => {
  const { store } = await harness();
  const code = (input) => { try { store.create(input); return null; } catch (e) { assert.ok(e instanceof AwayError); return e.code; } };
  assert.equal(code({ start: '2026-02-30', label: 'x' }), 'INVALID_AWAY_START');
  assert.equal(code({ start: '2026-11-05', end: '2026-11-04', label: 'x' }), 'INVALID_AWAY_RANGE');
  assert.equal(code({ start: '2026-01-01', end: '2027-06-01', label: 'x' }), 'INVALID_AWAY_RANGE');
  assert.equal(code({ start: '2026-11-05', label: '   ' }), 'INVALID_AWAY_LABEL');
  assert.equal(code({ start: '2026-11-05', label: 'x', kind: 'holiday' }), 'INVALID_AWAY_KIND');
  // A one-day span needs no end.
  assert.equal(store.create({ start: '2026-11-05', label: 'Day off', kind: 'off' }).end, '2026-11-05');
  assert.throws(() => store.update('nope', {}), (e) => e.status === 404);
});

test('list from a day drops spans that ended before it', async () => {
  const { store } = await harness();
  store.create({ start: '2026-09-01', end: '2026-09-03', label: 'Past' });
  store.create({ start: '2026-10-28', end: '2026-11-01', label: 'Now' });
  assert.deepEqual(store.list({ from: '2026-10-30' }).map((s) => s.label), ['Now']);
  assert.equal(store.list().length, 2);
});

test('an unreadable file is not overwritten', async () => {
  const { file, make } = await harness();
  await writeFile(file, '{ not json');
  const store = make();
  assert.deepEqual(store.snapshot(), []);
  assert.throws(() => store.create({ start: '2026-11-05', label: 'x' }), (e) => e.code === 'AWAY_FILE_UNREADABLE');
  assert.equal(await readFile(file, 'utf8'), '{ not json');
});

test('the same trip twice is refused, with the one already listed', async () => {
  const { store } = await harness();
  const first = store.create({ start: '2026-11-02', end: '2026-11-04', label: 'Lisbon' });
  assert.throws(() => store.create({ start: '2026-11-02', end: '2026-11-04', label: 'lisbon' }),
    (e) => e.code === 'AWAY_DUPLICATE' && e.status === 409 && e.details.existing.id === first.id);
  // Other dates, or another name on the same dates, are different spans.
  store.create({ start: '2026-11-02', end: '2026-11-05', label: 'Lisbon' });
  store.create({ start: '2026-11-02', end: '2026-11-04', label: 'Conference' });
  assert.equal(store.snapshot().length, 3);
});

test('rows that could never have been saved are dropped when the file is read', async () => {
  const { file, make } = await harness();
  const ok = { id: 'ok', start: '2026-11-02', end: '2026-11-04', label: 'Lisbon', kind: 'trip' };
  await writeFile(file, JSON.stringify({ spans: [
    ok,
    { id: 'backwards', start: '2026-11-04', end: '2026-11-02', label: 'x', kind: 'trip' },
    { id: 'nolabel', start: '2026-11-04', end: '2026-11-04', label: '  ', kind: 'trip' },
    { id: 'far', start: '2026-11-04', end: '9999-12-31', label: 'Forever', kind: 'trip' },
    { id: 'year', start: '9999-12-31', end: '9999-12-31', label: 'Later', kind: 'trip' },
    { id: 'kind', start: '2026-11-04', end: '2026-11-04', label: 'x', kind: 'holiday' },
    { start: '2026-11-04', end: '2026-11-04', label: 'no id', kind: 'trip' },
    'not a span',
  ] }));
  assert.deepEqual(make().snapshot().map((s) => s.id), ['ok']);
});

test('a hand edit is picked up, and a write lands on top of it rather than over it', async () => {
  const { file, store } = await harness();
  store.create({ start: '2026-11-02', end: '2026-11-04', label: 'Lisbon' });
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  onDisk.spans.push({ id: 'hand', start: '2026-12-20', end: '2026-12-27', label: 'Holidays', kind: 'off' });
  await writeFile(file, JSON.stringify(onDisk));
  assert.deepEqual(store.snapshot().map((s) => s.label), ['Lisbon', 'Holidays']);
  store.create({ start: '2027-01-10', end: '2027-01-10', label: 'Day off', kind: 'off' });
  const saved = JSON.parse(await readFile(file, 'utf8')).spans.map((s) => s.label);
  assert.deepEqual(saved, ['Lisbon', 'Holidays', 'Day off']);
});

// A request the handler can read without a socket.
function call(handler, method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url: path, async *[Symbol.asyncIterator]() { yield* chunks; } };
  const res = { status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  return handler(req, res).then((handled) => ({ handled, status: res.status, json: res.body ? JSON.parse(res.body) : null }));
}

test('the HTTP adapter does CRUD and reports validation errors as 400', async () => {
  const { store } = await harness();
  const handler = createAwayHttpHandler({ store, tz: 'America/New_York', now: () => new Date('2026-10-30T15:00:00Z') });
  assert.equal((await call(handler, 'GET', '/api/lists')).handled, false);
  const made = await call(handler, 'POST', '/api/away', { start: '2026-11-02', end: '2026-11-04', label: 'Lisbon' });
  assert.equal(made.status, 200);
  assert.equal(made.json.span.source, 'owner');
  const bad = await call(handler, 'POST', '/api/away', { start: '2026-11-04', end: '2026-11-02', label: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_AWAY_RANGE');
  const listed = await call(handler, 'GET', '/api/away');
  assert.equal(listed.json.today, '2026-10-30');
  assert.equal(listed.json.spans.length, 1);
  const patched = await call(handler, 'PATCH', `/api/away/${made.json.span.id}`, { label: 'Porto' });
  assert.equal(patched.json.span.label, 'Porto');
  assert.equal((await call(handler, 'DELETE', `/api/away/${made.json.span.id}`)).json.deleted, true);
  assert.equal((await call(handler, 'DELETE', `/api/away/${made.json.span.id}`)).status, 404);
});
