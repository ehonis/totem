import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { etagEligible } from '../http/etag.mjs'
import { createDevGithub, ISSUE_CAP } from './github.mjs'
import { createDevHttpHandler } from './http.mjs'
import { ISSUES_CACHE_MS, ISSUES_REFRESH_MS } from './issues.mjs'
import { createDevService } from './service.mjs'

const dirs = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const day = (n) => new Date(Date.parse('2026-11-09T12:00:00Z') - n * 3_600_000).toISOString()

/** An issue (or, with `pr`, a pull request) as GitHub's GraphQL API returns it. */
function node(repo, number, { hoursAgo = 24, state = 'open', reason = null, labels = [], assignees = [], pr = false, title } = {}) {
  return {
    __typename: pr ? 'PullRequest' : 'Issue',
    number,
    title: title || `${pr ? 'PR' : 'Issue'} ${number} in ${repo}`,
    state: state.toUpperCase(),
    stateReason: reason,
    url: `https://github.com/${repo}/${pr ? 'pull' : 'issues'}/${number}`,
    createdAt: day(1000),
    updatedAt: day(hoursAgo),
    comments: { totalCount: 2 },
    author: { login: 'someone' },
    assignees: { nodes: assignees.map((login) => ({ login })) },
    labels: { nodes: labels.map(([name, color]) => ({ name, color })) },
    milestone: null,
    repository: { nameWithOwner: repo },
    pr,
  }
}

/**
 * A fake `gh` that answers `gh api user` and `gh api graphql` the way GitHub
 * does: `repository.issues` holds issues only, `search` mixes PRs in unless the
 * query says `is:issue`, both page 100 at a time by cursor, newest-updated first.
 */
