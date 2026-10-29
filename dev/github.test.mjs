import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDevGithub, ghErrorMessage, reviewState, runState } from './github.mjs'
import { fakeGh, repoRoutes } from './fixtures.mjs'

test('a repo card sums up CI on main, PRs, runners and the review switch', async () => {
  const { run } = fakeGh(repoRoutes())
  const card = await createDevGithub({ run }).repoStatus('owner/repo')

  assert.equal(card.error, undefined)
  assert.equal(card.defaultBranch, 'main')
  // One row per workflow, the newest run each.
  assert.deepEqual(card.ci.map((r) => [r.workflow, r.runId, r.state]), [['CI', 11, 'failure'], ['Deploy', 7, 'pending']])
  assert.deepEqual(card.prs, [{
    number: 4, title: 'Add a thing', url: 'https://github.com/owner/repo/pull/4', draft: false, sha: 'abc',
    checks: 'pending', checkCount: 3, claude: 'success', claudeUrl: null, codex: true,
  }])
  assert.deepEqual(card.setup, { reviewWorkflow: true, runner: true, ciSecret: true, missing: [] })
  assert.deepEqual(card.runners, [{ name: 'box-1', status: 'online', busy: false }])
  assert.equal(card.aiReview, 'on', 'an unset variable means on')
})

test('AI_REVIEW=off reads as off; failing checks beat pending ones', async () => {
  const routes = repoRoutes('owner/repo', { aiReview: 'off' })
  routes['repos/owner/repo/commits/abc/check-runs?per_page=100'].check_runs.push({ name: 'test', status: 'completed', conclusion: 'failure' })
  routes['repos/owner/repo/pulls/4/reviews?per_page=100'] = []
  const card = await createDevGithub({ run: fakeGh(routes).run }).repoStatus('owner/repo')
  assert.equal(card.aiReview, 'off')
  assert.equal(card.prs[0].checks, 'failing')
  assert.equal(card.prs[0].codex, false)
})

test('turning review off creates or updates the variable; on deletes it', async () => {
  const created = fakeGh((key) => (key === 'PATCH repos/owner/repo/actions/variables/AI_REVIEW' ? new Error('HTTP 404') : undefined))
  assert.equal(await createDevGithub({ run: created.run }).setAiReview('owner/repo', false), 'off')
  assert.deepEqual(created.calls.map((a) => a.slice(1, 4)), [
    ['-X', 'PATCH', 'repos/owner/repo/actions/variables/AI_REVIEW'],
    ['-X', 'POST', 'repos/owner/repo/actions/variables'],
  ])
  assert.ok(created.calls[1].includes('value=off'))

  const updated = fakeGh({})
  await createDevGithub({ run: updated.run }).setAiReview('owner/repo', false)
  assert.equal(updated.calls.length, 1, 'an existing variable is updated in place')

  const deleted = fakeGh((key) => (key.startsWith('DELETE') ? new Error('gh: Not Found (HTTP 404)') : undefined))
  assert.equal(await createDevGithub({ run: deleted.run }).setAiReview('owner/repo', true), 'on', 'deleting an unset variable is fine')
  assert.deepEqual(deleted.calls[0].slice(1, 4), ['-X', 'DELETE', 'repos/owner/repo/actions/variables/AI_REVIEW'])
})

