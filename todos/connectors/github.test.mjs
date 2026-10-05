import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { closeTodoDatabase, openTodoDatabase } from '../db.mjs';
import { createTodoService } from '../service.mjs';
import { createGitHubClient } from './github-client.mjs';
import { createGitHubConnector } from './github-sync.mjs';
import {
  autoTrackQueries,
  parseIssueIdentifier,
  selectIssues,
} from './github-policy.mjs';
import { seedVentureTags } from '../test-support.mjs';

const NOW = '2026-09-12T12:00:00.000Z';
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('auto-track queries are forward-only, assigned OR watched, and chunk repos at 20', () => {
  const watchedRepos = Array.from({ length: 21 }, (_, index) => `acme/repo-${index + 1}`);
  assert.deepEqual(autoTrackQueries({
    watermark: '2026-09-10T12:00:00.000Z',
    trackAssigned: true,
    assignedRepos: watchedRepos,
    watchedRepos: ['acme/acme'],
  }), [
    `is:issue is:open created:>2026-09-10T12:00:00.000Z assignee:@me ${watchedRepos.slice(0, 20).map(repo => `repo:${repo}`).join(' ')}`,
    'is:issue is:open created:>2026-09-10T12:00:00.000Z assignee:@me repo:acme/repo-21',
    'is:issue is:open created:>2026-09-10T12:00:00.000Z repo:acme/acme',
  ]);
});

test('manual identifiers are explicit and ambiguous bare repo names are rejected', () => {
  assert.deepEqual(parseIssueIdentifier('acme/acme#42'), { repo: 'acme/acme', number: 42 });
  assert.deepEqual(parseIssueIdentifier('#42', { selectedRepo: 'acme/acme' }), { repo: 'acme/acme', number: 42 });
  assert.throws(() => parseIssueIdentifier('acme#42'), error => error.code === 'AMBIGUOUS_GITHUB_ISSUE');
});

test('issue selection excludes pull requests, dedupes numeric ids, sorts updated-desc, and caps 50', () => {
  const issues = Array.from({ length: 55 }, (_, index) => ({
    id: String(index + 1),
    title: `Issue ${index + 1}`,
    updatedAt: new Date(Date.parse(NOW) - index * 1000).toISOString(),
  }));
  const selected = selectIssues([
    ...issues,
    { ...issues[0], title: 'duplicate' },
    { id: 'pr-1', title: 'PR', updatedAt: NOW, pullRequest: true },
  ]);
  assert.equal(selected.length, 50);
  assert.equal(selected[0].id, '1');
  assert.equal(selected.at(-1).id, '50');
});

test('GitHub client shapes gh JSON and never treats a pull request as an issue', async () => {
  const commands = [];
  const execFile = (file, args, options, callback) => {
    commands.push([file, args]);
    callback(null, {
      stdout: JSON.stringify([{
        id: 90042,
        number: 42,
        title: 'A result',
        body: 'Details',
        state: 'open',
        html_url: 'https://github.com/acme/acme/issues/42',
        repository_url: 'https://api.github.com/repos/acme/acme',
        created_at: NOW,
        updated_at: NOW,
        pull_request: { url: 'https://api.github.com/repos/acme/acme/pulls/42' },
      }]),
      stderr: '',
    });
  };
  const client = createGitHubClient({ execFile });

  assert.deepEqual(await client.searchIssues('is:issue is:open door'), [{
    id: '90042', number: 42, repo: 'acme/acme', title: 'A result', body: 'Details',
    state: 'open', url: 'https://github.com/acme/acme/issues/42',
    createdAt: NOW, updatedAt: NOW, pullRequest: true,
  }]);
  assert.deepEqual(commands, [['gh', ['api', '--method', 'GET', 'search/issues', '-f', 'q=is:issue is:open door', '-f', 'per_page=100', '--jq', '.items']]]);
});

