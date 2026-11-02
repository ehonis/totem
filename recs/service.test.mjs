import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OWNER_ACTOR } from '../logs/store.mjs';
import { closeTodoDatabase, openTodoDatabase } from '../todos/db.mjs';
import { createRecService, OWNER_VIA, recSimilarity, resurfaceDeferredRecs } from './service.mjs';

const OWNER = { actor: OWNER_ACTOR, via: OWNER_VIA, auth: 'session' };
const AGENT = { actor: 'mcp-gateway', reason: 'mcp: record recommendation' };

function setup(t, { start = '2026-10-30T15:00:00.000Z', timeZone = 'UTC' } = {}) {
  const db = openTodoDatabase({ file: join(mkdtempSync(join(tmpdir(), 'totem-recs-')), 'todos.db') });
  t.after(() => closeTodoDatabase(db));
  let clock = start;
  let n = 0;
  const audits = [];
  const service = createRecService({
    db,
    actionLog: { record: (entry) => audits.push(entry) },
    now: () => clock,
    timeZone,
    makeId: () => `r${String(++n).padStart(4, '0')}`,
  });
  return { db, service, audits, setClock: (value) => { clock = value; } };
}

test('records a rec as pending with its evidence, and audits it once', async (t) => {
  const { service, audits } = setup(t);
  const { rec, declinedSimilar, openSimilar } = await service.record({
    title: 'Buy a standing desk', body: 'Sit less in the afternoons.', evidence: 'Back pain logged 4 of 7 days',
    costUsd: 449.995, source: 'chat:abc', actBy: '2026-11-30',
  }, AGENT);
  assert.equal(rec.decision, 'pending');
  assert.equal(rec.costUsd, 450);
  assert.equal(rec.source, 'chat:abc');
  assert.equal(rec.reviewOn, null, 'reviewOn is set only by a deferral');
  assert.deepEqual(declinedSimilar, []);
  assert.deepEqual(openSimilar, []);
  assert.deepEqual(audits.map((a) => [a.action, a.actor]), [['rec.record', 'mcp-gateway']]);
});

test('an agent cannot decide: not on record, not through decide', async (t) => {
  const { service, audits } = setup(t);
  await assert.rejects(
    service.record({ title: 'Buy a desk', source: 'chat:abc', decision: 'accepted' }, AGENT),
    (error) => error.code === 'REC_DECISION_OWNER_ONLY' && error.status === 403,
  );
  const { rec } = await service.record({ title: 'Buy a desk', source: 'chat:abc' }, AGENT);
  for (const context of [AGENT, {}, { actor: 'owner' }, { via: 'mcp' }]) {
    await assert.rejects(service.decide(rec.id, { decision: 'accepted' }, context), (error) => error.code === 'REC_DECISION_OWNER_ONLY');
  }
  assert.equal((await service.get(rec.id)).decision, 'pending');
  assert.deepEqual(audits.map((a) => a.action), ['rec.record']);

  const { rec: decided } = await service.decide(rec.id, { decision: 'accepted', note: 'yes' }, OWNER);
  assert.equal(decided.decision, 'accepted');
  assert.equal(decided.decisionNote, 'yes');
  // The audit line says how the decision was authenticated, not just "owner".
  assert.deepEqual([audits.at(-1).actor, audits.at(-1).detail.auth], [OWNER_ACTOR, 'session']);
});

