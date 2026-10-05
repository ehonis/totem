/**
 * GitHub access for the todo connector, as a GitHub App rather than the `gh` CLI.
 *
 * The CLI client this replaces borrowed the owner's personal `gho_` token out of
 * ~/.config/gh/hosts.yml. That works until it doesn't: the token carries every
 * scope his account has rather than the two this connector needs, it is tied to a
 * login session on one machine, and a headless service that shells out to a binary
 * inherits whatever PATH systemd happened to give it. An App installation is the
 * opposite on all three counts — its reach is exactly the repositories it is
 * installed on, its credential is a file this process reads directly, and the
 * tokens it mints last an hour and are re-minted here without anyone re-authorising
 * anything.
 *
 * The one thing an installation token cannot do is be a person. GitHub's
 * `assignee:@me` has no meaning for a server-to-server token, so the login is
 * configuration: either GITHUB_ASSIGNEE_LOGIN, or the account the App is installed
 * on, read once at first use.
 */
import { createSign } from 'node:crypto';

const API = 'https://api.github.com';
const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';
// GitHub rejects a JWT that lives longer than ten minutes. Nine leaves room for a
// clock that is a little fast without ever being refused for it.
const JWT_TTL_MS = 9 * 60 * 1000;
// Re-mint an installation token a minute before GitHub would stop accepting it, so
// a long reconcile never dies halfway through on a token that expired mid-run.
const TOKEN_SKEW_MS = 60 * 1000;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/** A short-lived RS256 assertion proving we hold the App's private key. */
export function appJwt({ appId, privateKey, now = () => Date.now() }) {
  const issued = Math.floor(now() / 1000) - 60; // tolerate a slow clock on GitHub's side
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: issued,
    exp: issued + Math.floor(JWT_TTL_MS / 1000),
    iss: String(appId),
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey, 'base64url')}`;
}

function failure(status, path, body) {
  const detail = body?.message || body?.error || (typeof body === 'string' ? body.slice(0, 200) : '');
  const error = new Error(`GitHub ${path} failed with ${status}${detail ? `: ${detail}` : ''}`);
  error.status = status;
  return error;
}

function repoFrom(raw) {
  if (raw.repository?.full_name) return raw.repository.full_name;
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(raw.repository_url ?? '');
  if (match) return match[1];
  const url = /github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\//.exec(raw.html_url ?? '');
  return url?.[1] ?? null;
}

function shape(raw) {
  if (!raw || raw.id == null || raw.number == null || !raw.title || !raw.state) {
    throw new Error('Malformed GitHub issue response');
  }
  const repo = repoFrom(raw);
  if (!repo) throw new Error('Malformed GitHub issue response: repository is missing');
  return {
    id: String(raw.id),
    number: Number(raw.number),
    repo,
    title: String(raw.title),
    body: raw.body ?? '',
    state: String(raw.state),
    url: raw.html_url ?? raw.url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    pullRequest: Boolean(raw.pull_request),
  };
}

export function createGitHubAppClient({
  appId,
  privateKey,
  installationId = null,
  assignee = null,
  fetch = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (!appId) throw new TypeError('createGitHubAppClient requires appId');
  if (!privateKey) throw new TypeError('createGitHubAppClient requires privateKey');
  if (typeof fetch !== 'function') throw new TypeError('createGitHubAppClient requires fetch');

  const issueCache = new Map();
  let install = installationId ? { id: String(installationId), login: assignee } : null;
  let token = null; // { value, expiresAt }

  async function call(path, { method = 'GET', body, auth } = {}) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        accept: ACCEPT,
        authorization: `Bearer ${auth}`,
        'x-github-api-version': API_VERSION,
        'user-agent': 'totem-todos',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); }
      catch { parsed = text; }
    }
    if (!response.ok) throw failure(response.status, path, parsed);
    return parsed;
  }

  async function resolveInstallation() {
    if (install?.id && install?.login) return install;
    const jwt = appJwt({ appId, privateKey, now });
    if (install?.id) {
      const found = await call(`/app/installations/${install.id}`, { auth: jwt });
      install = { id: String(found.id), login: assignee || found.account?.login || null };
      return install;
    }
    const all = await call('/app/installations', { auth: jwt });
    if (!Array.isArray(all) || all.length === 0) {
      throw new Error('GitHub App has no installations — install it on your account or org first');
    }
    if (all.length > 1) {
      const options = all.map(item => `${item.account?.login ?? '?'}=${item.id}`).join(', ');
      throw new Error(`GitHub App is installed more than once; set GITHUB_APP_INSTALLATION_ID to one of: ${options}`);
    }
    install = { id: String(all[0].id), login: assignee || all[0].account?.login || null };
    return install;
  }

  async function installationToken() {
    if (token && token.expiresAt - TOKEN_SKEW_MS > now()) return token.value;
    const { id } = await resolveInstallation();
    const jwt = appJwt({ appId, privateKey, now });
    const minted = await call(`/app/installations/${id}/access_tokens`, { method: 'POST', auth: jwt });
    if (!minted?.token) throw new Error('GitHub returned no installation token');
    token = { value: minted.token, expiresAt: Date.parse(minted.expires_at ?? '') || (now() + 55 * 60 * 1000) };
    return token.value;
  }

  // A token can be revoked from GitHub's side before it expires (the App is
  // reinstalled, a repository is removed). One retry on 401 turns that from a failed
  // reconcile into a re-mint nobody notices.
  async function api(path, options = {}) {
    try {
      return await call(path, { ...options, auth: await installationToken() });
    } catch (error) {
      if (error.status !== 401) throw error;
      token = null;
      return call(path, { ...options, auth: await installationToken() });
    }
  }

  async function paginate(path, collect) {
    const out = [];
    for (let page = 1; page <= 10; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = collect(await api(`${path}${separator}per_page=100&page=${page}`));
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  function remember(raw) {
    const issue = shape(raw);
    issueCache.set(issue.id, issue);
    return issue;
  }

  return {
    /** The login the auto-track queries mean by "assigned to me". */
    async login() {
      return (await resolveInstallation()).login;
    },
    async searchIssues(query) {
      const result = await api(`/search/issues?q=${encodeURIComponent(query)}&per_page=100`);
      if (!Array.isArray(result?.items)) throw new Error('Malformed GitHub issue search response');
      return result.items.map(remember);
    },
    async getIssue({ id, repo, number } = {}) {
      if (repo && number) return remember(await api(`/repos/${repo}/issues/${number}`));
      if (id != null && issueCache.has(String(id))) return issueCache.get(String(id));
      throw new Error('GitHub issue lookup needs owner/repo and number unless the numeric id came from this search session');
    },
    /**
     * The repositories the App can see. Unlike the CLI's `user/repos`, this is the
     * installation's own list, which is the honest answer to "where can Totem look":
     * a repo the App is not installed on cannot be searched however much access the
     * human has to it.
     */
    async listAssignedRepos() {
      const names = await paginate('/installation/repositories', payload =>
        (payload?.repositories ?? []).map(repo => repo.full_name).filter(Boolean));
      return [...new Set(names)];
    },
    async createIssue({ repo, title, body = '' }) {
      return remember(await api(`/repos/${repo}/issues`, { method: 'POST', body: { title, body } }));
    },
    async editIssue({ id, repo, number, title, body }) {
      const fields = {};
      if (title !== undefined) fields.title = title;
      if (body !== undefined) fields.body = body;
      const edited = remember(await api(`/repos/${repo}/issues/${number}`, { method: 'PATCH', body: fields }));
      if (id != null && edited.id !== String(id)) throw new Error('GitHub issue identity changed unexpectedly');
      return edited;
    },
  };
}
