import { TodoDomainError } from '../errors.mjs';
import { withTodoTransaction } from '../db.mjs';
import { randomUUID } from 'node:crypto';
import { autoTrackQueries, normalizeRepo, parseIssueIdentifier, selectIssues } from './github-policy.mjs';

const CONNECTOR = 'github';
const DEFAULT_SETTINGS = Object.freeze({ trackAssigned: false, watchedRepos: [], watermark: null });
const MAX_OUTBOX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60 * 1000;

function snapshot(issue) {
  return {
    id: String(issue.id),
    repo: issue.repo,
    number: Number(issue.number),
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function completed(issue) {
  return String(issue.state).toLowerCase() === 'closed';
}

function statusOf(error) {
  return Number(error?.status ?? error?.statusCode ?? error?.code);
}

function context(reason) {
  return { actor: 'job', reason };
}

export function createGitHubConnector({ db, service, client, now = () => new Date().toISOString(), workerId, actionLog } = {}) {
  if (!db || !service || !client || !workerId || !actionLog?.record) {
    throw new TypeError('createGitHubConnector requires db, service, client, workerId, and actionLog');
  }

  function ensureState() {
    const at = now();
    db.prepare(`
      INSERT OR IGNORE INTO connector_state (connector, settings_json, created_at, updated_at)
      VALUES (?, '{}', ?, ?)
    `).run(CONNECTOR, at, at);
    return db.prepare('SELECT * FROM connector_state WHERE connector = ?').get(CONNECTOR);
  }

  function getSettings() {
    const row = ensureState();
    let stored = {};
    try { stored = JSON.parse(row.settings_json || '{}'); } catch { stored = {}; }
    return {
      trackAssigned: stored.trackAssigned === true,
      watchedRepos: Array.isArray(stored.watchedRepos)
        ? [...new Set(stored.watchedRepos.map(normalizeRepo))]
        : [],
      watermark: row.watermark ?? null,
    };
  }

  function updateSettings(patch = {}) {
    const current = getSettings();
    const next = {
      trackAssigned: patch.trackAssigned === undefined ? current.trackAssigned : patch.trackAssigned === true,
      watchedRepos: patch.watchedRepos === undefined
        ? current.watchedRepos
        : [...new Set(patch.watchedRepos.map(normalizeRepo))],
      watermark: current.watermark,
    };
    const enabled = next.trackAssigned || next.watchedRepos.length > 0;
    if (enabled && !next.watermark) next.watermark = now();
    const at = now();
    db.prepare(`
      UPDATE connector_state SET settings_json = ?, watermark = ?, updated_at = ? WHERE connector = ?
    `).run(JSON.stringify({ trackAssigned: next.trackAssigned, watchedRepos: next.watchedRepos }), next.watermark, at, CONNECTOR);
    return next;
  }

  function record(action, target, summary, detail, status = 'ok', error = null) {
    actionLog.record({ action, actor: 'job', target, status, summary, why: summary, detail, error });
  }

  function recordHealthSuccess() {
    const at = now();
    ensureState();
    db.prepare(`
      UPDATE connector_state SET last_success_at = ?, last_error = NULL, updated_at = ? WHERE connector = ?
    `).run(at, at, CONNECTOR);
  }

  function recordHealthError(error, target = 'github') {
    const at = now();
    ensureState();
    db.prepare(`UPDATE connector_state SET last_error = ?, updated_at = ? WHERE connector = ?`)
      .run(String(error?.message ?? error), at, CONNECTOR);
    record('github.sync.error', target, 'GitHub task sync failed', null, 'error', String(error?.message ?? error));
  }

  function linkRowForTask(taskId) {
    return db.prepare(`
      SELECT * FROM external_links WHERE todo_id = ? AND connector = 'github'
    `).get(taskId);
  }

  function linkedTaskForIssue(issueId) {
    return db.prepare(`
      SELECT todo_id FROM external_links WHERE connector = 'github' AND external_id = ?
    `).get(String(issueId));
  }

  function observe(taskId, issue, { initialStatus } = {}) {
    return service.applyExternalObservation({
      taskId,
      connector: CONNECTOR,
      externalId: String(issue.id),
      completed: completed(issue),
      initialStatus,
      title: issue.title,
      sourceStatus: issue.state,
      sourceSnapshot: snapshot(issue),
      externalUrl: issue.url,
      observedAt: now(),
      lastSyncedAt: now(),
      missing: false,
    }, context('Observed authoritative GitHub issue state'));
  }

  function attach(issue, { initialStatus = 'todo', context: callerContext } = {}) {
    if (!issue || issue.pullRequest || issue.pull_request || issue.isPullRequest) {
      throw new TodoDomainError('GITHUB_PULL_REQUEST_NOT_SUPPORTED', 'Totem tasks can link GitHub issues, not pull requests.');
    }
    const existing = linkedTaskForIssue(issue.id);
    if (existing) return observe(existing.todo_id, issue);
    const task = service.create({
      title: issue.title,
      description: issue.body ?? '',
      area: 'Personal',
      status: completed(issue) ? 'done' : initialStatus,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      completedAt: completed(issue) ? issue.updatedAt : null,
    }, callerContext ?? context('Imported GitHub issue'));
    service.attachExternalLink(task.id, {
      connector: CONNECTOR,
      externalId: String(issue.id),
      externalUrl: issue.url,
      sourceStatus: issue.state,
      sourceSnapshot: snapshot(issue),
      lastSyncSnapshot: snapshot(issue),
      initialStatusSeeded: true,
      lastObservedAt: now(),
      lastSyncedAt: now(),
    }, callerContext ?? context('Linked GitHub issue'));
    return observe(task.id, issue, { initialStatus });
  }

  async function search({ query = '', selectedRepo, assigned = false } = {}) {
    const identifier = parseIssueIdentifier(query, { selectedRepo });
    let issues;
    if (identifier) {
      const found = await client.getIssue(identifier);
      issues = found ? [found] : [];
    } else {
      const qualifiers = ['is:issue', String(query).trim()];
      if (assigned) qualifiers.push('assignee:@me');
      if (selectedRepo) qualifiers.push(`repo:${normalizeRepo(selectedRepo)}`);
      issues = await client.searchIssues(qualifiers.filter(Boolean).join(' '));
    }
    return { issues: selectIssues(issues) };
  }

  async function link({ issueId, identifier, selectedRepo, initialStatus = 'todo' } = {}, callerContext) {
    let found;
    if (issueId != null) found = await client.getIssue({ id: String(issueId) });
    else {
      const parsed = parseIssueIdentifier(identifier, { selectedRepo });
      if (!parsed) throw new TodoDomainError('INVALID_GITHUB_ISSUE', 'Use owner/repo#number to link an issue.');
      found = await client.getIssue(parsed);
    }
    if (!found) throw new TodoDomainError('GITHUB_ISSUE_NOT_FOUND', 'GitHub issue not found.', { status: 404 });
    return attach(found, { initialStatus, context: callerContext });
  }

  // Issues are found again by the hidden `<!-- totem-id:… -->` marker in their body.
  // Back-compat: bodies written before the 2026-10-02 rename carry `vesper-id:`
  // instead (and so may a create still queued in the outbox), so search for that
  // too. Can go once no open issue or pending outbox row holds the old marker.
  async function searchByMarker(repo, taskId) {
    const current = selectIssues(await client.searchIssues(`is:issue repo:${repo} "totem-id:${taskId}"`));
    if (current.length) return current;
    return selectIssues(await client.searchIssues(`is:issue repo:${repo} "vesper-id:${taskId}"`));
  }

  async function create(input = {}, callerContext) {
    const repo = normalizeRepo(input.repo);
    const existingTodoId = input.existingTodoId;
    const task = existingTodoId
      ? service.get(existingTodoId)
      : service.create(input, callerContext);
    if (!task) throw new TodoDomainError('TODO_NOT_FOUND', 'Todo not found.', { status: 404 });
    const marker = `<!-- totem-id:${task.id} -->`;
    const body = [input.description ?? task.description, marker].filter(Boolean).join('\n\n');
    const outboxId = enqueueOutbox(task.id, 'create', { repo, body }, callerContext);
    return finishQueued(outboxId, task.id);
  }

  async function rename(taskId, title, callerContext) {
    const task = service.get(taskId);
    const link = linkRowForTask(taskId);
    if (!task || !link) throw new TodoDomainError('GITHUB_LINK_NOT_FOUND', 'Todo is not linked to GitHub.', { status: 404 });
    const outboxId = enqueueOutbox(taskId, 'rename', { title }, callerContext);
    return finishQueued(outboxId, taskId);
  }

  async function publishFirstNote(taskId) {
    const task = service.get(taskId);
    const link = linkRowForTask(taskId);
    if (!task || !link) throw new TodoDomainError('GITHUB_LINK_NOT_FOUND', 'Todo is not linked to GitHub.', { status: 404 });
    const note = task.notes[0];
    if (!note) return task;
    const body = `${note.body}\n\n<!-- totem-id:${task.id} -->`;
    const outboxId = enqueueOutbox(taskId, 'publish-description', { body, noteId: note.id });
    return finishQueued(outboxId, taskId);
  }

  async function refreshTask(taskId) {
    const task = service.get(taskId);
    const link = linkRowForTask(taskId);
    if (!task || !link) throw new TodoDomainError('GITHUB_LINK_NOT_FOUND', 'Todo is not linked to GitHub.', { status: 404 });
    const source = JSON.parse(link.source_snapshot || '{}');
    try {
      const found = await client.getIssue({ id: link.external_id, repo: source.repo, number: source.number });
      if (!found || found.pullRequest || found.pull_request || found.isPullRequest) {
        throw new TodoDomainError('MALFORMED_GITHUB_ISSUE', 'GitHub returned no valid issue.');
      }
      const result = observe(taskId, found);
      recordHealthSuccess();
      return result;
    } catch (error) {
      if (statusOf(error) === 404) {
        service.applyExternalObservation({
          taskId,
          connector: CONNECTOR,
          completed: task.status === 'done',
          sourceStatus: link.source_status,
          observedAt: now(),
          missing: true,
          missingAt: now(),
        }, context('GitHub reported issue missing'));
        record('github.issue.missing', taskId, 'GitHub issue returned 404', null, 'error', String(error.message));
      }
      recordHealthError(error, taskId);
      throw error;
    }
  }

  function enqueueOutbox(taskId, operation, payload, callerContext) {
    const id = randomUUID();
    const at = now();
    const requestId = callerContext?.correlationId ?? randomUUID();
    db.prepare(`
      INSERT INTO sync_outbox (
        id, todo_id, connector, operation, payload, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, 'github', ?, ?, ?, ?, ?)
    `).run(id, taskId, operation, JSON.stringify(payload), `${operation}:${taskId}:${requestId}`, at, at);
    return id;
  }

  async function finishQueued(outboxId, taskId) {
    await drainOutbox();
    const row = db.prepare('SELECT status, last_error FROM sync_outbox WHERE id = ?').get(outboxId);
    if (row?.status === 'completed') {
      recordHealthSuccess();
      return service.get(taskId);
    }
    throw new Error(row?.last_error || 'GitHub write was queued for retry');
  }

  function claimOutbox() {
    return withTodoTransaction(db, () => {
      const at = now();
      db.prepare(`
        UPDATE sync_outbox SET status = 'retry', lease_owner = NULL, lease_expires_at = NULL,
          next_attempt_at = COALESCE(next_attempt_at, ?), updated_at = ?
        WHERE connector = 'github' AND status = 'leased' AND lease_expires_at <= ?
      `).run(at, at, at);
      const row = db.prepare(`
        SELECT * FROM sync_outbox
        WHERE connector = 'github'
          AND status IN ('pending', 'retry')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at, id LIMIT 1
      `).get(at);
      if (!row) return null;
      const leaseExpiresAt = new Date(Date.parse(at) + LEASE_MS).toISOString();
      db.prepare(`
        UPDATE sync_outbox SET status = 'leased', attempts = attempts + 1,
          lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?
      `).run(workerId, leaseExpiresAt, at, row.id);
      return { ...row, status: 'leased', attempts: Number(row.attempts) + 1, lease_owner: workerId, lease_expires_at: leaseExpiresAt };
    });
  }

  async function performOutbox(row) {
    let payload;
    try { payload = JSON.parse(row.payload); }
    catch { throw new Error('Malformed GitHub outbox payload'); }
    const task = row.todo_id ? service.get(row.todo_id) : null;
    if (!task) throw new Error('GitHub outbox task no longer exists');
    const link = linkRowForTask(task.id);
    if (row.operation === 'rename') {
      if (!link) throw new Error('GitHub rename outbox task is not linked');
      const source = JSON.parse(link.source_snapshot || '{}');
      const edited = await client.editIssue({ id: link.external_id, repo: source.repo, number: source.number, title: payload.title });
      observe(task.id, edited ?? { ...source, id: link.external_id, title: payload.title });
      record('github.issue.rename', task.id, `Renamed GitHub issue to "${payload.title}"`, { title: payload.title });
      return;
    }
    if (row.operation === 'publish-description') {
      if (!link) throw new Error('GitHub publish outbox task is not linked');
      const source = JSON.parse(link.source_snapshot || '{}');
      const edited = await client.editIssue({ id: link.external_id, repo: source.repo, number: source.number, body: payload.body });
      observe(task.id, edited ?? { ...source, id: link.external_id, body: payload.body });
      record('github.issue.publish-description', task.id, 'Published a local note to the GitHub issue body', { noteId: payload.noteId });
      return;
    }
    if (row.operation === 'create') {
      let remote = null;
      if (row.attempts > 1) {
        const matches = await searchByMarker(payload.repo, task.id);
        if (matches.length === 1) remote = matches[0];
      }
      if (!remote) {
        try {
          remote = await client.createIssue({ repo: payload.repo, title: task.title, body: payload.body });
        } catch (error) {
          const matches = await searchByMarker(payload.repo, task.id);
          if (matches.length !== 1) throw error;
          remote = matches[0];
        }
      }
      if (!link) {
        service.attachExternalLink(task.id, {
          connector: CONNECTOR,
          externalId: String(remote.id),
          externalUrl: remote.url,
          sourceStatus: remote.state,
          sourceSnapshot: snapshot(remote),
          lastSyncSnapshot: snapshot(remote),
          initialStatusSeeded: true,
          lastObservedAt: now(),
          lastSyncedAt: now(),
        }, context('Linked newly created GitHub issue'));
        observe(task.id, remote);
      }
      record('github.issue.create', task.id, `Created GitHub issue ${remote.repo}#${remote.number}`, { repo: remote.repo, number: remote.number });
      return;
    }
    throw new Error(`Unsupported GitHub outbox operation: ${row.operation}`);
  }

  async function drainOutbox() {
    let processed = 0;
    let exhausted = 0;
    while (true) {
      const row = claimOutbox();
      if (!row) break;
      try {
        await performOutbox(row);
        const at = now();
        db.prepare(`
          UPDATE sync_outbox SET status = 'completed', lease_owner = NULL,
            lease_expires_at = NULL, last_error = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ?
        `).run(at, at, row.id, workerId);
        processed += 1;
      } catch (error) {
        const at = now();
        recordHealthError(error, row.todo_id ?? row.id);
        if (row.attempts >= MAX_OUTBOX_ATTEMPTS) {
          db.prepare(`
            UPDATE sync_outbox SET status = 'exhausted', lease_owner = NULL,
              lease_expires_at = NULL, next_attempt_at = NULL, last_error = ?, updated_at = ?
            WHERE id = ? AND status = 'leased' AND lease_owner = ?
          `).run(String(error.message ?? error), at, row.id, workerId);
          record('github.outbox.exhausted', row.todo_id ?? row.id, 'GitHub write exhausted its retry budget', { operation: row.operation, attempts: row.attempts }, 'error', String(error.message ?? error));
          exhausted += 1;
        } else {
          const delay = Math.min(60, 2 ** Math.max(0, row.attempts - 1));
          const retryAt = new Date(Date.parse(at) + delay * 60 * 1000).toISOString();
          db.prepare(`
            UPDATE sync_outbox SET status = 'retry', lease_owner = NULL,
              lease_expires_at = NULL, next_attempt_at = ?, last_error = ?, updated_at = ?
            WHERE id = ? AND status = 'leased' AND lease_owner = ?
          `).run(retryAt, String(error.message ?? error), at, row.id, workerId);
          record('github.outbox.retry', row.todo_id ?? row.id, 'GitHub write queued for retry', { operation: row.operation, attempts: row.attempts }, 'error', String(error.message ?? error));
        }
      }
    }
    return { processed, exhausted };
  }

  async function reconcile() {
    const settings = getSettings();
    let pulled = 0;
    let pullError = null;
    try {
      const assignedRepos = settings.trackAssigned ? await client.listAssignedRepos() : [];
      // A client that knows its own login (the GitHub App) names it; one that acts as
      // the user (the CLI) leaves it undefined and the policy falls back to @me.
      const assignee = typeof client.login === 'function' ? await client.login() : undefined;
      const queries = autoTrackQueries({ ...settings, assignedRepos, assignee });
      const candidates = selectIssues((await Promise.all(queries.map(query => client.searchIssues(query)))).flat());
      for (const candidate of candidates) {
        const existed = Boolean(linkedTaskForIssue(candidate.id));
        attach(candidate);
        if (!existed) pulled += 1;
      }
      const links = db.prepare(`SELECT todo_id FROM external_links WHERE connector = 'github' ORDER BY id`).all();
      for (const row of links) await refreshTask(row.todo_id);
      recordHealthSuccess();
    } catch (error) {
      pullError = error;
      recordHealthError(error);
    }
    const outbox = await drainOutbox();
    return { pulled, pullError: pullError?.message ?? null, outbox };
  }

  return {
    search,
    link,
    create,
    rename,
    publishFirstNote,
    refreshTask,
    reconcile,
    getSettings,
    updateSettings,
    getHealth() {
      const row = ensureState();
      return { status: row.last_error ? 'error' : row.last_success_at ? 'ok' : 'idle', lastSuccessAt: row.last_success_at, lastError: row.last_error };
    },
  };
}
