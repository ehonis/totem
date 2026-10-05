function run(execFile, args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (error, result, legacyStderr) => {
      const stdout = typeof result === 'string' ? result : result?.stdout ?? '';
      const stderr = typeof result === 'object' ? result?.stderr ?? '' : legacyStderr ?? '';
      if (error) {
        const combined = `${error.message ?? error}\n${stderr}`;
        const status = /\b(401|403|404|429)\b/.exec(combined)?.[1];
        if (status) error.status = Number(status);
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function parseJson(stdout, label) {
  try { return JSON.parse(stdout || 'null'); }
  catch (error) { throw new Error(`Malformed JSON from gh ${label}: ${error.message}`); }
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

export function createGitHubClient({ execFile } = {}) {
  if (typeof execFile !== 'function') throw new TypeError('createGitHubClient requires execFile');
  const issueCache = new Map();

  function remember(raw) {
    const issue = shape(raw);
    issueCache.set(issue.id, issue);
    return issue;
  }

  async function api(args, label) {
    return parseJson(await run(execFile, ['api', ...args]), label);
  }

  async function searchIssues(query) {
    const rows = await api([
      '--method', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'per_page=100', '--jq', '.items',
    ], 'search/issues');
    if (!Array.isArray(rows)) throw new Error('Malformed GitHub issue search response');
    return rows.map(remember);
  }

  async function getIssue({ id, repo, number } = {}) {
    if (repo && number) return remember(await api([`repos/${repo}/issues/${number}`], 'issue'));
    if (id != null && issueCache.has(String(id))) return issueCache.get(String(id));
    throw new Error('GitHub issue lookup needs owner/repo and number unless the numeric id came from this search session');
  }

  return {
    searchIssues,
    getIssue,
    async listAssignedRepos() {
      const output = await run(execFile, [
        'api', '--method', 'GET', '--paginate', 'user/repos',
        '-f', 'affiliation=owner,collaborator,organization_member', '-f', 'per_page=100',
        '--jq', '.[].full_name',
      ]);
      return [...new Set(output.split('\n').map(value => value.trim()).filter(Boolean))];
    },
    async createIssue({ repo, title, body = '' }) {
      return remember(await api([
        '--method', 'POST', `repos/${repo}/issues`, '-f', `title=${title}`, '-f', `body=${body}`,
      ], 'create issue'));
    },
    async editIssue({ id, repo, number, title, body }) {
      const fields = [];
      if (title !== undefined) fields.push('-f', `title=${title}`);
      if (body !== undefined) fields.push('-f', `body=${body}`);
      const edited = remember(await api(['--method', 'PATCH', `repos/${repo}/issues/${number}`, ...fields], 'edit issue'));
      if (id != null && edited.id !== String(id)) throw new Error('GitHub issue identity changed unexpectedly');
      return edited;
    },
  };
}