test('finds what was declined recently that resembles a new suggestion', async (t) => {
  const { service, setClock } = setup(t, { start: '2026-09-01T12:00:00.000Z' });
  const old = (await service.record({ title: 'Buy a standing desk', source: 'chat:a' }, AGENT)).rec;
  await service.decide(old.id, { decision: 'declined' }, OWNER);

  setClock('2026-10-20T12:00:00.000Z');
  const accepted = (await service.record({ title: 'Raise the standing desk monitor', source: 'chat:c' }, AGENT)).rec;
  await service.decide(accepted.id, { decision: 'accepted' }, OWNER);
  const recent = (await service.record({ title: 'Get a standing desk for the home office', source: 'chat:b' }, AGENT)).rec;
  await service.decide(recent.id, { decision: 'declined', note: 'no room' }, OWNER);
  const other = (await service.record({ title: 'Try creatine before lifting', source: 'totem:coach' }, AGENT)).rec;
  await service.decide(other.id, { decision: 'declined' }, OWNER);

  setClock('2026-10-30T12:00:00.000Z');
  const { recs } = await service.list({ similarTo: 'buy a standing desk', declinedWithinDays: 30 });
  // The September decline is past the window, the creatine one is unrelated, and the
  // accepted one is not declined.
  assert.deepEqual(recs.map((r) => r.id), [recent.id]);
  assert.deepEqual(recs[0].similarity.matched, ['stand', 'desk']);
  assert.equal(recs[0].decisionNote, 'no room');

  const wider = await service.list({ similarTo: 'standing desk', declinedWithinDays: 90 });
  assert.deepEqual(wider.recs.map((r) => r.id).sort(), [old.id, recent.id].sort());
});

test('similarity keeps direction, short terms and plurals, and folds a few rewordings', () => {
  const rec = (title, body = '') => ({ title, body });
  // Opposite advice is not the same advice.
  assert.equal(recSimilarity('Stop taking vitamin supplements', rec('Start taking vitamin supplements')), null);
  assert.equal(recSimilarity('Reduce coffee after noon', rec('Increase coffee after noon')), null);
  assert.equal(recSimilarity('Quit the gym membership', rec('Keep the gym membership')), null);
  assert.ok(recSimilarity('Stop taking vitamin supplements', rec('Quit vitamin supplements')));
  // "Lower" names a body part as often as a direction, and one swapped detail is
  // different advice: a decline of one must not block the other.
  assert.equal(recSimilarity('Lower body workout', rec('Upper body workout')), null);
  assert.equal(recSimilarity('Lower body workout twice', rec('Upper body workout twice')), null);
  assert.equal(recSimilarity('Run a 5k on Saturday', rec('Run a 10k on Saturday')), null);
  assert.ok(recSimilarity('Lower body workout', rec('Do a lower body workout on Mondays')));
  assert.ok(recSimilarity('Stop drinking coffee after noon', rec('Drink less coffee after noon')));
  // Short terms count: D3 is not B12.
  assert.equal(recSimilarity('Take vitamin D3', rec('Take vitamin B12')), null);
  assert.deepEqual(recSimilarity('Take vitamin D3', rec('Try vitamin D3 in winter')).matched, ['vitamin', 'd3']);
  // -es and -ies plurals fold.
  assert.deepEqual(recSimilarity('Buy blue light glasses', rec('Get blue-light glass')).matched, ['blue', 'light', 'glass']);
  assert.deepEqual(recSimilarity('storage boxes', rec('Buy a storage box')).matched, ['storage', 'box']);
  assert.deepEqual(recSimilarity('frozen berries', rec('Frozen berry smoothies')).matched, ['frozen', 'berry']);
  // A few common rewordings.
  assert.ok(recSimilarity('Buy a standing desk', rec('Try an adjustable desk')));
  assert.ok(recSimilarity('Start running in the morning', rec('Begin jogging in the mornings')));
  // Two shared terms, unless the query has only one; one word in common is not enough.
  assert.equal(recSimilarity('desk lamp for reading', rec('Buy a standing desk', 'For the home office')), null);
  assert.ok(recSimilarity('desk', rec('Buy a standing desk')));
  // A single shared term does not score as a full match.
  assert.ok(recSimilarity('desk', rec('Buy a standing desk for the home office')).score < 0.5);
});

