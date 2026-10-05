import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Poller,
  USE_DEBOUNCE_MS,
  USE_FOLLOWUP_MS,
  WATCH_POLL_SECONDS,
} from './poller.mjs';

/**
 * Fake clock so debounce / follow-up / watch cadence can be asserted without
 * sleeping. `advance` runs every timer whose due time is now in the past,
 * including timers that those callbacks themselves schedule.
 */
function createClock() {
  let now = 0;
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();

  const runDue = async () => {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const dueTimeouts = [...timeouts.entries()]
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of dueTimeouts) {
        if (!timeouts.has(id)) continue;
        timeouts.delete(id);
        progressed = true;
        await t.fn();
      }
      for (const [, t] of intervals) {
        while (t.at <= now) {
          progressed = true;
          t.at += t.ms;
          await t.fn();
        }
      }
    }
  };

  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        const id = nextId++;
        timeouts.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout(id) {
        timeouts.delete(id);
      },
      setInterval(fn, ms) {
        const id = nextId++;
        intervals.set(id, { fn, ms, at: now + ms });
        return id;
      },
      clearInterval(id) {
        intervals.delete(id);
      },
    },
    async advance(ms) {
      now += ms;
      await runDue();
    },
    intervalDelay() {
      const first = [...intervals.values()][0];
      return first?.ms ?? null;
    },
  };
}

function account(backend, label, extra = {}) {
  return { backend, label, displayName: label, id: `${backend}:${label}`, ...extra };
}

function pollerWith(clock, { fetch, accounts } = {}) {
  const calls = [];
  const fetchAccount = fetch || (async (a) => {
    calls.push(`${a.backend}:${a.label}`);
    return { id: `${a.backend}:${a.label}`, backend: a.backend, label: a.label, status: 'ok' };
  });
  const poller = new Poller({ fetchAccount, timers: clock.timers });
  poller.config = { pollIntervalSeconds: 90 };
  poller.accounts = accounts || [
    account('cursor', 'cursor-default'),
    account('claude', 'claude-default'),
  ];
  poller.snapshot = { updatedAt: null, polling: false, accounts: [] };
  return { poller, calls };
}

test('pollBackend refreshes only that backend and keeps the others', async () => {
  const clock = createClock();
  const { poller } = pollerWith(clock, {
    fetch: async (a) => ({
      id: `${a.backend}:${a.label}`,
      backend: a.backend,
      label: a.label,
      remaining: a.backend === 'cursor' ? 40 : 80,
    }),
  });
  poller.snapshot.accounts = [
    { id: 'cursor:cursor-default', backend: 'cursor', label: 'cursor-default', remaining: 50 },
    { id: 'claude:claude-default', backend: 'claude', label: 'claude-default', remaining: 80 },
  ];

  await poller.pollBackend('cursor');
  const byId = Object.fromEntries(poller.snapshot.accounts.map((a) => [a.id, a]));
  assert.equal(byId['cursor:cursor-default'].remaining, 40);
  assert.equal(byId['claude:claude-default'].remaining, 80);
});

test('noteProviderUse debounces then follows up, and skips unmetered backends', async () => {
  const clock = createClock();
  const { poller, calls } = pollerWith(clock);

  poller.noteProviderUse('opencode');
  await clock.advance(20_000);
  assert.deepEqual(calls, []);

  poller.noteProviderUse('cursor');
  poller.noteProviderUse('cursor');
  await clock.advance(USE_DEBOUNCE_MS - 1);
  assert.deepEqual(calls, []);
  await clock.advance(1);
  assert.deepEqual(calls, ['cursor:cursor-default']);

  await clock.advance(USE_FOLLOWUP_MS);
  assert.deepEqual(calls, ['cursor:cursor-default', 'cursor:cursor-default']);
});

test('a later noteProviderUse resets the follow-up clock', async () => {
  const clock = createClock();
  const { poller, calls } = pollerWith(clock);

  poller.noteProviderUse('cursor');
  await clock.advance(USE_DEBOUNCE_MS);
  assert.equal(calls.length, 1);

  // Another turn before the follow-up fires: debounce again, then a fresh follow-up.
  await clock.advance(USE_FOLLOWUP_MS / 2);
  poller.noteProviderUse('cursor');
  await clock.advance(USE_DEBOUNCE_MS - 1);
  assert.equal(calls.length, 1, 'cleared follow-up must not fire mid-debounce');
  await clock.advance(1);
  assert.equal(calls.length, 2);
  await clock.advance(USE_FOLLOWUP_MS);
  assert.equal(calls.length, 3);
});

test('watchers switch the poll cadence to 15s and back to idle', async () => {
  const clock = createClock();
  const { poller } = pollerWith(clock);
  poller.schedule();
  assert.equal(clock.intervalDelay(), 90_000);

  const unwatch = poller.addWatcher();
  assert.equal(clock.intervalDelay(), WATCH_POLL_SECONDS * 1000);
  assert.equal(poller.watchers, 1);

  unwatch();
  unwatch(); // second call is a no-op
  assert.equal(poller.watchers, 0);
  assert.equal(clock.intervalDelay(), 90_000);
});

test('concurrent pollBackend calls for one backend share a single fetch', async () => {
  const clock = createClock();
  let inflight = 0;
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { poller } = pollerWith(clock, {
    fetch: async (a) => {
      started += 1;
      inflight += 1;
      await gate;
      inflight -= 1;
      return { id: `${a.backend}:${a.label}`, backend: a.backend, label: a.label };
    },
  });

  const a = poller.pollBackend('cursor');
  const b = poller.pollBackend('cursor');
  // Let the first fetch reach the gate.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(started, 1);
  assert.equal(inflight, 1);
  release();
  await Promise.all([a, b]);
  assert.equal(started, 1);
});
