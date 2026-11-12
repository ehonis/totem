// Run with: node --test todos/issue-states.test.mjs
//
// The open/closed state of linked GitHub issues, read through a fake `gh` runner:
// nothing here reaches the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIssueStates, ISSUE_STATES_MAX } from './issue-states.mjs';
import { issueLinkFromUrl, parseIssueUrl } from './issue-link.mjs';

const T0 = Date.parse('2026-11-09T12:00:00.000Z');

function link(repo, number) {
  return { key: `${repo}#${number}`, ...issueLinkFromUrl(`https://github.com/${repo}/issues/${number}`) };
}

function fakeGh(issues) {
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(' '));
    const match = /^api repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(args.join(' '));
    const issue = match && issues[`${match[1]}#${match[2]}`];
    if (issue instanceof Error) throw issue;
    if (!issue) throw new Error('gh: Not Found (HTTP 404)');
    return JSON.stringify({ state: issue.state, title: issue.title, html_url: `https://github.com/${match[1]}/issues/${match[2]}` });
  };
  return { run, calls };
}

function harness({ links, issues }) {
  let now = T0;
  const gh = fakeGh(issues);
  const states = createIssueStates({ links: () => links.list, run: gh.run, now: () => now });
  return { states, gh, tick: (ms) => { now += ms; }, links };
}

test('reads each linked issue through gh and caches the answer for five minutes', async () => {
  const links = { list: [link('acme/acme', 1), link('acme/acme', 2)] };
  const issues = { 'acme/acme#1': { state: 'OPEN', title: 'Door' }, 'acme/acme#2': { state: 'closed', title: 'Roof' } };
  const { states, gh, tick } = harness({ links, issues });

  const first = await states.get();
  assert.deepEqual(first, {
    fetchedAt: '2026-11-09T12:00:00.000Z',
    states: {
      'acme/acme#1': { state: 'open', title: 'Door', url: 'https://github.com/acme/acme/issues/1' },
      'acme/acme#2': { state: 'closed', title: 'Roof', url: 'https://github.com/acme/acme/issues/2' },
    },
  });
  assert.deepEqual(gh.calls.sort(), ['api repos/acme/acme/issues/1', 'api repos/acme/acme/issues/2']);

  tick(4 * 60_000);
  issues['acme/acme#1'].state = 'closed';
  assert.deepEqual(await states.get(), first, 'still cached');
  assert.equal(gh.calls.length, 2);

  tick(60_001);
  const later = await states.get();
  assert.equal(later.states['acme/acme#1'].state, 'closed');
  assert.equal(later.fetchedAt, '2026-11-09T12:05:00.001Z');
  assert.equal(gh.calls.length, 4);
});

test('a link added inside the window is read on its own; a removed one drops out', async () => {
  const links = { list: [link('acme/acme', 1)] };
  const issues = { 'acme/acme#1': { state: 'open', title: 'Door' }, 'acme/other#7': { state: 'open', title: 'New' } };
  const { states, gh, tick } = harness({ links, issues });
  await states.get();
  tick(1000);
  links.list = [link('acme/acme', 1), link('acme/other', 7)];
  const answer = await states.get();
  assert.deepEqual(Object.keys(answer.states).sort(), ['acme/acme#1', 'acme/other#7']);
  assert.deepEqual(gh.calls, ['api repos/acme/acme/issues/1', 'api repos/acme/other/issues/7']);
  assert.equal(answer.fetchedAt, '2026-11-09T12:00:00.000Z', 'the oldest reading still dates the answer');
  links.list = [link('acme/other', 7)];
  assert.deepEqual(Object.keys((await states.get()).states), ['acme/other#7']);
});

test('a failed read answers the last good states plus an error, and is not retried for a minute', async () => {
  const links = { list: [link('acme/acme', 1)] };
  const issues = { 'acme/acme#1': { state: 'open', title: 'Door' } };
  const { states, gh, tick } = harness({ links, issues });
  const good = await states.get();

  tick(5 * 60_000 + 1);
  issues['acme/acme#1'] = new Error('gh: To get started with GitHub CLI, please run:  gh auth login');
  const failed = await states.get();
  assert.deepEqual(failed.states, good.states, 'last good states');
  assert.equal(failed.fetchedAt, good.fetchedAt);
  assert.match(failed.error, /acme\/acme#1: gh is not signed in/);
  assert.equal(gh.calls.length, 2);

  tick(30_000);
  assert.match((await states.get()).error, /not signed in/);
  assert.equal(gh.calls.length, 2, 'no retry inside a minute');

  tick(30_001);
  issues['acme/acme#1'] = { state: 'closed', title: 'Door' };
  const recovered = await states.get();
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.states['acme/acme#1'].state, 'closed');
  assert.equal(gh.calls.length, 3);
});