test('record refuses a recent decline unless the agent says what changed', async (t) => {
  const { service, setClock, audits } = setup(t);
  const { rec: declined } = await service.record({ title: 'Buy a standing desk', source: 'chat:a' }, AGENT);
  await service.decide(declined.id, { decision: 'declined', note: 'no room' }, OWNER);

  setClock('2026-11-04T15:00:00.000Z');
  await assert.rejects(
    service.record({ title: 'Get a standing desk', source: 'chat:b' }, AGENT),
    (error) => error.code === 'REC_DECLINED_RECENTLY' && /no room/.test(error.message) && error.message.includes(declined.id),
  );
  assert.equal((await service.list()).count, 1, 'nothing new waits on the owner');

  const { rec, declinedSimilar } = await service.record({ title: 'Get a standing desk', source: 'chat:b', changed: 'Moved to a bigger flat' }, AGENT);
  assert.equal(rec.changedNote, 'Moved to a bigger flat');
  assert.deepEqual(declinedSimilar.map((r) => r.id), [declined.id]);
  assert.equal(audits.filter((a) => a.action === 'rec.record').length, 2);

  // Past the window the decline no longer blocks.
  setClock('2026-12-15T15:00:00.000Z');
  await service.decide(rec.id, { decision: 'declined' }, OWNER);
  setClock('2027-02-01T15:00:00.000Z');
  assert.ok((await service.record({ title: 'Buy a standing desk', source: 'chat:c' }, AGENT)).rec);
});

test('record refuses a duplicate of an open rec and returns the similar open ones', async (t) => {
  const { service } = setup(t);
  const { rec: first } = await service.record({ title: 'Buy a standing desk', source: 'chat:a' }, AGENT);
  await assert.rejects(
    service.record({ title: 'Get standing desks', source: 'chat:b' }, AGENT),
    (error) => error.code === 'REC_DUPLICATE' && error.details.id === first.id,
  );
  const { openSimilar } = await service.record({ title: 'Buy a standing desk mat', source: 'chat:b' }, AGENT);
  assert.deepEqual(openSimilar.map((r) => r.id), [first.id]);
  // The opposite advice is not a duplicate.
  assert.ok((await service.record({ title: 'Stop using the standing desk', source: 'chat:c' }, AGENT)).rec);
  assert.equal(service.stats().pending, 3);
});

test('the ledger always shows every open rec, and pages only the decided history', async (t) => {
  const { db, service } = setup(t, { start: '2026-01-01T00:00:00.000Z' });
  const { rec: oldPending } = await service.record({ title: 'An old suggestion still waiting', source: 'chat:a' }, AGENT);
  const insert = db.prepare(`
    INSERT INTO recs (id, title, source, created_at, updated_at, decision, decided_at)
    VALUES (?, ?, 'chat:x', ?, ?, ?, ?)
  `);
  for (let i = 0; i < 300; i += 1) {
    const at = new Date(Date.UTC(2026, 5, 1) + i * 60_000).toISOString();
    insert.run(`d${String(i).padStart(3, '0')}`, `Decided ${i}`, at, at, i % 2 ? 'accepted' : 'declined', at);
  }

  const first = await service.ledger();
  assert.deepEqual(first.open.map((r) => r.id), [oldPending.id]);
  assert.equal(first.history.length, 50);
  assert.equal(first.history[0].id, 'd299');
  assert.equal(first.stats.total, 301);

  const seen = new Set(first.history.map((r) => r.id));
  let cursor = first.nextBefore;
  while (cursor) {
    const page = await service.ledger({ before: cursor, limit: 120 });
    assert.deepEqual(page.open.map((r) => r.id), [oldPending.id]);
    for (const r of page.history) { assert.ok(!seen.has(r.id), r.id); seen.add(r.id); }
    cursor = page.nextBefore;
  }
  assert.equal(seen.size, 300);
});

