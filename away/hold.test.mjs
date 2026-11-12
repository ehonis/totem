// Run with: node --test away/hold.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNotifyStore } from '../notify/store.mjs';
import { createNotifier } from '../notify/notifier.mjs';
import { createDedupeGate } from '../notify/dedupe.mjs';
import { CATEGORIES } from '../notify/categories.mjs';
import { createAwayHold, heldWhileAway, isUrgent, nextMorning, releasedAfterAway } from './hold.mjs';

const NY = 'America/New_York';
const QUIET = { start: '22:00', end: '07:00' };
const LISBON = { id: 'a1', start: '2026-11-02', end: '2026-11-04', label: 'Lisbon', kind: 'trip' };
const DURING = Date.parse('2026-11-03T15:00:00Z');
// 07:00 in New York (EST, UTC-5) on the mornings of 4 and 5 November.
const NOV4_7AM = Date.parse('2026-11-04T12:00:00Z');
const BACK = Date.parse('2026-11-05T12:00:00Z');
const MIN = 60_000;

test('every category states what happens on an away day', () => {
  for (const [name, def] of Object.entries(CATEGORIES)) {
    assert.ok(def.away === 'send' || def.away === 'hold', `${name} needs away: 'send' or 'hold'`);
  }
});

test('urgent is the category\'s own away column, or an entry that overrides quiet hours', () => {
  for (const c of ['reminder.adhoc', 'calendar.event', 'approval.pending', 'chat.finished', 'person.birthday',
    'alert.external', 'fleet.offline', 'job.failed']) {
    assert.equal(isUrgent({ category: c }), true, c);
  }
  for (const c of ['digest.morning', 'goal.slipping', 'news.model', 'usage.limit', 'usage.blocked', 'task.due', 'inbox.proposal']) {
    assert.equal(isUrgent({ category: c }), false, c);
  }
  assert.equal(isUrgent({ category: 'goal.slipping', quietHours: 'override' }), true);
  // Not in the table at all: sent, because a wrongly held one is silently missing.
  assert.equal(isUrgent({ category: 'some.new.kind' }), true);
});

test('a nudge is held on an away day; an urgent one is not; any other day nothing is', () => {
  const opts = { spans: [LISBON], at: DURING, tz: NY };
  assert.equal(heldWhileAway({ category: 'goal.slipping' }, opts), true);
  assert.equal(heldWhileAway({ category: 'reminder.adhoc' }, opts), false);
  assert.equal(heldWhileAway({ category: 'goal.slipping' }, { ...opts, at: Date.parse('2026-11-05T15:00:00Z') }), false);
  assert.equal(heldWhileAway({ category: 'goal.slipping' }, { ...opts, spans: [] }), false);
});

test('the away day is the owner\'s local day, not the UTC one', () => {
  // 02:00 UTC on 5 November is still the evening of the 4th in New York (away), but
  // already the 5th in Berlin (back).
  const at = Date.parse('2026-11-05T02:00:00Z');
  assert.equal(heldWhileAway({ category: 'digest.evening' }, { spans: [LISBON], at, tz: NY }), true);
  assert.equal(heldWhileAway({ category: 'digest.evening' }, { spans: [LISBON], at, tz: 'Europe/Berlin' }), false);
  assert.equal(heldWhileAway({ category: 'digest.evening' }, { spans: [LISBON], at: Date.parse('2026-11-02T03:00:00Z'), tz: NY }), false);
});

test('a hold lasts until the next local morning, when quiet hours end', () => {
  assert.equal(nextMorning(DURING, NY, QUIET), NOV4_7AM);
  assert.equal(nextMorning(DURING, 'Europe/Berlin', QUIET), Date.parse('2026-11-04T06:00:00Z'));
  // No quiet hours: local midnight.
  assert.equal(nextMorning(DURING, NY, null), Date.parse('2026-11-04T05:00:00Z'));
  const hold = createAwayHold({ spans: () => [LISBON], tz: NY, quietHours: QUIET });
  assert.deepEqual(hold({ category: 'goal.slipping' }, DURING), { until: NOV4_7AM, tag: 'away' });
  assert.equal(hold({ category: 'reminder.adhoc' }, DURING), null);
});

