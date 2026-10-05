import { EventEmitter } from 'node:events';
import { loadConfig, resolveAccounts, fetchAccount as registryFetchAccount, providerName, PROVIDERS } from './registry.mjs';

/**
 * Owns the current snapshot and keeps it fresh.
 *
 * Runs inside the bridge process (it used to be a standalone sidecar on :8790).
 * Accounts are fetched concurrently; a slow or broken one degrades only its own
 * card. `/api/ai-usage` serves `snapshot` directly, so a dashboard request never
 * waits on a vendor API — it reads whatever the last cycle produced.
 *
 * Freshness is not just the idle interval. Three things move the numbers:
 *   1. A background poll (90s idle, 15s while a dashboard stream is watching).
 *   2. `noteProviderUse(backend)` after Totem actually spends tokens on that
 *      provider — debounce, poll that backend only, then one follow-up a few
 *      seconds later because vendors often lag the request that spent the quota.
 *   3. `GET /api/ai-usage/stream` subscribers, counted as watchers so opening
 *      the limits UI is what flips the poller into the fast cadence.
 */

/** How often to hit vendors while at least one dashboard is watching. */
export const WATCH_POLL_SECONDS = 15;

/**
 * Wait this long after the last `noteProviderUse` before fetching, so a burst
 * of chat turns collapses into one vendor round-trip.
 */
export const USE_DEBOUNCE_MS = 1500;

/**
 * Vendors (especially Cursor and Claude) often don't decrement the window the
 * instant a request finishes. One follow-up a few seconds later is what makes
 * the bar actually move after a turn rather than on the next idle poll.
 */
export const USE_FOLLOWUP_MS = 8000;

/** Backends that have a quota meter. OpenCode is unmetered, so we skip it. */
export const METERED_BACKENDS = new Set(['claude', 'codex', 'cursor']);

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