function fakeGithub({ repos = {}, assigned = [], login = 'octo', fail = {}, searchCount = null, blocked = 0 } = {}) {
  const calls = []
  const state = { repos, assigned, login, fail }
  const run = async (args) => {
    if (args[1] === 'user') {
      calls.push({ kind: 'user' })
      if (state.fail.user) throw state.fail.user
      if (!state.login) throw new Error('gh: To get started with GitHub CLI, please run: gh auth login')
      return JSON.stringify({ login: state.login })
    }
    assert.equal(args[1], 'graphql', `unexpected gh call ${args.join(' ')}`)
    const vars = {}
    for (let i = 2; i < args.length; i += 2) {
      assert.match(args[i], /^-[fF]$/)
      const at = args[i + 1].indexOf('=')
      vars[args[i + 1].slice(0, at)] = args[i + 1].slice(at + 1)
    }
    const from = Number(vars.cursor || 0)
    const page = (list) => {
      const sorted = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const nodes = sorted.slice(from, from + 100)
      const more = from + 100 < sorted.length
      return { nodes, pageInfo: { hasNextPage: more, endCursor: more ? String(from + 100) : null } }
    }
    if (vars.query.includes('repository(')) {
      const repo = `${vars.owner}/${vars.name}`
      calls.push({ kind: 'repo', repo, cursor: vars.cursor || null, states: /states: (\[[A-Z, ]+\])/.exec(vars.query)[1] })
      if (state.fail[repo]) throw state.fail[repo]
      if (!state.repos[repo]) return JSON.stringify({ data: { repository: null }, errors: [{ message: `Could not resolve to a Repository with the name '${repo}'.` }] })
      const want = JSON.parse(/states: (\[[A-Z, ]+\])/.exec(vars.query)[1].replace(/([A-Z]+)/g, '"$1"'))
      const issues = state.repos[repo].filter((n) => !n.pr && want.includes(n.state))
      return JSON.stringify({ data: { repository: { issues: { totalCount: issues.length, ...page(issues) } } } })
    }
    assert.match(vars.query, /search\(type: ISSUE/)
    calls.push({ kind: 'search', q: vars.q, cursor: vars.cursor || null })
    if (state.fail.assigned) throw state.fail.assigned
    const wanted = /is:open/.test(vars.q) ? ['OPEN'] : /is:closed/.test(vars.q) ? ['CLOSED'] : ['OPEN', 'CLOSED']
    const hits = state.assigned.filter((n) => wanted.includes(n.state) && (!n.pr || !/is:issue/.test(vars.q)))
    const search = { issueCount: searchCount ?? hits.length + blocked, ...page(hits) }
    if (!blocked) return JSON.stringify({ data: { search } })
    // Issues in an org that blocks the token: null nodes, an `errors` list, and gh exits 1.
    search.nodes = [...search.nodes, ...Array(blocked).fill(null)]
    const errors = [{ type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement. You must grant your token access to this organization.' }]
    throw Object.assign(new Error('gh: Resource protected by organization SAML enforcement.'), { stdout: JSON.stringify({ data: { search }, errors }) })
  }
  return { run, calls, state }
}

/** The /api/dev handler over a fake gh and a clock the test moves. */
function fixture({ watch = ['acme/app', 'acme/site'], ...github } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'totem-dev-issues-'))
  dirs.push(dir)
  const configFile = join(dir, 'dev.json')
  writeFileSync(configFile, JSON.stringify({ repos: watch }))
  const gh = fakeGithub(github)
  const clock = { t: Date.parse('2026-11-09T12:00:00Z') }
  const service = createDevService({ configFile, github: createDevGithub({ run: gh.run }), now: () => clock.t })
  const handler = createDevHttpHandler({ service })
  async function get(query = '') {
    let status = 0
    let body = ''
    const req = { method: 'GET', url: `/api/dev/issues${query}` }
    const res = { writeHead: (s) => { status = s }, end: (b) => { body = b } }
    assert.equal(await handler(req, res), true)
    return { status, body: JSON.parse(body) }
  }
  const reads = () => gh.calls.filter((c) => c.kind !== 'user')
  const reset = () => { gh.calls.length = 0 }
  return { get, gh, clock, reads, reset }
}

const ids = (body) => body.issues.map((i) => `${i.repo}#${i.number}`)

test('issues: PRs never appear, and an issue found by both sources appears once, newest copy', async () => {
  const shared = node('acme/app', 7, { hoursAgo: 27, assignees: ['octo'] })
  const { get, gh } = fixture({
    repos: {
      'acme/app': [shared, node('acme/app', 8, { pr: true, hoursAgo: 1 }), node('acme/app', 3, { hoursAgo: 200 })],
      'acme/site': [node('acme/site', 1, { hoursAgo: 50, labels: [['bug', 'D73A4A'], ['', 'ffffff']] })],
    },
    assigned: [
      { ...shared, updatedAt: day(26), title: 'Newer copy' },
      node('other/lib', 42, { hoursAgo: 4, assignees: ['octo'] }),
      node('other/lib', 43, { pr: true, hoursAgo: 2, assignees: ['octo'] }),
    ],
  })
  const { status, body } = await get('?state=open&scope=all')
  assert.equal(status, 200)
  assert.equal(body.enabled, true)
  assert.equal(body.login, 'octo')
  assert.deepEqual(body.errors, [])
  assert.deepEqual(body.warnings, [])
  assert.equal(body.error, undefined)
  assert.deepEqual(ids(body), ['other/lib#42', 'acme/app#7', 'acme/site#1', 'acme/app#3'])
  assert.equal(body.issues[1].title, 'Newer copy', 'the newer-updated copy of a duplicate wins')
  assert.deepEqual(body.issues[2].labels, [{ name: 'bug', color: 'd73a4a' }])
  assert.deepEqual(Object.keys(body.issues[0]).sort(), [
    'assignees', 'author', 'comments', 'createdAt', 'labels', 'milestone', 'number', 'repo', 'state', 'stateReason', 'title', 'updatedAt', 'url',
  ])
  const search = gh.calls.find((c) => c.kind === 'search')
  assert.match(search.q, /\bis:issue\b/)
  assert.match(search.q, /assignee:@me/)
})

test('issues: a repo with hundreds of newer PRs still lists its older issues', async () => {
  const prs = Array.from({ length: 300 }, (_, i) => node('acme/app', 1000 + i, { pr: true, state: 'closed', hoursAgo: 1 + i / 100 }))
  const { get, reads } = fixture({
    watch: ['acme/app'],
    repos: { 'acme/app': [...prs, node('acme/app', 5, { state: 'closed', reason: 'NOT_PLANNED', hoursAgo: 900 })] },
  })
  const { body } = await get('?state=closed&scope=watched')
  assert.deepEqual(ids(body), ['acme/app#5'])
  assert.equal(body.issues[0].state, 'closed')
  assert.equal(body.issues[0].stateReason, 'not_planned')
  assert.deepEqual(reads().map((c) => c.kind), ['repo'], 'one page: PRs never take up the issue pages')
})

test('issues: pages are followed to the end, up to 1,000 per source, and a cap says where', async () => {
  const many = (repo, n) => Array.from({ length: n }, (_, i) => node(repo, i + 1, { hoursAgo: i + 1 }))
  const { get, reads } = fixture({ watch: ['acme/app', 'acme/big'], repos: { 'acme/app': many('acme/app', 250), 'acme/big': many('acme/big', ISSUE_CAP + 100) } })
  const { body } = await get('?scope=watched')
  const app = reads().filter((c) => c.repo === 'acme/app')
  assert.deepEqual(app.map((c) => c.cursor), [null, '100', '200'], 'each page asks after the last cursor')
  assert.equal(reads().filter((c) => c.repo === 'acme/big').length, ISSUE_CAP / 100)
  assert.equal(body.issues.filter((i) => i.repo === 'acme/app').length, 250)
  assert.equal(body.issues.filter((i) => i.repo === 'acme/big').length, ISSUE_CAP)
  assert.deepEqual(body.capped, [{ source: 'acme/big', shown: ISSUE_CAP, total: ISSUE_CAP + 100 }])
})

test('issues: an answer with data and errors keeps the data, and the errors become a warning', async () => {
  const { get } = fixture({
    watch: [],
    assigned: [node('other/lib', 2, { assignees: ['octo'] }), node('acme/app', 3, { assignees: ['octo'] })],
    blocked: 2,
  })
  const { status, body } = await get('?scope=mine')
  assert.equal(status, 200)
  assert.deepEqual(ids(body).sort(), ['acme/app#3', 'other/lib#2'], 'the issues it could read are listed')
  assert.deepEqual(body.errors, [], 'a partial answer is not a failed source')
  assert.deepEqual(body.warnings, [{ source: 'Assigned to you', warning: 'Resource protected by organization SAML enforcement. You must grant your token access to this organization.' }])
  assert.deepEqual(body.capped, [], 'nodes GitHub withheld are not counted as cut off')

  // A failure with no data at all still fails the source.
  const none = fixture({ watch: [], fail: { assigned: Object.assign(new Error('HTTP 502'), { stdout: '{"errors":[{"message":"Something went wrong"}]}' }) } })
  assert.deepEqual((await none.get('?scope=mine')).body.errors, [{ source: 'Assigned to you', error: 'HTTP 502', stale: false }])
})

test('issues: search stopping at 1,000 results with no next page still counts as capped', async () => {
  const many = Array.from({ length: 250 }, (_, i) => node('other/lib', i + 1, { hoursAgo: i + 1, assignees: ['octo'] }))
  const { get } = fixture({ watch: [], assigned: many, searchCount: 1234 })
  const { body } = await get('?scope=mine')
  assert.equal(body.issues.length, 250)
  assert.deepEqual(body.capped, [{ source: 'Assigned to you', shown: 250, total: 1234 }])
})

test('issues: an owner or repo called "pull" is not mistaken for a PR', async () => {
  const { get } = fixture({ watch: ['acme/pull', 'pull/app'], repos: { 'acme/pull': [node('acme/pull', 1)], 'pull/app': [node('pull/app', 2)] } })
  assert.deepEqual(ids((await get('?scope=watched')).body).sort(), ['acme/pull#1', 'pull/app#2'])
})

test('issues: scope and repo pick which sources are read, and state is passed through', async () => {
  const { get, reads, reset } = fixture({
    repos: { 'acme/app': [node('acme/app', 2, { state: 'closed' })], 'acme/site': [node('acme/site', 5, { state: 'closed' })] },
    assigned: [node('other/lib', 9, { state: 'closed', assignees: ['octo'] }), node('acme/site', 6, { state: 'closed', assignees: ['octo'] })],
  })

  const mine = await get('?state=closed&scope=mine')
  assert.deepEqual(ids(mine.body).sort(), ['acme/site#6', 'other/lib#9'])
  assert.deepEqual(reads().map((c) => c.kind), ['search'], 'mine reads only the assigned search')
  assert.match(reads()[0].q, /is:closed/)

  reset()
  const watched = await get('?state=closed&scope=watched')
  assert.deepEqual(ids(watched.body).sort(), ['acme/app#2', 'acme/site#5'])
  assert.deepEqual(reads().map((c) => [c.repo, c.states]).sort(), [['acme/app', '[CLOSED]'], ['acme/site', '[CLOSED]']])

  reset()
  await get('?state=all&scope=watched&repo=acme/app')
  assert.deepEqual(reads().map((c) => [c.repo, c.states]), [['acme/app', '[OPEN, CLOSED]']], 'repo= reads only that repo')

  const one = await get('?state=closed&scope=all&repo=ACME/site')
  assert.deepEqual(ids(one.body).sort(), ['acme/site#5', 'acme/site#6'], 'repo matches without case, across both sources')

  for (const bad of ['?state=done', '?scope=team', '?repo=not-a-repo', '?repo=a/b%20c']) {
    const res = await get(bad)
    assert.equal(res.status, 400, bad)
    assert.match(res.body.error, /must/)
  }
})

test('issues: an answer is cached for five minutes, shared across scopes', async () => {
  const { get, reads, reset, clock } = fixture({ repos: { 'acme/app': [node('acme/app', 1)], 'acme/site': [] } })
  await get()
  assert.equal(reads().length, 3)
  reset()

  clock.t += ISSUES_CACHE_MS - 1000
  assert.equal((await get()).body.issues.length, 1)
  await get('?scope=watched')
  await get('?scope=mine&repo=acme/app')
  assert.deepEqual(reads(), [], 'nothing read again inside the window')

  clock.t += 2000
  await get()
  assert.equal(reads().length, 3, 'read again once the window has passed')
})

test('issues: Refresh re-reads at most once a minute', async () => {
  const { get, reads, reset, clock } = fixture({ watch: ['acme/app'], repos: { 'acme/app': [node('acme/app', 1)] } })
  await get()
  reset()

  clock.t += 30_000
  await get('?refresh=1')
  assert.deepEqual(reads(), [], 'a refresh 30 s after a read is served from the cache')

  clock.t += ISSUES_REFRESH_MS
  const res = await get('?refresh=1')
  assert.equal(reads().length, 2, 'a minute on, refresh reads again')
  assert.equal(res.body.fetchedAt, new Date(clock.t).toISOString())
})

test('issues: a failed read answers the last good list, and says which sources were never read', async () => {
  const { get, gh, clock } = fixture({
    watch: ['acme/app'],
    repos: { 'acme/app': [node('acme/app', 1)] },
    assigned: [node('other/lib', 2, { assignees: ['octo'] })],
  })
  const first = await get()
  assert.equal(first.body.issues.length, 2)

  gh.state.fail['acme/app'] = new Error('HTTP 502: Bad Gateway')
  clock.t += ISSUES_CACHE_MS
  const after = await get()
  assert.equal(after.status, 200)
  assert.deepEqual(ids(after.body).sort(), ['acme/app#1', 'other/lib#2'], 'the failed repo keeps its last good issues')
  assert.deepEqual(after.body.errors, [{ source: 'acme/app', error: 'HTTP 502: Bad Gateway', stale: true }])
  assert.match(after.body.error, /^acme\/app: HTTP 502/)
  assert.equal(after.body.fetchedAt, first.body.fetchedAt, 'fetchedAt is the oldest list shown')

  // Never read: nothing to fall back on, and the answer says so.
  const fresh = fixture({ watch: ['acme/app', 'acme/gone'], repos: { 'acme/app': [] }, fail: { 'acme/app': new Error('HTTP 500') } })
  const res = await fresh.get('?scope=watched')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.issues, [])
  assert.equal(res.body.fetchedAt, null)
  assert.deepEqual(res.body.errors, [
    { source: 'acme/app', error: 'HTTP 500', stale: false },
    { source: 'acme/gone', error: 'Repository not found, or gh has no access to it.', stale: false },
  ])
})

