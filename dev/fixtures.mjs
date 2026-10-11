// Shared stubs for the dev/ tests: a fake `gh` that answers `gh api <path>` from a
// table and records every call.

export function fakeGh(routes) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    const write = args.includes('-X')
    const key = write ? `${args[args.indexOf('-X') + 1]} ${args[args.indexOf('-X') + 2]}` : args[1]
    const answer = typeof routes === 'function' ? routes(key, args) : routes[key]
    if (answer instanceof Error) throw answer
    if (answer === undefined) {
      if (write) return ''
      throw new Error(`gh: Not Found (HTTP 404) ${key}`)
    }
    return JSON.stringify(answer)
  }
  return { run, calls }
}

export const notFound = () => new Error('gh: Not Found (HTTP 404)')

/** A repo whose main has a failing CI run, one open PR and one runner. */
export function repoRoutes(repo = 'owner/repo', { ciConclusion = 'failure', ciRunId = 11, runnerStatus = 'online', aiReview, reviewWorkflow = true, secret = true, reviewRuns = [] } = {}) {
  return {
    [`repos/${repo}`]: { default_branch: 'main' },
    [`repos/${repo}/actions/runs?branch=main&per_page=10`]: {
      workflow_runs: [
        { id: ciRunId, name: 'CI', status: 'completed', conclusion: ciConclusion, html_url: `https://github.com/${repo}/actions/runs/${ciRunId}`, created_at: '2026-10-09T10:00:00Z' },
        { id: 5, name: 'CI', status: 'completed', conclusion: 'success', html_url: 'x', created_at: '2026-10-08T10:00:00Z' },
        { id: 7, name: 'Deploy', status: 'in_progress', conclusion: null, html_url: 'y', created_at: '2026-10-09T09:00:00Z' },
      ],
    },
    [`repos/${repo}/pulls?state=open&per_page=20`]: [
      { number: 4, title: 'Add a thing', html_url: `https://github.com/${repo}/pull/4`, draft: false, head: { sha: 'abc' } },
    ],
    [`repos/${repo}/commits/abc/check-runs?per_page=100`]: {
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'claude', status: 'completed', conclusion: 'success' },
        { name: 'lint', status: 'in_progress', conclusion: null },
      ],
    },
    [`repos/${repo}/issues/4/comments?per_page=100`]: [{ user: { login: 'someone' } }],
    [`repos/${repo}/pulls/4/reviews?per_page=100`]: [{ user: { login: 'chatgpt-codex-connector[bot]' } }],
    [`repos/${repo}/actions/runners`]: { runners: [{ name: 'box-1', status: runnerStatus, busy: false }] },
    [`repos/${repo}/actions/workflows?per_page=100`]: {
      workflows: [{ name: 'CI', path: '.github/workflows/ci.yml' }, ...(reviewWorkflow ? [{ name: 'Review', path: '.github/workflows/review.yml' }] : [])],
    },
    [`repos/${repo}/actions/secrets?per_page=100`]: { secrets: secret ? [{ name: 'CLIPROXY_API_KEY' }] : [{ name: 'OTHER' }] },
    ...(reviewWorkflow ? { [`repos/${repo}/actions/workflows/review.yml/runs?per_page=50`]: { workflow_runs: reviewRuns } } : {}),
    ...(aiReview ? { [`repos/${repo}/actions/variables/AI_REVIEW`]: { name: 'AI_REVIEW', value: aiReview } } : {}),
  }
}