async function harness({ spans = [LISBON], catchUpMinutes } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'totem-away-hold-'));
  let clock = DURING;
  const now = () => clock;
  const files = {
    queueFile: join(dir, 'q.json'), subscriptionsFile: join(dir, 's.json'),
    ledgerFile: join(dir, 'l.json'), feedbackFile: join(dir, 'f.jsonl'),
  };
  let store = createNotifyStore({ ...files, now, catchUpMinutes });
  const gate = createDedupeGate({ now });
  const sent = [];
  const live = { spans };
  gate.addHold(createAwayHold({ spans: () => live.spans, tz: NY, quietHours: QUIET, now }));
  const notifierFor = (s) => createNotifier({
    store: s, gate, vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.c' },
    sendImpl: async ({ payload }) => { sent.push(JSON.parse(payload).notification.title); return { ok: true, status: 201, gone: false }; },
  });
  let notifier = notifierFor(store);
  await store.saveSubscription({ subscription: { endpoint: 'https://push/1', keys: { p256dh: 'p', auth: 'a' } } });
  // The bridge's drain: thin the released backlog, then the notifier's drain, which asks the gate's holds.
  const drain = async ({ limit = 50 } = {}) => {
    for (const id of releasedAfterAway(await store.listQueue({ state: 'pending', limit: Infinity }), { at: clock })) {
      await store.finish(id, { outcome: 'stale' });
    }
    return notifier.drain({ at: clock, limit });
  };
  return {
    sent, live, drain,
    get store() { return store; },
    now,
    setNow: (t) => { clock = t; },
    // A bridge restart: a new store and notifier over the same queue file.
    restart: () => { store = createNotifyStore({ ...files, now, catchUpMinutes }); notifier = notifierFor(store); },
    enqueue: (e) => store.enqueue(e),
  };
}

test('a nudge queued during the span is delivered once, after it; an urgent one goes at once', async () => {
  const h = await harness();
  await h.enqueue({ category: 'goal.slipping', title: 'Goal slipping', deliverAt: DURING });
  await h.enqueue({ category: 'reminder.adhoc', title: 'Call the airline', deliverAt: DURING });
  await h.enqueue({ category: 'fleet.offline', title: 'A machine went offline', deliverAt: DURING });

  await h.drain();
  assert.deepEqual(h.sent.sort(), ['A machine went offline', 'Call the airline']);
  const waiting = await h.store.listQueue({ state: 'pending' });
  assert.deepEqual(waiting.map((e) => [e.title, e.deliverAt, e.heldBy]), [['Goal slipping', NOV4_7AM, 'away']]);

  // The next morning is still the trip: held one more night.
  h.setNow(NOV4_7AM);
  await h.drain();
  assert.equal(h.sent.length, 2);

  // The morning after: delivered, and only once.
  h.setNow(BACK);
  await h.drain();
  h.setNow(BACK + 30 * MIN);
  await h.drain();
  assert.deepEqual(h.sent.filter((t) => t === 'Goal slipping'), ['Goal slipping']);
  assert.equal((await h.store.listQueue({ state: 'pending' })).length, 0);
});

test('different nudges held over the trip all arrive; only older digests are dropped', async () => {
  const h = await harness();
  const held = [
    { category: 'usage.blocked', title: 'Claude is blocked', dedupeKey: 'usage:claude:w1' },
    { category: 'usage.blocked', title: 'Codex is blocked', dedupeKey: 'usage:codex:w1' },
    { category: 'goal.slipping', title: 'Marathon postponed x3', subject: 'g1' },
    { category: 'goal.slipping', title: 'Read 12 books', subject: 'g2' },
    { category: 'news.timex', title: 'Snoopy collab', dedupeKey: 'timex:snoopy' },
    { category: 'news.timex', title: 'Peanuts collab', dedupeKey: 'timex:peanuts' },
  ];
  for (const e of held) await h.enqueue({ ...e, deliverAt: DURING });
  await h.drain();
  // A digest each evening of the trip.
  for (const [i, day] of ['2026-11-02', '2026-11-03', '2026-11-04'].entries()) {
    const at = Date.parse(`${day}T23:00:00Z`);
    h.setNow(at - MIN);
    await h.enqueue({ category: 'digest.evening', title: `Evening digest ${i + 1}`, dedupeKey: `digest:evening:${day}`, deliverAt: at });
    h.setNow(at);
    await h.drain();
  }
  assert.deepEqual(h.sent, []);

  h.setNow(BACK);
  await h.drain();
  assert.deepEqual(h.sent.sort(), [...held.map((e) => e.title), 'Evening digest 3'].sort());
  assert.equal((await h.store.listQueue({ state: 'pending' })).length, 0);
});

test('a nudge that was never held is not dropped, even due at the release instant', async () => {
  const h = await harness();
  await h.enqueue({ category: 'goal.slipping', title: 'Held goal', subject: 'g1', deliverAt: DURING });
  await h.drain();
  // Planned for the morning they are back, at exactly 07:00.
  h.setNow(BACK - 60 * MIN);
  await h.enqueue({ category: 'goal.slipping', title: 'Fresh goal', subject: 'g2', deliverAt: BACK });
  h.setNow(BACK);
  await h.drain();
  assert.deepEqual(h.sent.sort(), ['Fresh goal', 'Held goal']);
});