test('a task brought back from the archive is read again, not served its old state as fresh', async () => {
  const links = { list: [link('acme/acme', 1)] };
  const issues = { 'acme/acme#1': { state: 'open', title: 'Door' }, 'acme/acme#2': { state: 'open', title: 'Roof' } };
  const { states, gh, tick } = harness({ links, issues });
  assert.equal((await states.get()).states['acme/acme#1'].state, 'open');

  // Its task is archived; another issue is read ten minutes later; then it comes back.
  links.list = [link('acme/acme', 2)];
  issues['acme/acme#1'].state = 'closed';
  tick(10 * 60_000);
  await states.get();
  links.list = [link('acme/acme', 1), link('acme/acme', 2)];
  const back = await states.get();
  assert.equal(back.states['acme/acme#1'].state, 'closed');
  assert.equal(gh.calls.filter((call) => call.endsWith('/issues/1')).length, 2);
  assert.equal(back.fetchedAt, '2026-11-09T12:10:00.000Z');
});

test('an issue still failing keeps the error after another issue reads fine', async () => {
  const links = { list: [link('acme/acme', 2)] };
  const issues = { 'acme/acme#2': new Error('gh: Not Found (HTTP 404)'), 'acme/acme#3': { state: 'open', title: 'New' } };
  const { states, tick } = harness({ links, issues });
  assert.match((await states.get()).error, /^acme\/acme#2: Repository not found/);

  tick(10_000);
  links.list = [link('acme/acme', 2), link('acme/acme', 3)];
  const answer = await states.get();
  assert.equal(answer.states['acme/acme#3'].state, 'open');
  assert.equal(answer.states['acme/acme#2'], undefined);
  assert.match(answer.error, /^acme\/acme#2: /, 'the failing issue is still named');

  // Unlinked, it is forgotten, error and all.
  links.list = [link('acme/acme', 3)];
  assert.equal((await states.get()).error, undefined);
});

test('with no reading ever, a failure answers no states, a null fetchedAt and the error', async () => {
  const links = { list: [link('acme/acme', 1), link('acme/acme', 2)] };
  const { states } = harness({ links, issues: { 'acme/acme#2': new Error('spawn gh ENOENT') } });
  const answer = await states.get();
  assert.equal(answer.fetchedAt, null);
  assert.deepEqual(answer.states, {});
  assert.match(answer.error, /^2 issues could not be read/);
});

test('concurrent requests share one read, and nothing is read with no links', async () => {
  const links = { list: [] };
  const { states, gh } = harness({ links, issues: { 'acme/acme#1': { state: 'open', title: 'Door' } } });
  assert.deepEqual(await states.get(), { fetchedAt: null, states: {} });
  links.list = [link('acme/acme', 1)];
  await Promise.all([states.get(), states.get(), states.get()]);
  assert.equal(gh.calls.length, 1);
});

test('callers waiting on one read share the next one too, never a read each', async () => {
  const links = { list: [link('acme/acme', 1)] };
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = async (args) => {
    calls.push(args.join(' '));
    if (calls.length === 1) await gate;
    return JSON.stringify({ state: 'open', title: 't', html_url: 'https://github.com/x' });
  };
  const states = createIssueStates({ links: () => links.list, run, now: () => T0 });
  const first = states.get();
  const waiting = [states.get(), states.get(), states.get()];
  // A link is added while the first read is out: everyone who waited needs it.
  links.list = [link('acme/acme', 1), link('acme/acme', 2)];
  release();
  const answers = await Promise.all([first, ...waiting]);
  assert.deepEqual(calls, ['api repos/acme/acme/issues/1', 'api repos/acme/acme/issues/2']);
  for (const answer of answers.slice(1)) assert.deepEqual(Object.keys(answer.states).sort(), ['acme/acme#1', 'acme/acme#2']);
});

test('at most fifty issues are asked for', async () => {
  const many = Array.from({ length: 60 }, (_, i) => link('acme/acme', i + 1));
  let asked = null;
  const gh = fakeGh(Object.fromEntries(many.map((l) => [l.key, { state: 'open', title: l.key }])));
  const states = createIssueStates({ links: ({ limit }) => { asked = limit; return many; }, run: gh.run });
  const answer = await states.get();
  assert.equal(asked, ISSUE_STATES_MAX);
  assert.equal(ISSUE_STATES_MAX, 50);
  assert.equal(Object.keys(answer.states).length, 50);
  assert.equal(gh.calls.length, 50);
});

test('parseIssueUrl accepts only https://github.com/<owner>/<repo>/issues/<n>', () => {
  assert.deepEqual(parseIssueUrl(' https://github.com/acme/acme.js/issues/12/ '), {
    repo: 'acme/acme.js', number: 12, url: 'https://github.com/acme/acme.js/issues/12',
  });
  for (const bad of [
    'https://github.com/acme/acme/pull/12', 'https://github.com/acme/acme/pulls/12',
    'https://github.com/acme/acme/issues', 'https://github.com/acme/acme/issues/12/comments',
    'https://www.github.com/acme/acme/issues/12', 'https://github.com:8443/acme/acme/issues/12',
    'https://user@github.com/acme/acme/issues/12', 'https://github.com/-acme/acme/issues/12',
    'https://github.com/acme/../issues/12', 'javascript:alert(1)', '', '   ', null, undefined, {},
  ]) {
    assert.throws(() => parseIssueUrl(bad), (error) => error.code === 'INVALID_ISSUE_LINK', String(bad));
  }
  assert.throws(() => parseIssueUrl('https://github.com/acme/acme/pull/12'), /pull request/);
  assert.equal(issueLinkFromUrl('https://github.com/acme/acme/pull/12'), null);
  assert.equal(issueLinkFromUrl(null), null);
});
