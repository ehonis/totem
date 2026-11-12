// The live open/closed state of the GitHub issues tasks link to, read through the
// same `gh` runner the Dev tab uses (`run(args)` resolves to stdout). Read-only:
// nothing here writes to GitHub.
//
// Every issue keeps its own reading: an issue is read again once its reading is
// five minutes old, so a link added, or a task brought back from the archive, is
// read on its own and never served stale. A failed read keeps that issue's last
// good state and is not retried for a minute; `error` names only the linked issues
// still failing. An issue no longer linked is forgotten.

import { ghErrorMessage, mapLimit } from '../dev/github.mjs';

export const ISSUE_STATES_TTL_MS = 5 * 60_000;
export const ISSUE_STATES_RETRY_MS = 60_000;
export const ISSUE_STATES_MAX = 50;
const CONCURRENCY = 4;

function stateFrom(raw, link) {
  const issue = JSON.parse(raw);
  const state = String(issue?.state || '').toLowerCase();
  if (state !== 'open' && state !== 'closed') throw new Error(`GitHub answered an unknown state for ${link.key}`);
  return {
    state,
    title: typeof issue.title === 'string' ? issue.title : '',
    url: typeof issue.html_url === 'string' && issue.html_url ? issue.html_url : link.url,
  };
}

export function createIssueStates({
  links,
  run,
  now = () => Date.now(),
  ttlMs = ISSUE_STATES_TTL_MS,
  retryMs = ISSUE_STATES_RETRY_MS,
  max = ISSUE_STATES_MAX,
} = {}) {
  if (typeof links !== 'function') throw new TypeError('createIssueStates requires links()');
  if (typeof run !== 'function') throw new TypeError('createIssueStates requires run()');

  const good = new Map(); // key -> { state, title, url, at }
  const failed = new Map(); // key -> { at, message }
  let inflight = null;

  function due(link, at) {
    const reading = good.get(link.key);
    const failure = failed.get(link.key);
    if (failure && at - failure.at < retryMs) return false;
    return !reading || at - reading.at >= ttlMs;
  }

  async function read(list) {
    await mapLimit(list, CONCURRENCY, async (link) => {
      const [owner, name] = link.repo.split('/');
      try {
        const raw = await run(['api', `repos/${owner}/${name}/issues/${link.number}`]);
        good.set(link.key, { ...stateFrom(raw, link), at: now() });
        failed.delete(link.key);
      } catch (error) {
        failed.set(link.key, { at: now(), message: ghErrorMessage(error) });
      }
    });
  }

  function answer(current) {
    const states = {};
    let oldest = null;
    const failing = [];
    for (const link of current) {
      const reading = good.get(link.key);
      if (reading) {
        const { at, ...state } = reading;
        states[link.key] = state;
        if (oldest === null || at < oldest) oldest = at;
      }
      const failure = failed.get(link.key);
      if (failure) failing.push({ key: link.key, message: failure.message });
    }
    const error = failing.length === 0 ? null
      : failing.length === 1 ? `${failing[0].key}: ${failing[0].message}`
        : `${failing.length} issues could not be read (${failing[0].key}: ${failing[0].message})`;
    return {
      // The oldest reading behind the answer, so a client never takes stale for fresh.
      fetchedAt: oldest === null ? null : new Date(oldest).toISOString(),
      states,
      ...(error ? { error } : {}),
    };
  }

  async function get() {
    // `while`, not `if`: several callers may wait on one read, and the first to wake can
    // start the next; the rest wait on that one too rather than each starting their own.
    while (inflight) await inflight;
    const current = links({ limit: max }).slice(0, max);
    const keys = new Set(current.map((link) => link.key));
    for (const map of [good, failed]) for (const key of map.keys()) if (!keys.has(key)) map.delete(key);
    const at = now();
    const stale = current.filter((link) => due(link, at));
    if (stale.length) {
      inflight = read(stale).finally(() => { inflight = null; });
      await inflight;
    }
    return answer(current);
  }

  return { get };
}