test('deleting a span frees what it held the next morning, not when it would have ended', async () => {
  const h = await harness();
  await h.enqueue({ category: 'goal.slipping', title: 'Goal slipping', deliverAt: DURING });
  await h.drain();
  // The trip is cancelled at 16:00 on the 3rd.
  h.setNow(DURING + 60 * MIN);
  h.live.spans = [];
  await h.drain();
  assert.deepEqual(h.sent, []);
  h.setNow(NOV4_7AM);
  await h.drain();
  assert.deepEqual(h.sent, ['Goal slipping']);
});

test('a day off straight after the trip keeps the nudge held until both are over', async () => {
  const h = await harness({ spans: [LISBON, { id: 'a2', start: '2026-11-05', end: '2026-11-05', label: 'Off', kind: 'off' }] });
  await h.enqueue({ category: 'goal.slipping', title: 'Goal slipping', deliverAt: DURING });
  for (const at of [DURING, NOV4_7AM, BACK]) { h.setNow(at); await h.drain(); }
  assert.deepEqual(h.sent, []);
  h.setNow(Date.parse('2026-11-06T12:00:00Z'));
  await h.drain();
  assert.deepEqual(h.sent, ['Goal slipping']);
});

test('a held nudge survives an outage at its release and a restart', async () => {
  const h = await harness();
  await h.enqueue({ category: 'goal.slipping', title: 'Goal slipping', deliverAt: DURING });
  await h.drain();
  h.setNow(NOV4_7AM);
  await h.drain();
  // The box is down from before 07:00 on the 5th until 07:45: past the queue's
  // catch-up grace, which would mark an ordinary entry missed.
  h.restart();
  h.setNow(BACK + 45 * MIN);
  await h.drain();
  assert.deepEqual(h.sent, ['Goal slipping']);
  assert.equal((await h.store.listQueue({ state: 'missed' })).length, 0);
});

test('a nudge that only means something on its day still lapses while held', async () => {
  const h = await harness();
  await h.enqueue({ category: 'task.due', title: 'Due today', subject: 't1', deliverAt: DURING, expiresAt: Date.parse('2026-11-04T04:59:00Z') });
  await h.drain();
  h.setNow(NOV4_7AM);
  await h.drain();
  h.setNow(BACK);
  await h.drain();
  assert.deepEqual(h.sent, []);
  assert.deepEqual((await h.store.listQueue({ state: 'expired' })).map((e) => e.title), ['Due today']);
});

test('a hold that throws sends the entry and the rest of the batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-away-hold-throw-'));
  const store = createNotifyStore({
    queueFile: join(dir, 'q.json'), subscriptionsFile: join(dir, 's.json'),
    ledgerFile: join(dir, 'l.json'), feedbackFile: join(dir, 'f.jsonl'), now: () => DURING,
  });
  const gate = createDedupeGate({ now: () => DURING });
  gate.addHold(() => { throw new Error('bad span file'); });
  const sent = [];
  const notifier = createNotifier({
    store, gate, vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.c' },
    sendImpl: async ({ payload }) => { sent.push(JSON.parse(payload).notification.title); return { ok: true, status: 201, gone: false }; },
  });
  await store.saveSubscription({ subscription: { endpoint: 'https://push/1', keys: { p256dh: 'p', auth: 'a' } } });
  await store.enqueue({ category: 'goal.slipping', title: 'one', deliverAt: DURING });
  await store.enqueue({ category: 'digest.evening', title: 'two', deliverAt: DURING });
  await notifier.drain({ at: DURING });
  assert.deepEqual(sent.sort(), ['one', 'two']);
  assert.equal((await store.listQueue({ state: 'sending' })).length, 0);
});

const at = (iso) => Date.parse(iso);
const NEWS = { url: 'https://example.com/claude-6', title: 'Anthropic releases Claude 6' };

