import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import { appJwt, createGitHubAppClient } from './github-app-client.mjs';
import { autoTrackQueries } from './github-policy.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

function issue(overrides = {}) {
  return {
    id: 991,
    number: 7,
    title: 'Ship the connector',
    body: 'details',
    state: 'open',
    html_url: 'https://github.com/alexdev/totem/issues/7',
    repository_url: 'https://api.github.com/repos/alexdev/totem',
    created_at: '2026-09-01T12:00:00Z',
    updated_at: '2026-09-02T12:00:00Z',
    ...overrides,
  };
}

/** A fetch double that records calls and replays queued responses by path prefix. */
function stubFetch(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const path = url.replace('https://api.github.com', '');
    calls.push({ path, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body ? JSON.parse(options.body) : null });
    // Longest prefix wins: /app/installations is also a prefix of
    // /app/installations/42/access_tokens, and matching that first mints nothing.
    const match = Object.keys(routes).filter(prefix => path.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
    if (!match) throw new Error(`unrouted ${path}`);
    const route = Array.isArray(routes[match]) ? routes[match].shift() : routes[match];
    const { status = 200, body = {} } = route ?? {};
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

const installed = { '/app/installations': { body: [{ id: 42, account: { login: 'alexdev' } }] } };
const minted = { '/app/installations/42/access_tokens': { body: { token: 'ghs_first', expires_at: '2026-09-15T15:00:00Z' } } };

function client(routes, extra = {}) {
  const stub = stubFetch({ ...installed, ...minted, ...routes });
  return { client: createGitHubAppClient({ appId: '123', privateKey: PEM, fetch: stub.fetch, now: () => Date.parse('2026-09-15T14:00:00Z'), ...extra }), ...stub };
}

test('signs an app JWT the public key verifies, within GitHub\'s ten-minute ceiling', () => {
  const now = () => Date.parse('2026-09-15T14:00:00Z');
  const token = appJwt({ appId: '123', privateKey: PEM, now });
  const [header, payload, signature] = token.split('.');

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.iss, '123');
  assert.equal(claims.iat, Math.floor(now() / 1000) - 60);
  assert.ok(claims.exp - claims.iat <= 600);
});

test('mints an installation token once and reuses it until it is near expiry', async () => {
  const { client: github, calls } = client({ '/search/issues': { body: { items: [issue()] } } });

  await github.searchIssues('is:issue');
  await github.searchIssues('is:issue is:open');

  const mints = calls.filter(call => call.path.endsWith('/access_tokens'));
  assert.equal(mints.length, 1);
  const searches = calls.filter(call => call.path.startsWith('/search/issues'));
  assert.equal(searches.length, 2);
  assert.equal(searches[0].headers.authorization, 'Bearer ghs_first');
  assert.equal(searches[1].headers.authorization, 'Bearer ghs_first');
});

test('re-mints once when GitHub revokes a token early, instead of failing the reconcile', async () => {
  const stub = stubFetch({
    ...installed,
    '/app/installations/42/access_tokens': [
      { body: { token: 'ghs_first', expires_at: '2026-09-15T15:00:00Z' } },
      { body: { token: 'ghs_second', expires_at: '2026-09-15T15:00:00Z' } },
    ],
    '/search/issues': [
      { status: 401, body: { message: 'Bad credentials' } },
      { body: { items: [issue()] } },
    ],
  });
  const github = createGitHubAppClient({ appId: '123', privateKey: PEM, fetch: stub.fetch, now: () => Date.parse('2026-09-15T14:00:00Z') });

  const found = await github.searchIssues('is:issue');
  assert.equal(found.length, 1);
  const searches = stub.calls.filter(call => call.path.startsWith('/search/issues'));
  assert.equal(searches[1].headers.authorization, 'Bearer ghs_second');
});

test('surfaces the HTTP status so the connector keeps its 404 and rate-limit handling', async () => {
  const { client: github } = client({ '/repos/alexdev/totem/issues/7': { status: 404, body: { message: 'Not Found' } } });
  await assert.rejects(
    () => github.getIssue({ repo: 'alexdev/totem', number: 7 }),
    error => error.status === 404 && /Not Found/.test(error.message),
  );
});

test('reads the assignee login from the installation when none is configured', async () => {
  const { client: github } = client({});
  assert.equal(await github.login(), 'alexdev');
});

test('prefers a configured assignee login over the installation account', async () => {
  const { client: github } = client({}, { assignee: 'someone-else' });
  assert.equal(await github.login(), 'someone-else');
});

test('refuses to guess when the app is installed more than once', async () => {
  const stub = stubFetch({
    '/app/installations': { body: [{ id: 42, account: { login: 'alexdev' } }, { id: 43, account: { login: 'acme' } }] },
  });
  const github = createGitHubAppClient({ appId: '123', privateKey: PEM, fetch: stub.fetch });
  await assert.rejects(() => github.login(), /GITHUB_APP_INSTALLATION_ID to one of: alexdev=42, acme=43/);
});

test('lists the installation repositories rather than every repo the human can reach', async () => {
  const { client: github, calls } = client({
    '/installation/repositories': { body: { repositories: [{ full_name: 'alexdev/totem' }, { full_name: 'alexdev/totem' }, { full_name: 'acme/app' }] } },
  });
  assert.deepEqual(await github.listAssignedRepos(), ['alexdev/totem', 'acme/app']);
  assert.ok(calls.some(call => call.path.startsWith('/installation/repositories?per_page=100')));
});

test('creates and edits issues over the REST API with the App token', async () => {
  const { client: github, calls } = client({
    '/repos/alexdev/totem/issues/7': { body: issue({ title: 'Renamed' }) },
    '/repos/alexdev/totem/issues': { body: issue() },
  });

  const created = await github.createIssue({ repo: 'alexdev/totem', title: 'Ship the connector', body: 'details' });
  assert.equal(created.repo, 'alexdev/totem');
  assert.equal(created.number, 7);
  const post = calls.find(call => call.method === 'POST' && call.path === '/repos/alexdev/totem/issues');
  assert.deepEqual(post.body, { title: 'Ship the connector', body: 'details' });

  const edited = await github.editIssue({ id: '991', repo: 'alexdev/totem', number: 7, title: 'Renamed' });
  assert.equal(edited.title, 'Renamed');
  const patch = calls.find(call => call.method === 'PATCH');
  assert.deepEqual(patch.body, { title: 'Renamed' });
});

test('auto-track queries name the configured login, because @me has no meaning for an app', () => {
  const settings = { watermark: '2026-09-01T00:00:00Z', trackAssigned: true, watchedRepos: [] };
  assert.match(autoTrackQueries({ ...settings, assignee: 'alexdev' })[0], /assignee:alexdev/);
  assert.match(autoTrackQueries(settings)[0], /assignee:@me/);
  assert.match(
    autoTrackQueries({ ...settings, assignee: 'alexdev', assignedRepos: ['alexdev/totem'] })[0],
    /assignee:alexdev repo:alexdev\/totem/,
  );
});