export class Poller extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {typeof registryFetchAccount} [opts.fetchAccount]  injectable for tests
   * @param {typeof defaultTimers} [opts.timers]               injectable for tests
   */
  constructor({ fetchAccount = registryFetchAccount, timers = defaultTimers } = {}) {
    super();
    this.config = null;
    this.accounts = [];
    this.snapshot = { updatedAt: null, polling: true, accounts: [] };
    this.timer = null;
    this.inFlight = null;
    this.watchers = 0;
    this.fetchAccount = fetchAccount;
    this.timers = timers;
    // backend -> in-flight pollBackend promise, so two Cursor refreshes share one trip
    this.backendInFlight = new Map();
    // backend -> debounce timer id
    this.pendingUse = new Map();
    // backend -> follow-up timer id
    this.followupUse = new Map();
  }

  async start() {
    this.config = await loadConfig();
    this.accounts = await resolveAccounts(this.config);
    console.log(
      `[poller] tracking ${this.accounts.length} account(s): ` +
        this.accounts.map((a) => `${a.backend}:${a.label}`).join(', '),
    );
    await this.poll();
    this.schedule();
    return this.config;
  }

  /**
   * Arm (or re-arm) the repeating vendor poll.
   *
   * Watchers — live SSE clients — get the fast cadence. Nobody watching falls
   * back to the configured idle interval so five accounts and Codex's
   * `app-server` spawn are not hammered all day.
   */
  schedule() {
    this.timers.clearInterval(this.timer);
    const idle = Math.max(15, Number(this.config?.pollIntervalSeconds) || 90);
    const seconds = this.watchers > 0 ? WATCH_POLL_SECONDS : idle;
    this.timer = this.timers.setInterval(() => {
      this.poll().catch((err) => console.error(`[poller] ${err.message}`));
    }, seconds * 1000);
    // Don't hold the process open purely for the interval.
    this.timer?.unref?.();
  }

  /**
   * One dashboard stream connected. First watcher flips the poller into the
   * 15s watch cadence; the returned function undoes that when the stream ends.
   */
  addWatcher() {
    this.watchers += 1;
    if (this.watchers === 1) this.schedule();
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.watchers = Math.max(0, this.watchers - 1);
      if (this.watchers === 0) this.schedule();
    };
  }

  /**
   * Re-read config and re-run discovery — after a new profile is added, or
   * after the settings panel writes data/ai-usage.json. Re-arms the interval too,
   * since the poll cadence itself is configurable.
   *
   * Only genuinely new accounts are fetched: renaming a card or hiding a profile
   * must not re-hit three vendor APIs, or a few quick edits in the settings panel
   * earn a 429 and the cards they were editing go red.
   */
  async reload() {
    this.config = await loadConfig();
    this.accounts = await resolveAccounts(this.config);
    this.schedule();

    const cached = new Map(this.snapshot.accounts.map((a) => [a.id, a]));
    const kept = [];
    const missing = [];
    for (const account of this.accounts) {
      const hit = cached.get(`${account.backend}:${account.label}`);
      if (hit) kept.push({ ...hit, displayName: account.displayName || account.label });
      else missing.push(account);
    }

    const fetched = await Promise.all(missing.map((a) => this.fetchAccount(a)));
    this.publish(fetched.length ? [...kept, ...fetched] : kept, {
      // Nothing was refetched? Then the data is as old as it was — say so.
      updatedAt: fetched.length ? Date.now() : this.snapshot.updatedAt,
    });
    return this.snapshot;
  }

  /** Display names per backend, so the UI titles match what's configured. */
  providerLabels() {
    if (!this.config) return {};
    return Object.fromEntries(Object.keys(PROVIDERS).map((b) => [b, providerName(this.config, b)]));
  }

  /**
   * Write a new snapshot and notify SSE clients. Callers pass the account list
   * they want published; we fill in the chrome (labels, cadence, watcher count)
   * so every emit looks the same.
   */
  publish(accounts, { updatedAt = Date.now() } = {}) {
    this.snapshot = {
      updatedAt,
      polling: false,
      pollIntervalSeconds: this.config?.pollIntervalSeconds,
      watchPollSeconds: WATCH_POLL_SECONDS,
      watchers: this.watchers,
      providers: this.providerLabels(),
      accounts: this.orderAccounts(accounts),
    };
    this.emit('snapshot', this.snapshot);
    return this.snapshot;
  }

  /**
   * Poll every account once. Concurrent callers share a single in-flight cycle
   * so a burst of manual refreshes can't stampede the upstream APIs.
   */
  async poll(only = null) {
    if (this.inFlight && !only) return this.inFlight;

    const run = (async () => {
      const targets = only
        ? this.accounts.filter((a) => `${a.backend}:${a.label}` === only)
        : this.accounts;

      const results = await Promise.all(targets.map((a) => this.fetchAccount(a)));

      let accounts = results;
      if (only) {
        const byId = new Map(this.snapshot.accounts.map((a) => [a.id, a]));
        for (const r of results) byId.set(r.id, r);
        accounts = [...byId.values()];
      }
      return this.publish(accounts);
    })();

    if (!only) {
      this.inFlight = run;
      try {
        return await run;
      } finally {
        this.inFlight = null;
      }
    }
    return run;
  }

  /**
   * Refresh every account for one backend and merge into the existing snapshot.
   * Other backends stay as they were — a Cursor chat turn should not re-hit
   * Claude and Codex.
   */
  async pollBackend(backend) {
    if (!METERED_BACKENDS.has(backend)) return this.snapshot;
    const inflight = this.backendInFlight.get(backend);
    if (inflight) return inflight;

    const run = (async () => {
      const targets = this.accounts.filter((a) => a.backend === backend);
      if (!targets.length) return this.snapshot;
      const results = await Promise.all(targets.map((a) => this.fetchAccount(a)));
      const byId = new Map(this.snapshot.accounts.map((a) => [a.id, a]));
      for (const r of results) byId.set(r.id, r);
      return this.publish([...byId.values()]);
    })();

    this.backendInFlight.set(backend, run);
    try {
      return await run;
    } finally {
      this.backendInFlight.delete(backend);
    }
  }

  /**
   * Totem just spent tokens on `backend`. Does not block the agent reply —
   * the caller fires this and moves on.
   *
   * Debounced per backend so a burst of turns is one vendor fetch, then a
   * follow-up a few seconds later to catch the lagging decrement.
   */
  noteProviderUse(backend) {
    if (!METERED_BACKENDS.has(backend)) return;
    this.timers.clearTimeout(this.pendingUse.get(backend));
    this.timers.clearTimeout(this.followupUse.get(backend));
    this.followupUse.delete(backend);

    const handle = this.timers.setTimeout(async () => {
      this.pendingUse.delete(backend);
      try {
        await this.pollBackend(backend);
      } catch (err) {
        console.error(`[poller] ${backend} refresh failed: ${err.message}`);
      }
      this.scheduleFollowup(backend);
    }, USE_DEBOUNCE_MS);
    this.pendingUse.set(backend, handle);
  }

  /** One extra fetch after a use-triggered poll, then stop. */
  scheduleFollowup(backend) {
    this.timers.clearTimeout(this.followupUse.get(backend));
    const handle = this.timers.setTimeout(async () => {
      this.followupUse.delete(backend);
      try {
        await this.pollBackend(backend);
      } catch (err) {
        console.error(`[poller] ${backend} follow-up failed: ${err.message}`);
      }
    }, USE_FOLLOWUP_MS);
    this.followupUse.set(backend, handle);
  }

  /** Stable display order: grouped by backend, then by label. */
  orderAccounts(accounts) {
    const rank = { claude: 0, codex: 1, cursor: 2 };
    return [...accounts].sort(
      (a, b) =>
        (rank[a.backend] ?? 9) - (rank[b.backend] ?? 9) || a.label.localeCompare(b.label),
    );
  }

  /** Force credential refresh for one account (or all), then re-poll. */
  async refreshCredentials(id = null) {
    const targets = id
      ? this.accounts.filter((a) => `${a.backend}:${a.label}` === id)
      : this.accounts;

    const errors = [];
    await Promise.all(
      targets.map(async (account) => {
        const provider = PROVIDERS[account.backend];
        if (!provider?.forceRefresh) return;
        try {
          await provider.forceRefresh(account);
        } catch (err) {
          errors.push(`${account.backend}:${account.label}: ${err.message}`);
        }
      }),
    );

    await this.poll(id);
    return { refreshed: targets.length, errors };
  }
}
