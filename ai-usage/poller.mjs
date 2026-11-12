import { EventEmitter } from 'node:events';
import { loadConfig, resolveAccounts, fetchAccount as registryFetchAccount, providerName, PROVIDERS } from './registry.mjs';
import { annotateAccount, buildPools } from './pools.mjs';

// What a proxy that has never answered is assumed to hold, so a down proxy at
// boot does not bring the host's own CLI logins back as if they were the pool.
const PROXY_BACKENDS = ['claude', 'codex'];
const isProxyId = (id) => typeof id === 'string' && id.includes(':proxy:');

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
 *
 * With CLIProxy set up (`proxy`, cliproxy/source.mjs), the proxy's logins replace
 * the host's own Claude and Codex logins: those are what the agent CLIs actually
 * spend, and the host's login is only there for claude.ai connectors. Proxy
 * accounts are never token-refreshed here, and a proxy poll is one local call
 * (see the source for when it also asks a vendor).
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
  constructor({ fetchAccount = registryFetchAccount, timers = defaultTimers, proxy = null } = {}) {
    super();
    this.proxy = proxy;
    this.proxyAccounts = [];
    this.proxyBackends = null;
    this.proxyStatus = null;
    this.proxyInFlight = null;
    this.proxyAnnotated = [];
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

    await this.refreshProxy();
    const cached = new Map(this.localAccounts().map((a) => [a.id, a]));
    const kept = [];
    const missing = [];
    for (const account of this.accounts) {
      if (this.covered(account.backend)) continue;
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

  /** Does the proxy stand in for this backend's local logins? */
  covered(backend) {
    if (!this.proxy?.configured()) return false;
    return (this.proxyBackends ?? new Set(PROXY_BACKENDS)).has(backend);
  }

  /** Local results only; the proxy's are kept apart and joined in publish. */
  localAccounts() {
    return this.snapshot.accounts.filter((a) => a.source !== 'cliproxy');
  }

  /**
   * Re-read the proxy's logins. `force` (true or one proxy id) asks the vendor
   * for a fresh usage reading too. Concurrent unforced calls share one read.
   */
  async refreshProxy({ force = null } = {}) {
    if (!this.proxy) return;
    if (!this.proxy.configured()) {
      this.proxyAccounts = [];
      this.proxyBackends = null;
      this.proxyStatus = null;
      return;
    }
    if (this.proxyInFlight && !force) return this.proxyInFlight;
    const run = (async () => {
      const { accounts, status, backends } = await this.proxy.read({ watched: this.watchers > 0, force });
      this.proxyAccounts = accounts;
      this.proxyStatus = status;
      if (status?.reachable) this.proxyBackends = backends;
    })();
    if (!force) this.proxyInFlight = run;
    try {
      await run;
    } catch (err) {
      console.error(`[poller] cliproxy read failed: ${err.message}`);
    } finally {
      if (this.proxyInFlight === run) this.proxyInFlight = null;
    }
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
    const names = this.config?.accountNames ?? {};
    const hidden = new Set(this.config?.hidden ?? []);
    const local = accounts.filter((a) => a.source !== 'cliproxy' && !this.covered(a.backend));
    // Renames and hiding from Settings → Usage apply to proxy logins by id. Hiding
    // is display only: a hidden login still serves, so it still counts in its pool.
    const providerHidden = (backend) => Boolean(this.config?.providers?.[backend]?.hidden);
    const now = Date.now();
    // The CLIProxy tab manages every login, hidden or of a hidden service, so it
    // reads them all here, renamed and annotated like the rest.
    this.proxyAnnotated = this.orderAccounts(this.proxyAccounts
      .map((a) => ({ ...a, displayName: (typeof names[a.id] === 'string' && names[a.id].trim()) || a.displayName })))
      .map((a) => annotateAccount(a, now));
    const proxied = this.proxyAnnotated.filter((a) => !providerHidden(a.backend));
    // Every surface reads `accounts`, so hidden logins leave it; `pools` still
    // counts them, because the proxy still routes to them.
    const all = this.orderAccounts([...local.map((a) => annotateAccount(a, now)), ...proxied]);
    this.snapshot = {
      updatedAt,
      polling: false,
      pollIntervalSeconds: this.config?.pollIntervalSeconds,
      watchPollSeconds: WATCH_POLL_SECONDS,
      watchers: this.watchers,
      providers: this.providerLabels(),
      accounts: all.filter((a) => !hidden.has(a.id)),
      pools: buildPools(all),
      proxy: this.proxyStatus
        ? { configured: true, reachable: this.proxyStatus.reachable, error: this.proxyStatus.error, code: this.proxyStatus.code, checkedAt: this.proxyStatus.checkedAt }
        : { configured: Boolean(this.proxy?.configured()) },
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
      // The proxy is read alongside the local logins, so a slow proxy never holds Cursor up.
      const proxyRead = !only || isProxyId(only) ? this.refreshProxy({ force: isProxyId(only) ? only : null }) : null;
      if (isProxyId(only)) {
        await proxyRead;
        return this.publish(this.localAccounts());
      }

      const targets = (only
        ? this.accounts.filter((a) => `${a.backend}:${a.label}` === only)
        : this.accounts
      ).filter((a) => !this.covered(a.backend));

      const [results] = await Promise.all([Promise.all(targets.map((a) => this.fetchOne(a))), proxyRead]);

      let accounts = results;
      if (only) {
        const byId = new Map(this.localAccounts().map((a) => [a.id, a]));
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
      // A turn spent on a proxied backend: the proxy already has the headers of
      // that very request, so a re-read of its list is the fresh number.
      if (this.covered(backend)) {
        await this.refreshProxy();
        return this.publish(this.localAccounts());
      }
      const targets = this.accounts.filter((a) => a.backend === backend);
      if (!targets.length) return this.snapshot;
      const results = await Promise.all(targets.map((a) => this.fetchOne(a)));
      const byId = new Map(this.localAccounts().map((a) => [a.id, a]));
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

  /**
   * Fetch one account, keeping its last good reading through a failed poll.
   *
   * The usage endpoints answer a busy poller with the odd 429 or 5xx, and the
   * next poll usually succeeds. Blanking the card for each of those makes the
   * meters flicker in and out, so a failure after a good reading keeps the old
   * meters, marked `stale` with the error and when it happened. A login that
   * has expired is not transient and replaces the card as before.
   */
  async fetchOne(account) {
    const next = await this.fetchAccount(account);
    const prev = this.snapshot.accounts.find((a) => a.id === next.id);
    if (next.status !== 'error') return next;
    if (next.error !== prev?.error && next.error !== prev?.staleError) {
      console.error(`[poller] ${next.id}: ${next.error}`);
    }
    if (prev?.status !== 'ok' || !prev.meters?.length) return next;
    return { ...prev, displayName: next.displayName ?? prev.displayName, stale: true, staleError: next.error, staleAt: next.fetchedAt ?? Date.now() };
  }

  /** Stable display order: grouped by backend, then by label. */
  orderAccounts(accounts) {
    const rank = { claude: 0, codex: 1, cursor: 2 };
    const name = (a) => String(a.displayName || a.label || '');
    return [...accounts].sort(
      (a, b) =>
        (rank[a.backend] ?? 9) - (rank[b.backend] ?? 9) || name(a).localeCompare(name(b)),
    );
  }

  /** Force credential refresh for one account (or all), then re-poll. */
  async refreshCredentials(id = null) {
    // A proxy login's token belongs to the proxy: a refresh here would rotate it
    // under the proxy's feet. "Refresh" for those is a fresh usage reading.
    if (isProxyId(id)) {
      await this.poll(id);
      return { refreshed: 1, errors: [] };
    }
    if (!id) await this.refreshProxy({ force: true });
    const targets = (id
      ? this.accounts.filter((a) => `${a.backend}:${a.label}` === id)
      : this.accounts
    ).filter((a) => !this.covered(a.backend));

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