test('GitHub client enumerates every accessible repository for assigned-query chunking', async () => {
  const commands = [];
  const client = createGitHubClient({
    execFile(file, args, options, callback) {
      commands.push([file, args]);
      callback(null, { stdout: 'acme/one\nother/two\n', stderr: '' });
    },
  });

  assert.deepEqual(await client.listAssignedRepos(), ['acme/one', 'other/two']);
  assert.deepEqual(commands[0], ['gh', [
    'api', '--method', 'GET', '--paginate', 'user/repos',
    '-f', 'affiliation=owner,collaborator,organization_member', '-f', 'per_page=100',
    '--jq', '.[].full_name',
  ]]);
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'totem-github-'));
  directories.push(directory);
  const db = openTodoDatabase({ file: join(directory, 'todos.db'), now: () => NOW });
  seedVentureTags(db);
  const actions = [];
  const service = createTodoService({
    db,
    now: () => NOW,
    makeId: (() => { let id = 0; return () => `id-${++id}`; })(),
    actionLog: { record(entry) { actions.push(entry); } },
  });
  return { actions, db, service, close: () => closeTodoDatabase(db) };
}

function issue(overrides = {}) {
  return {
    id: '102',
    repo: 'acme/acme',
    number: 42,
    title: 'Fix the door',
    body: '',
    state: 'open',
    url: 'https://github.com/acme/acme/issues/42',
    createdAt: '2026-09-12T12:00:00.001Z',
    updatedAt: '2026-09-12T12:01:00.000Z',
    pullRequest: false,
    ...overrides,
  };
}

function connectorFixture(clientOverrides = {}) {
  const base = fixture();
  const calls = [];
  const issues = new Map([['102', issue()]]);
  const client = {
    async listAssignedRepos() { return ['acme/acme']; },
    async searchIssues(query) { calls.push(['search', query]); return [...issues.values()]; },
    async getIssue({ id, repo, number }) {
      calls.push(['get', id, repo, number]);
      return issues.get(String(id)) ?? [...issues.values()].find(item => item.repo === repo && item.number === number);
    },
    async createIssue(input) { calls.push(['create', input]); const value = issue({ id: '201', number: 51, title: input.title, body: input.body }); issues.set('201', value); return value; },
    async editIssue(input) { calls.push(['edit', input]); const value = issues.get(String(input.id)); Object.assign(value, input.title === undefined ? {} : { title: input.title }, input.body === undefined ? {} : { body: input.body }); return value; },
    ...clientOverrides,
  };
  const connector = createGitHubConnector({
    db: base.db,
    service: base.service,
    client,
    now: () => NOW,
    workerId: 'test-worker',
    actionLog: { record(entry) { base.actions.push(entry); } },
  });
  return { ...base, calls, client, connector, issues };
}

test('first enabling auto-track stamps one immutable watermark', () => {
  const { connector, close } = connectorFixture();
  assert.deepEqual(connector.updateSettings({ trackAssigned: true }), {
    trackAssigned: true,
    watchedRepos: [],
    watermark: NOW,
  });
  connector.updateSettings({ trackAssigned: false });
  assert.equal(connector.updateSettings({ trackAssigned: true }).watermark, NOW);
  close();
});