test('a deferred rec comes back as pending on its review day, once, with one notification', async (t) => {
  const { service, setClock, audits } = setup(t);
  const { rec } = await service.record({ title: 'Switch to a cheaper phone plan', source: 'totem:money', costUsd: 0 }, AGENT);
  await assert.rejects(service.decide(rec.id, { decision: 'deferred' }, OWNER), /deferDays/);
  await assert.rejects(service.decide(rec.id, { decision: 'deferred', deferDays: 0 }, OWNER), /deferDays/);
  await assert.rejects(service.decide(rec.id, { decision: 'deferred', reviewOn: '2026-10-30' }, OWNER), /after today/);
  const { rec: deferred } = await service.decide(rec.id, { decision: 'deferred', deferDays: 6, note: 'after the trip' }, OWNER);
  assert.equal(deferred.decision, 'deferred');
  assert.equal(deferred.reviewOn, '2026-11-05');

  const sent = [];
  const notify = async (n) => { sent.push(n); };

  setClock('2026-11-04T23:59:00.000Z');
  assert.deepEqual(await resurfaceDeferredRecs({ service, notify }), []);
  assert.equal((await service.get(rec.id)).decision, 'deferred');

  setClock('2026-11-05T00:01:00.000Z');
  const back = await resurfaceDeferredRecs({ service, notify });
  assert.deepEqual(back.map((r) => r.id), [rec.id]);
  const now = await service.get(rec.id);
  assert.equal(now.decision, 'pending');
  assert.equal(now.decidedAt, null);
  assert.equal(now.resurfacedAt, '2026-11-05T00:01:00.000Z');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].category, 'rec.review');
  assert.equal(sent[0].url, '/productivity/recs');
  assert.match(sent[0].body, /after the trip/);

  setClock('2026-11-05T00:01:30.000Z');
  assert.deepEqual(await resurfaceDeferredRecs({ service, notify }), []);
  assert.equal(sent.length, 1);
  assert.equal(audits.filter((a) => a.action === 'rec.resurface').length, 1);
});

test('deferral days and the review day are counted in the bridge\'s time zone', async (t) => {
  // 02:00Z on 30 Oct is still 29 Oct in New York.
  const { service, setClock } = setup(t, { start: '2026-10-30T02:00:00.000Z', timeZone: 'America/New_York' });
  const { rec } = await service.record({ title: 'Book a dentist checkup', source: 'chat:a' }, AGENT);
  const { rec: deferred } = await service.decide(rec.id, { decision: 'deferred', deferDays: 7 }, OWNER);
  assert.equal(deferred.reviewOn, '2026-11-05');
  // "Tomorrow" by the server's clock: a UTC device would have called this today.
  await assert.rejects(service.decide(rec.id, { decision: 'deferred', reviewOn: '2026-10-29' }, OWNER), /after today/);

  const notify = async () => {};
  // 00:01Z on 5 Nov is 19:01 on 4 Nov in New York (EST since 1 Nov): not yet.
  setClock('2026-11-05T00:01:00.000Z');
  assert.deepEqual(await resurfaceDeferredRecs({ service, notify }), []);
  setClock('2026-11-05T04:59:00.000Z');
  assert.deepEqual(await resurfaceDeferredRecs({ service, notify }), []);
  // 05:01Z is 00:01 on 5 Nov there.
  setClock('2026-11-05T05:01:00.000Z');
  assert.deepEqual((await resurfaceDeferredRecs({ service, notify })).map((r) => r.id), [rec.id]);
});

test('a failed notification costs only its own push: every due rec still comes back, and it is logged', async (t) => {
  const { service, setClock } = setup(t);
  const ids = [];
  for (const title of ['Renew the passport early', 'Book the annual eye test', 'Replace the smoke alarm batteries']) {
    const { rec } = await service.record({ title, source: 'chat:a' }, AGENT);
    await service.decide(rec.id, { decision: 'deferred', deferDays: 1 }, OWNER);
    ids.push(rec.id);
  }
  setClock('2026-10-31T09:00:00.000Z');
  const sent = [];
  const logged = [];
  const back = await resurfaceDeferredRecs({
    service,
    notify: async (n) => { if (!sent.length && !logged.length) throw new Error('push service down'); sent.push(n.title); },
    log: (line) => logged.push(line),
  });
  assert.deepEqual(back.map((r) => r.id), ids);
  for (const id of ids) assert.equal((await service.get(id)).decision, 'pending');
  assert.equal(sent.length, 2);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /push service down/);
});

