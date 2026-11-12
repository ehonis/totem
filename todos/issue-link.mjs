import { TodoDomainError } from './errors.mjs';

// A task's GitHub issue link: a plain link to one issue, with no sync behind it.
// Only `https://github.com/<owner>/<repo>/issues/<n>` is accepted. GitHub logins are
// letters, digits and single hyphens (at most 39); repository names are letters,
// digits, `.`, `_` and `-` (at most 100), never `.` or `..`.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const ISSUE_PATH = /^\/([^/]+)\/([^/]+)\/(issues|pull|pulls)\/(\d{1,9})\/?$/;
const MAX_URL_LENGTH = 500;

/** True for a GitHub `owner/repo` (the one check every GitHub path in tasks and the inbox uses). */
export function isGithubRepo(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  return parts.length === 2 && OWNER.test(parts[0]) && REPO.test(parts[1]) && parts[1] !== '.' && parts[1] !== '..';
}

function invalid(message, details = {}) {
  return new TodoDomainError('INVALID_ISSUE_LINK', message, { details });
}

/** `{ repo, number, url }` for a GitHub issue URL, or null for anything else. */
export function issueUrlParts(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password) {
    return null;
  }
  const match = ISSUE_PATH.exec(url.pathname);
  if (!match) return null;
  const [, owner, name, kind, digits] = match;
  const number = Number(digits);
  if (!isGithubRepo(`${owner}/${name}`) || number < 1) return null;
  return {
    kind: kind === 'issues' ? 'issue' : 'pull',
    repo: `${owner}/${name}`,
    number,
    url: `https://github.com/${owner}/${name}/issues/${number}`,
  };
}

/**
 * Validate an issue URL a caller sent, and return its canonical form (no query or
 * fragment). A pull request is refused with its own message, since "link this PR"
 * is the likely mistake.
 */
export function parseIssueUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid('url must be a GitHub issue URL or null.');
  }
  const parts = issueUrlParts(value);
  if (parts?.kind === 'pull') {
    throw invalid('That is a pull request. Link a GitHub issue: https://github.com/<owner>/<repo>/issues/<n>.', { kind: 'pull' });
  }
  if (!parts) {
    throw invalid('url must look like https://github.com/<owner>/<repo>/issues/<n>.');
  }
  return { repo: parts.repo, number: parts.number, url: parts.url };
}

/** The link DTO a task exposes, or null when the stored URL is not an issue. */
export function issueLinkFromUrl(value) {
  const parts = issueUrlParts(value);
  if (!parts || parts.kind !== 'issue') return null;
  return { connector: 'github', repo: parts.repo, number: parts.number, url: parts.url };
}