test('reconcile imports assigned OR watched issues once by stable numeric id', async () => {
  const { connector, service, close } = connectorFixture();
  connector.updateSettings({ trackAssigned: true, watchedRepos: ['acme/acme'] });

  const result = await connector.reconcile();
  const tasks = service.list({ source: 'github' });

  assert.equal(result.pulled, 1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Fix the door');
  assert.equal(tasks[0].externalLinks[0].externalId, '102');
  await connector.reconcile();
  assert.equal(service.list({ source: 'github' }).length, 1);
  close();
});

test('refresh owns close and reopen while an open rename preserves doing', async () => {
  const { connector, issues, service, close } = connectorFixture();
  const task = await connector.link({ issueId: '102' });
  service.move(task.id, 'doing');
  issues.set('102', issue({ title: 'Remote rename' }));
  const renamed = await connector.refreshTask(task.id);
  assert.deepEqual({ title: renamed.title, status: renamed.status }, { title: 'Remote rename', status: 'doing' });
  issues.set('102', issue({ title: 'Remote rename', state: 'closed' }));
  assert.equal((await connector.refreshTask(task.id)).status, 'done');
  issues.set('102', issue({ title: 'Remote rename', state: 'open' }));
  assert.equal((await connector.refreshTask(task.id)).status, 'todo');
  close();
});

test('only a 404 marks a GitHub link missing and later success recovers it', async () => {
  let failure = Object.assign(new Error('forbidden'), { status: 403 });
  const { connector, service, close } = connectorFixture({
    async getIssue() { if (failure) throw failure; return issue(); },
  });
  const task = service.create({ title: 'Original', area: 'Personal' });
  service.attachExternalLink(task.id, { connector: 'github', externalId: '102' });

  await assert.rejects(connector.refreshTask(task.id), /forbidden/);
  assert.equal(service.get(task.id).externalLinks[0].missingAt, null);
  assert.equal(service.get(task.id).title, 'Original');
  failure = Object.assign(new Error('not found'), { status: 404 });
  await assert.rejects(connector.refreshTask(task.id), /not found/);
  assert.equal(service.get(task.id).externalLinks[0].missingAt, NOW);
  failure = null;
  assert.equal((await connector.refreshTask(task.id)).externalLinks[0].missingAt, null);
  close();
});

test('rename and publish mutate only issue title and body, with no empty-note call', async () => {
  const { calls, connector, service, close } = connectorFixture();
  const task = await connector.link({ issueId: '102' });
  await connector.publishFirstNote(task.id);
  assert.equal(calls.filter(([kind]) => kind === 'edit').length, 0);
  service.addNote(task.id, 'First durable note');
  await connector.rename(task.id, 'New title');
  await connector.publishFirstNote(task.id);
  assert.deepEqual(calls.filter(([kind]) => kind === 'edit').map(([, input]) => Object.keys(input).sort()), [
    ['id', 'number', 'repo', 'title'],
    ['body', 'id', 'number', 'repo'],
  ]);
  assert.match(calls.at(-1)[1].body, /^First durable note\n\n<!-- totem-id:id-1 -->$/);
  close();
});

test('create embeds an immutable marker and ambiguous retry finds it before creating twice', async () => {
  let createCalls = 0;
  const created = issue({ id: '301', number: 61, title: 'Ship it', body: '<!-- totem-id:id-1 -->' });
  const { connector, service, close } = connectorFixture({
    async createIssue() { createCalls += 1; throw new Error('connection lost after write'); },
    async searchIssues(query) { return query.includes('totem-id:id-1') ? [created] : []; },
  });

  const task = await connector.create({ title: 'Ship it', area: 'Personal', repo: 'acme/acme' });
  assert.equal(createCalls, 1);
  assert.equal(task.externalLinks[0].externalId, '301');
  assert.equal(service.list({ source: 'github' }).length, 1);
  close();
});

test('pull failure does not suppress an independently queued GitHub write', async () => {
  const { actions, connector, db, service, close } = connectorFixture({
    async listAssignedRepos() { throw Object.assign(new Error('search unavailable'), { status: 403 }); },
  });
  const task = await connector.link({ issueId: '102' });
  connector.updateSettings({ trackAssigned: true });
  db.prepare(`
    INSERT INTO sync_outbox (
      id, todo_id, connector, operation, payload, idempotency_key, status,
      attempts, created_at, updated_at
    ) VALUES (?, ?, 'github', 'rename', ?, ?, 'pending', 0, ?, ?)
  `).run('queued-rename', task.id, JSON.stringify({ title: 'Queued rename' }), 'queued-rename', NOW, NOW);

  const result = await connector.reconcile();

  assert.match(result.pullError, /search unavailable/);
  assert.equal(result.outbox.processed, 1);
  assert.equal(db.prepare("SELECT status FROM sync_outbox WHERE id = 'queued-rename'").get().status, 'completed');
  assert.equal(service.get(task.id).title, 'Queued rename');
  assert.ok(actions.some(action => action.action === 'github.sync.error'));
  close();
});

test('expired leases are reclaimed and terminal retries exhaust exactly once', async () => {
  let fail = false;
  const { actions, connector, db, service, close } = connectorFixture({
    async editIssue(input) {
      if (fail) throw new Error('still offline');
      return issue({ title: input.title });
    },
  });
  const task = await connector.link({ issueId: '102' });
  db.prepare(`
    INSERT INTO sync_outbox (
      id, todo_id, connector, operation, payload, idempotency_key, status,
      attempts, lease_owner, lease_expires_at, created_at, updated_at
    ) VALUES (?, ?, 'github', 'rename', ?, ?, 'leased', 1, 'dead-worker', ?, ?, ?)
  `).run('expired', task.id, JSON.stringify({ title: 'Recovered lease' }), 'expired', '2026-09-12T11:59:00.000Z', NOW, NOW);
  assert.equal((await connector.reconcile()).outbox.processed, 1);
  assert.equal(service.get(task.id).title, 'Recovered lease');

  fail = true;
  db.prepare(`
    INSERT INTO sync_outbox (
      id, todo_id, connector, operation, payload, idempotency_key, status,
      attempts, next_attempt_at, last_error, created_at, updated_at
    ) VALUES (?, ?, 'github', 'rename', ?, ?, 'retry', 4, ?, 'offline', ?, ?)
  `).run('will-exhaust', task.id, JSON.stringify({ title: 'Never lands' }), 'will-exhaust', NOW, NOW, NOW);
  const exhausted = await connector.reconcile();
  assert.equal(exhausted.outbox.exhausted, 1);
  assert.deepEqual({ ...db.prepare(`
    SELECT status, attempts, lease_owner, lease_expires_at, last_error
    FROM sync_outbox WHERE id = 'will-exhaust'
  `).get() }, {
    status: 'exhausted', attempts: 5, lease_owner: null, lease_expires_at: null, last_error: 'still offline',
  });
  await connector.reconcile();
  assert.equal(actions.filter(action => action.action === 'github.outbox.exhausted').length, 1);
  close();
});

test('a failed explicit rename is durably queued and leaves the local title unchanged', async () => {
  const { connector, db, service, close } = connectorFixture({
    async editIssue() { throw new Error('network down'); },
  });
  const task = await connector.link({ issueId: '102' });

  await assert.rejects(connector.rename(task.id, 'Must survive'), /network down/);

  assert.equal(service.get(task.id).title, 'Fix the door');
  assert.deepEqual({ ...db.prepare(`
    SELECT operation, status, attempts, last_error FROM sync_outbox WHERE todo_id = ?
  `).get(task.id) }, {
    operation: 'rename', status: 'retry', attempts: 1, last_error: 'network down',
  });
  close();
});

test('a failed explicit create keeps the local task and durable create intent', async () => {
  const { connector, db, service, close } = connectorFixture({
    async createIssue() { throw new Error('write timed out'); },
    async searchIssues() { return []; },
  });

  await assert.rejects(
    connector.create({ title: 'Durable create', area: 'Personal', repo: 'acme/acme' }),
    /write timed out/,
  );

  const task = service.list({ search: 'Durable create' })[0];
  assert.ok(task);
  assert.equal(task.externalLinks.length, 0);
  assert.deepEqual({ ...db.prepare(`
    SELECT operation, status, attempts, last_error FROM sync_outbox WHERE todo_id = ?
  `).get(task.id) }, {
    operation: 'create', status: 'retry', attempts: 1, last_error: 'write timed out',
  });
  close();
});