test('gh missing or signed out is a per-repo error, not a crash', async () => {
  const missing = fakeGh(() => Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
  const card = await createDevGithub({ run: missing.run }).repoStatus('owner/repo')
  assert.match(card.error, /not installed/)
  assert.deepEqual([card.ci, card.prs, card.runners, card.aiReview], [[], [], [], null])

  assert.match(ghErrorMessage(new Error('To get started with GitHub CLI, please run:  gh auth login')), /gh auth login/)
})

test('runners that need admin access leave the rest of the card intact', async () => {
  const routes = repoRoutes()
  routes['repos/owner/repo/actions/runners'] = new Error('gh: Resource not accessible by integration (HTTP 403)')
  const card = await createDevGithub({ run: fakeGh(routes).run }).repoStatus('owner/repo')
  assert.equal(card.error, undefined)
  assert.deepEqual(card.runners, [])
  assert.match(card.runnersError, /403/)
})

test('run states', () => {
  assert.equal(runState('queued', null), 'pending')
  assert.equal(runState('completed', 'success'), 'success')
  assert.equal(runState('completed', 'timed_out'), 'failure')
  assert.equal(runState('completed', 'cancelled'), 'cancelled')
  assert.equal(runState('completed', 'skipped'), 'neutral')
})

test('setup status names what a newly watched repo is missing', async () => {
  const routes = repoRoutes('owner/repo', { reviewWorkflow: false, secret: false })
  routes['repos/owner/repo/actions/runners'] = { runners: [] }
  const card = await createDevGithub({ run: fakeGh(routes).run }).repoStatus('owner/repo')
  assert.deepEqual(card.setup, { reviewWorkflow: false, runner: false, ciSecret: false, missing: ['reviewWorkflow', 'runner', 'ciSecret'] })

  const unreadable = repoRoutes()
  unreadable['repos/owner/repo/actions/secrets?per_page=100'] = new Error('gh: Resource not accessible (HTTP 403)')
  const partial = await createDevGithub({ run: fakeGh(unreadable).run }).repoStatus('owner/repo')
  assert.equal(partial.setup.ciSecret, null, 'an unreadable secret list is unknown, not missing')
  assert.deepEqual(partial.setup.missing, [])
})

test('Claude status comes from the newest "Review PR #n" run, else the check run', async () => {
  const reviewRuns = [
    { display_title: 'Review PR #4', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/owner/repo/actions/runs/1', created_at: '2026-10-09T08:00:00Z' },
    { display_title: 'Review PR #4', status: 'in_progress', conclusion: null, html_url: 'https://github.com/owner/repo/actions/runs/2', created_at: '2026-10-09T09:00:00Z' },
    { display_title: 'Review PR #40', status: 'completed', conclusion: 'success', html_url: 'x', created_at: '2026-10-09T10:00:00Z' },
  ]
  const card = await createDevGithub({ run: fakeGh(repoRoutes('owner/repo', { reviewRuns })).run }).repoStatus('owner/repo')
  assert.deepEqual([card.prs[0].claude, card.prs[0].claudeUrl], ['running', 'https://github.com/owner/repo/actions/runs/2'])

  const other = await createDevGithub({ run: fakeGh(repoRoutes('owner/repo', { reviewRuns: [reviewRuns[2]] })).run }).repoStatus('owner/repo')
  assert.deepEqual([other.prs[0].claude, other.prs[0].claudeUrl], ['success', null], '#40 is not #4; the check run answers')

  assert.equal(reviewState('queued', null), 'queued')
  assert.equal(reviewState('completed', 'cancelled'), 'none')
})

test('a review dispatch posts to review.yml on the default branch with the PR as an input', async () => {
  const gh = fakeGh(repoRoutes())
  const res = await createDevGithub({ run: gh.run }).dispatchReview('owner/repo', 4)
  assert.deepEqual(res, { repo: 'owner/repo', number: 4, ref: 'main', queued: true })
  assert.deepEqual(gh.calls.at(-1), ['api', '-X', 'POST', 'repos/owner/repo/actions/workflows/review.yml/dispatches', '-f', 'ref=main', '-f', 'inputs[pr]=4'])

  const none = fakeGh(repoRoutes('owner/repo', { reviewWorkflow: false }))
  await assert.rejects(createDevGithub({ run: none.run }).dispatchReview('owner/repo', 4), (e) => e.status === 400)
  assert.ok(!none.calls.some((a) => a.includes('POST')), 'nothing is dispatched without the workflow')
})

test('merged PRs are searched in two-week slices, paged, deduplicated and sorted', async () => {
  const item = (repo, number, mergedAt) => ({
    number, title: `PR ${number}`, html_url: `https://github.com/${repo}/pull/${number}`,
    repository_url: `https://api.github.com/repos/${repo}`, pull_request: { merged_at: mergedAt },
  })
  const asked = []
  const { run } = fakeGh((key) => {
    const q = decodeURIComponent(/q=([^&]+)/.exec(key)[1])
    const page = Number(/&page=(\d+)/.exec(key)[1])
    asked.push([q.split('merged:')[1], page])
    if (q.endsWith('2026-09-01..2026-09-14')) {
      // A full first page means there is a second.
      if (page === 1) return { items: Array.from({ length: 100 }, (_, i) => item('a/one', i + 1, '2026-09-02T10:00:00Z')) }
      return { items: [item('a/one', 1, '2026-09-02T10:00:00Z'), item('b/two', 7, '2026-09-01T09:00:00Z')] }
    }
    return { items: [item('b/two', 8, '2026-09-20T12:00:00Z')] }
  })
  const pulls = await createDevGithub({ run }).mergedPulls('2026-09-01', { today: new Date('2026-09-20T15:00:00Z') })
  assert.deepEqual(asked, [['2026-09-01..2026-09-14', 1], ['>=2026-09-15', 1], ['2026-09-01..2026-09-14', 2]])
  assert.equal(pulls.length, 102, 'a PR seen twice is counted once')
  assert.deepEqual(pulls[0], { repo: 'b/two', number: 7, title: 'PR 7', url: 'https://github.com/b/two/pull/7', mergedAt: '2026-09-01T09:00:00Z' })
  assert.equal(pulls.at(-1).number, 8)
})