test('only an accepted rec takes an outcome; an agent cannot overwrite the owner\'s, and the line says who measured', async (t) => {
  const { service } = setup(t);
  const make = async (title, decision, costUsd) => {
    const { rec } = await service.record({ title, source: 'chat:x', costUsd }, AGENT);
    if (decision) await service.decide(rec.id, { decision }, OWNER);
    return rec;
  };
  const a = await make('Walk after lunch', 'accepted');
  const b = await make('Buy blackout blinds', 'accepted', 120);
  const c = await make('Cut caffeine after noon', 'accepted');
  const d = await make('Buy a rowing machine', 'declined', 900);
  await make('Read before bed', null);

  await assert.rejects(service.setOutcome(d.id, { outcome: 'worked' }, AGENT), (error) => error.code === 'REC_NOT_ACCEPTED');
  await assert.rejects(service.setOutcome(a.id, { outcome: 'great' }, AGENT), /outcome must be one of/);
  await service.setOutcome(a.id, { outcome: 'worked', note: 'Steps up 2k/day' }, AGENT);
  await service.setOutcome(b.id, { outcome: 'partly' }, OWNER);
  await service.setOutcome(c.id, { outcome: 'failed' }, OWNER);

  assert.equal((await service.get(a.id)).outcomeBy, 'agent');
  await assert.rejects(service.setOutcome(c.id, { outcome: 'worked' }, AGENT), (error) => error.code === 'REC_OUTCOME_OWNER_SET');
  assert.equal((await service.get(c.id)).outcome, 'failed');
  // The owner can correct an agent's report.
  await service.setOutcome(a.id, { outcome: 'worked', note: 'Confirmed' }, OWNER);
  await service.setOutcome(b.id, { outcome: 'partly' }, OWNER);
  await service.setOutcome(a.id, { outcome: 'worked' }, AGENT).catch(() => {});

  const before = service.stats();
  assert.equal(before.measured, 3);
  assert.equal(before.agentReported, 0);
  const e = await make('Stretch every morning', 'accepted');
  await service.setOutcome(e.id, { outcome: 'worked' }, AGENT);

  const stats = service.stats();
  assert.equal(stats.measured, 4);
  assert.equal(stats.worked, 2);
  assert.equal(stats.hitRate, 2 / 4);
  assert.equal(stats.agentReported, 1);
  assert.equal(stats.acceptRate, 4 / 5);
  assert.equal(stats.acceptedCostUsd, 120);
  assert.equal(stats.line, '2 of 4 measured worked (50%), 1 partly, 1 reported by agents · 4 of 5 accepted · $120 committed · 1 waiting');

  // Taking an accepted rec back drops its outcome: it no longer measures anything.
  const { rec } = await service.decide(a.id, { decision: 'declined' }, OWNER);
  assert.equal(rec.outcome, null);
  assert.equal(rec.outcomeBy, null);
  assert.equal(service.stats().measured, 3);
});

test('rejects bad fields without writing', async (t) => {
  const { service, audits } = setup(t);
  await assert.rejects(service.record({ title: ' ', source: 'chat:x' }, AGENT), /title/);
  await assert.rejects(service.record({ title: 'X', source: '' }, AGENT), /source/);
  await assert.rejects(service.record({ title: 'X', source: 'chat:x', actBy: 'soon' }, AGENT), /actBy/);
  await assert.rejects(service.record({ title: 'X', source: 'chat:x', costUsd: -1 }, AGENT), /costUsd/);
  await assert.rejects(service.list({ decision: 'maybe' }), /decision must be one of/);
  await assert.rejects(service.ledger({ before: 'nonsense' }), /cursor/);
  assert.equal(audits.length, 0);
  assert.equal((await service.list()).count, 0);
});