test('issues: off only when nothing is watched and gh is signed out', async () => {
  const off = fixture({ watch: [], login: null })
  const { status, body } = await off.get()
  assert.equal(status, 200)
  assert.equal(body.enabled, false)
  assert.deepEqual(body.issues, [])
  assert.match(body.reason, /gh auth login/)
  assert.deepEqual(off.reads(), [], 'no issue listing is read while off')

  // A gh that failed for another reason is an error to show, not "sign in".
  const blip = fixture({ watch: [], fail: { user: new Error('error connecting to api.github.com') } })
  const res = await blip.get()
  assert.equal(res.body.enabled, true)
  assert.deepEqual(res.body.errors, [{ source: 'Assigned to you', error: 'error connecting to api.github.com', stale: false }])

  // Watched repos but signed out: the repos still list, and the assigned list says why it is missing.
  const half = fixture({ watch: ['acme/app'], login: null, repos: { 'acme/app': [node('acme/app', 4)] } })
  const both = await half.get()
  assert.equal(both.body.enabled, true)
  assert.deepEqual(ids(both.body), ['acme/app#4'])
  assert.match(both.body.error, /Assigned to you: gh is not signed in/)
})

test('issues: the route is never ETag-cached (the phone would keep it on disk)', () => {
  assert.equal(etagEligible('GET', '/api/dev/issues'), false)
})
