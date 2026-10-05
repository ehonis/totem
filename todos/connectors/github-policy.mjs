import { TodoDomainError } from '../errors.mjs';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function normalizeRepo(value) {
  const repo = String(value ?? '').trim();
  if (!REPO.test(repo)) {
    throw new TodoDomainError('INVALID_GITHUB_REPO', 'GitHub repository must be owner/name.');
  }
  return repo;
}

export function parseIssueIdentifier(value, { selectedRepo } = {}) {
  const input = String(value ?? '').trim();
  let match = /^([^/#\s]+\/[^#\s]+)#(\d+)$/.exec(input);
  if (match) return { repo: normalizeRepo(match[1]), number: Number(match[2]) };
  match = /^#(\d+)$/.exec(input);
  if (match && selectedRepo) return { repo: normalizeRepo(selectedRepo), number: Number(match[1]) };
  if (/^[^/#\s]+#\d+$/.test(input)) {
    throw new TodoDomainError(
      'AMBIGUOUS_GITHUB_ISSUE',
      'Use owner/repo#number, or select a repository before using #number.',
    );
  }
  return null;
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

/**
 * `assignee` is the login the search means by "me". The `gh` CLI could say `@me`
 * because it carried a user's token; a GitHub App installation token has no user
 * behind it, so the connector passes the configured login instead. The default keeps
 * any user-token client working unchanged.
 */
export function autoTrackQueries({ watermark, trackAssigned, assignedRepos = [], watchedRepos = [], assignee = '@me' }) {
  if (!watermark) return [];
  const who = String(assignee || '@me').trim() || '@me';
  const base = ['is:issue', 'is:open', `created:>${watermark}`];
  const queries = [];
  if (trackAssigned) {
    const repos = [...new Set(assignedRepos.map(normalizeRepo))];
    if (repos.length === 0) queries.push([...base, `assignee:${who}`].join(' '));
    else for (const group of chunks(repos, 20)) {
      queries.push([...base, `assignee:${who}`, ...group.map(repo => `repo:${repo}`)].join(' '));
    }
  }
  for (const repo of [...new Set(watchedRepos.map(normalizeRepo))]) {
    queries.push([...base, `repo:${repo}`].join(' '));
  }
  return queries;
}

export function selectIssues(issues, limit = 50) {
  const byId = new Map();
  for (const issue of issues) {
    if (!issue || issue.pullRequest || issue.pull_request || issue.isPullRequest) continue;
    const id = String(issue.id ?? '').trim();
    if (!id) continue;
    const prior = byId.get(id);
    const updatedAt = issue.updatedAt ?? issue.updated_at ?? '';
    const priorUpdatedAt = prior?.updatedAt ?? prior?.updated_at ?? '';
    if (!prior || updatedAt > priorUpdatedAt) byId.set(id, { ...issue, id });
  }
  return [...byId.values()]
    .sort((left, right) => String(right.updatedAt ?? right.updated_at ?? '')
      .localeCompare(String(left.updatedAt ?? left.updated_at ?? '')))
    .slice(0, limit);
}

export function assertAllowedMutation(kind) {
  if (!['create', 'rename-title', 'publish-description'].includes(kind)) {
    throw new TodoDomainError('GITHUB_WRITE_FORBIDDEN', `Totem cannot ${kind} on GitHub.`, { status: 409 });
  }
}
