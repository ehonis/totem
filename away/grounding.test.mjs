// Run with: node --test away/grounding.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { dateGroundingBlock } from './grounding.mjs';

const NY = 'America/New_York';
const span = (start, end, label, kind = 'trip') => ({ id: label, start, end, label, kind });

// The table, as [label, key, away label or null], read back out of the block.
function table(block) {
  const m = /Upcoming local dates: (.*?)\. When the user/.exec(block);
  assert.ok(m, 'block has a date table');
  return m[1].split('; ').map((row) => {
    const r = /^(.*) = (\d{4}-\d{2}-\d{2})(?: \(AWAY: (.*)\))?$/.exec(row);
    assert.ok(r, `row parses: ${row}`);
    return [r[1], r[2], r[3] ?? null];
  });
}

test('the table lists 14 consecutive local days with matching weekdays', () => {
  const rows = table(dateGroundingBlock({ now: new Date('2026-10-30T15:00:00Z'), tz: NY }));
  assert.equal(rows.length, 14);
  assert.deepEqual(rows[0], ['Friday, October 30, 2026', '2026-10-30', null]);
  assert.deepEqual(rows[13], ['Thursday, November 12, 2026', '2026-11-12', null]);
});

test('the night clocks spring forward does not skip a day', () => {
  // 23:30 on Saturday 13 March 2027 in New York; DST starts at 02:00 on Sunday the 14th.
  // Adding 24 hours to this instant lands on Monday 00:30 local, which is how the old
  // table (instant + i days, then formatted) skipped the Sunday.
  const rows = table(dateGroundingBlock({ now: new Date('2027-03-14T04:30:00Z'), tz: NY }));
  assert.deepEqual(rows.slice(0, 3).map((r) => r[1]), ['2027-03-13', '2027-03-14', '2027-03-15']);
  assert.equal(rows[1][0], 'Sunday, March 14, 2027');
});

test('away days are marked in the table, inclusive of both ends', () => {
  const block = dateGroundingBlock({
    now: new Date('2026-10-30T15:00:00Z'), tz: NY,
    spans: [span('2026-11-02', '2026-11-04', 'Lisbon')],
  });
  const marked = table(block).filter((r) => r[2]).map((r) => [r[1], r[2]]);
  assert.deepEqual(marked, [['2026-11-02', 'Lisbon'], ['2026-11-03', 'Lisbon'], ['2026-11-04', 'Lisbon']]);
  assert.match(block, /AWAY: Coming up: Lisbon \(trip\), 2026-11-02 to 2026-11-04\./);
  assert.match(block, /Do not schedule, set due dates or plan reminders on an AWAY day/);
  assert.match(block, /away__propose/);
});

test('a current span says so, with the day count', () => {
  const block = dateGroundingBlock({
    now: new Date('2026-11-03T15:00:00Z'), tz: NY,
    spans: [span('2026-11-02', '2026-11-05', 'Lisbon'), span('2026-12-24', '2026-12-26', 'Holidays', 'off')],
  });
  assert.match(block, /Away today: Lisbon \(trip\), 2026-11-02 to 2026-11-05, day 2 of 4\./);
  assert.match(block, /Coming up: Holidays \(day off\), 2026-12-24 to 2026-12-26\./);
});

test('the same instant marks the local day, not the UTC day', () => {
  // 03:00 UTC on 2 November: still 1 November in Los Angeles, already the afternoon of
  // 2 November in Auckland. A one-day trip on the 2nd is today only in Auckland.
  const now = new Date('2026-11-02T03:00:00Z');
  const spans = [span('2026-11-02', '2026-11-02', 'Conference')];
  const la = dateGroundingBlock({ now, tz: 'America/Los_Angeles', spans });
  const akl = dateGroundingBlock({ now, tz: 'Pacific/Auckland', spans });
  assert.equal(table(la)[0][1], '2026-11-01');
  assert.equal(table(la)[0][2], null);
  assert.equal(table(la)[1][2], 'Conference');
  assert.match(la, /Coming up: Conference/);
  assert.equal(table(akl)[0][1], '2026-11-02');
  assert.equal(table(akl)[0][2], 'Conference');
  assert.match(akl, /Away today: Conference/);
});

test('with nothing coming up the block still says to propose a trip found in email', () => {
  const now = new Date('2026-10-30T15:00:00Z');
  for (const spans of [[], [span('2026-09-01', '2026-09-05', 'Past'), span('2027-06-01', '2027-06-10', 'Far')]]) {
    const block = dateGroundingBlock({ now, tz: NY, spans });
    assert.equal(table(block).filter((r) => r[2]).length, 0);
    assert.match(block, / AWAY: none coming up\. If an email or the calendar shows the owner travelling .* away__propose/);
    assert.doesNotMatch(block, /Past|Far/);
  }
});

test('many spans with long labels stay short: five listed, the rest counted, labels clipped', () => {
  const now = new Date('2026-10-30T15:00:00Z');
  const long = 'An extremely long description of a trip somewhere far away '.repeat(3);
  const spans = Array.from({ length: 30 }, (_, i) => span(`2026-11-${String(1 + (i % 28)).padStart(2, '0')}`, `2026-11-${String(1 + (i % 28)).padStart(2, '0')}`, `${long}${i}`));
  const block = dateGroundingBlock({ now, tz: NY, spans });
  const base = dateGroundingBlock({ now, tz: NY });
  assert.ok(block.length - base.length < 1200, `away part is ${block.length - base.length} characters`);
  assert.match(block, /\+25 more \(away__list\)\./);
  for (const [, , label] of table(block).filter((r) => r[2])) assert.ok(label.length <= 30, label);
  assert.equal((block.match(/\(trip\), 2026-11-/g) || []).length, 5);
});

test('a span past the table but inside the horizon is listed, not marked', () => {
  const block = dateGroundingBlock({ now: new Date('2026-10-30T15:00:00Z'), tz: NY, spans: [span('2026-12-01', '2026-12-03', 'Later')] });
  assert.equal(table(block).filter((r) => r[2]).length, 0);
  assert.match(block, /Coming up: Later \(trip\), 2026-12-01 to 2026-12-03\./);
});