test('a story already told before the trip is not told again when the trip ends', async () => {
  // Nov 1-4. The first copy goes out on the evening of Oct 31; a second feed's copy
  // arrives on day one and is held. By Nov 5 the gate's 48-hour story window has
  // long passed, so released as it was, it went out a second time.
  const h = await harness({ spans: [{ id: 'a', start: '2026-11-01', end: '2026-11-04', label: 'Trip', kind: 'trip' }] });
  h.setNow(at('2026-10-31T21:00:00Z'));
  await h.enqueue({ category: 'news.big', title: NEWS.title, story: NEWS, url: NEWS.url, dedupeKey: 'hn:1', deliverAt: h.now() });
  await h.drain();
  assert.deepEqual(h.sent, [NEWS.title]);

  h.setNow(at('2026-11-01T15:00:00Z'));
  await h.enqueue({ category: 'news.big', title: `${NEWS.title} today`, story: NEWS, url: NEWS.url, dedupeKey: 'rss:9', deliverAt: h.now() });
  await h.drain();
  for (const t of ['2026-11-02T12:00:00Z', '2026-11-03T12:00:00Z', '2026-11-04T12:00:00Z', '2026-11-05T12:00:00Z']) { h.setNow(at(t)); await h.drain(); }
  assert.deepEqual(h.sent, [NEWS.title]);
  assert.deepEqual((await h.store.listQueue({ state: 'suppressed' })).map((e) => e.title), [`${NEWS.title} today`]);
});

test('a usage fact already pushed is not pushed again after a trip longer than its key window', async () => {
  // Nov 2-9. Sent at 22:00 on Nov 1 local time, re-raised at 10:00 on day one and
  // held; the 168-hour key window ends on Nov 9, the hold lets go on Nov 10.
  const h = await harness({ spans: [{ id: 'a', start: '2026-11-02', end: '2026-11-09', label: 'Trip', kind: 'trip' }] });
  h.setNow(at('2026-11-02T03:00:00Z'));
  await h.enqueue({ category: 'usage.blocked', title: 'Cursor window spent', dedupeKey: 'usage:cursor:w1', deliverAt: h.now() });
  await h.drain();
  h.setNow(at('2026-11-02T15:00:00Z'));
  await h.enqueue({ category: 'usage.blocked', title: 'Cursor window spent (again)', dedupeKey: 'usage:cursor:w1', deliverAt: h.now() });
  await h.drain();
  h.setNow(at('2026-11-10T12:00:00Z'));
  await h.drain();
  assert.deepEqual(h.sent, ['Cursor window spent']);
  assert.equal((await h.store.listQueue({ state: 'suppressed' })).length, 1);
});

test('copies held side by side still go out once, through the gate on release', async () => {
  const h = await harness();
  await h.enqueue({ category: 'news.big', title: NEWS.title, story: NEWS, url: NEWS.url, dedupeKey: 'hn:1', deliverAt: DURING });
  await h.enqueue({ category: 'news.big', title: `${NEWS.title} today`, story: NEWS, url: NEWS.url, dedupeKey: 'rss:9', deliverAt: DURING });
  await h.drain();
  for (const t of [NOV4_7AM, BACK]) { h.setNow(t); await h.drain(); }
  assert.deepEqual(h.sent, [NEWS.title]);
});

test('an urgent reminder due when a held backlog is released goes out at once', async () => {
  // A 2-minute catch-up grace with 60 held nudges drains (ten a tick, a tick every
  // 30 s) for longer than the grace, the same shape as 700 against the default 30.
  const h = await harness({ catchUpMinutes: 2 });
  for (let i = 0; i < 60; i++) await h.enqueue({ category: 'goal.slipping', title: `goal ${i}`, dedupeKey: `g:${i}`, deliverAt: DURING });
  // Hold them all (the bridge claims 10 a tick; bigger batches only save test time).
  while ((await h.store.listQueue({ state: 'pending', limit: Infinity })).some((e) => e.deliverAt <= h.now())) await h.drain({ limit: 100 });
  h.setNow(NOV4_7AM);
  while ((await h.store.listQueue({ state: 'pending', limit: Infinity })).some((e) => e.deliverAt <= h.now())) await h.drain({ limit: 100 });
  assert.equal(h.sent.length, 0);

  // Back on Nov 5. A reminder the owner set for 07:00, and the bridge's own pace:
  // ten a tick, a tick every 30 seconds.
  h.setNow(BACK - 60 * MIN);
  await h.enqueue({ category: 'reminder.adhoc', title: 'Call the airline', deliverAt: BACK });
  h.setNow(BACK);
  await h.drain({ limit: 10 });
  assert.equal(h.sent[0], 'Call the airline');
  for (let tick = 1; (await h.store.listQueue({ state: 'pending', limit: Infinity })).length; tick++) {
    h.setNow(BACK + tick * 30_000);
    await h.drain({ limit: 10 });
  }
  assert.ok(h.now() - BACK > 2 * MIN, 'the drain outlasted the grace, so the held exemption was exercised');
  assert.equal(h.sent.length, 61);
  assert.equal((await h.store.listQueue({ state: 'missed' })).length, 0);
});
