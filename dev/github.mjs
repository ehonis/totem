// dev/github.mjs — what the Dev tab reads from GitHub, through the `gh` CLI.
//
// GitHub stays the source of truth: this only reads run, PR and runner state,
// and writes one repo variable (`AI_REVIEW`) that the repos' own review
// workflows check. `run(args)` is the bridge's `ghCapture` (the service user's
// `gh` login) and resolves to stdout; tests pass a stub.

export const AI_REVIEW_VAR = 'AI_REVIEW'
// The review workflow every watched repo is set up with, and the secret its
// self-hosted runner needs. Fixed names on purpose: /review-ci-setup writes them.
export const REVIEW_WORKFLOW = 'review.yml'
export const CI_KEY_SECRET = 'CLIPROXY_API_KEY'
const CODEX_LOGIN = 'chatgpt-codex-connector'
const DAY_MS = 86_400_000
const SLICE_DAYS = 14
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])
// Issues are read newest-updated first, 100 a page, through GraphQL, which
// lists issues only (REST's issue listings mix PRs in, and a PR-heavy repo spent
// every page on them). A source stops at this many and says so.
export const ISSUE_CAP = 1000
const ISSUE_PAGE = 100

/** One word for a run or check: success, failure, pending, cancelled or neutral. */
export function runState(status, conclusion) {
  if (status && status !== 'completed') return 'pending'
  if (conclusion === 'success') return 'success'
  if (FAILED.has(conclusion)) return 'failure'
  if (conclusion === 'cancelled') return 'cancelled'
  return 'neutral'
}

/** A run of the review workflow, as the PR row shows it. */
export function reviewState(status, conclusion) {
  if (status === 'in_progress') return 'running'
  if (status && status !== 'completed') return 'queued'
  if (conclusion === 'success') return 'success'
  if (FAILED.has(conclusion)) return 'failure'
  return 'none'
}

// GraphQL says a missing repo in words, not with a 404.
const isNotFound = (e) => /HTTP 404|Not Found|Could not resolve to a Repository/i.test(String(e?.message || e))

/** A `gh` failure in words the owner can act on, rather than a stack. */
export function ghErrorMessage(e) {
  const text = String(e?.message || e || '')
  if (/ENOENT/.test(text)) return 'The gh CLI is not installed on the server, or not on its PATH.'
  if (/auth login|not logged in|GH_TOKEN|HTTP 401/i.test(text)) return 'gh is not signed in for the user Totem runs as. Run `gh auth login` there.'
  if (isNotFound(text)) return 'Repository not found, or gh has no access to it.'
  return text.split('\n')[0].slice(0, 200) || 'gh failed'
}

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const ISSUE_FIELDS = `__typename number title state stateReason url createdAt updatedAt
  comments { totalCount } author { login } assignees(first: 10) { nodes { login } }
  labels(first: 100) { nodes { name color } } milestone { title } repository { nameWithOwner }`

// `states` is spliced in from this table only, never from a request.
const GRAPH_STATES = { open: '[OPEN]', closed: '[CLOSED]', all: '[OPEN, CLOSED]' }
const repoIssuesQuery = (state) => `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: ${ISSUE_PAGE}, after: $cursor, states: ${GRAPH_STATES[state]}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount pageInfo { hasNextPage endCursor } nodes { ${ISSUE_FIELDS} }
    }
  }
}`
const SEARCH_QUERY = `query($q: String!, $cursor: String) {
  search(type: ISSUE, query: $q, first: ${ISSUE_PAGE}, after: $cursor) {
    issueCount pageInfo { hasNextPage endCursor } nodes { ... on Issue { ${ISSUE_FIELDS} } }
  }
}`
const SEARCH_STATE = { open: ' is:open', closed: ' is:closed', all: '' }

/**
 * One GraphQL issue node as the Issues list shows it; null for anything else: a
 * PR in a search comes back as `{}` (the fields sit in `... on Issue`), and a
 * node GitHub could not show us (an org that blocks the token) as null.
 */
export function issueRow(node, fallbackRepo = null) {
  if (!node || node.__typename !== 'Issue' || !Number.isInteger(node.number) || !node.url) return null
  const repo = node.repository?.nameWithOwner || fallbackRepo
  if (!repo) return null
  return {
    repo,
    number: node.number,
    title: String(node.title || ''),
    state: node.state === 'CLOSED' ? 'closed' : 'open',
    stateReason: node.stateReason ? String(node.stateReason).toLowerCase() : null,
    url: node.url,
    labels: (node.labels?.nodes || [])
      .map((l) => ({ name: String(l?.name || ''), color: /^[0-9a-f]{6}$/i.test(l?.color || '') ? l.color.toLowerCase() : '' }))
      .filter((l) => l.name),
    assignees: (node.assignees?.nodes || []).map((a) => a?.login).filter(Boolean),
    author: node.author?.login || null,
    comments: Number(node.comments?.totalCount) || 0,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    milestone: node.milestone?.title || null,
  }
}

/** Whether a gh failure means gh is missing or signed out, rather than GitHub having a bad moment. */
export const ghSignedOut = (e) => /ENOENT|auth login|not logged in|GH_TOKEN|HTTP 401/i.test(String(e?.message || e || ''))

/**
 * A PR body's opening sentence ("Adds X so Y can Z"), or null. Orchestrated PRs
 * start with one; older bodies start with a heading, a list, a table, a quote,
 * a comment or a picture, which are not a one-liner and give null. The search
 * results already carry `body`, so this costs no call.
 */
export function prSummary(body) {
  const first = String(body || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean)
  if (!first || /^(#|[-*+]\s|\d+[.)]\s|>|\||<|!\[|```|~~~|---|===)/.test(first)) return null
  const plain = first
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length < 8) return null
  return plain.length > 240 ? `${plain.slice(0, 239)}…` : plain
}

export function createDevGithub({ run }) {
  if (typeof run !== 'function') throw new TypeError('createDevGithub requires run')
  const get = async (path) => JSON.parse(await run(['api', path]))

  async function defaultBranch(repo) {
    return (await get(`repos/${repo}`)).default_branch || 'main'
  }

  // The newest run of each workflow on the default branch. The API lists newest
  // first; sorting again keeps that true if it ever does not.
  async function mainRuns(repo, branch) {
    const { workflow_runs: runs = [] } = await get(`repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=10`)
    const newest = new Map()
    for (const r of [...runs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
      if (!newest.has(r.name)) newest.set(r.name, r)
    }
    return [...newest.values()].map((r) => ({
      workflow: r.name,
      runId: r.id,
      status: r.status,
      conclusion: r.conclusion,
      state: runState(r.status, r.conclusion),
      url: r.html_url,
      createdAt: r.created_at,
    }))
  }

  // Listing self-hosted runners needs admin on the repo; without it the card
  // shows no runners rather than failing as a whole.
  async function runners(repo) {
    try {
      const { runners: list = [] } = await get(`repos/${repo}/actions/runners`)
      return { runners: list.map((r) => ({ name: r.name, status: r.status, busy: Boolean(r.busy) })) }
    } catch (e) {
      return { runners: [], runnersError: ghErrorMessage(e) }
    }
  }

  // Unset means on: the review workflows only skip when the variable says `off`.
  async function aiReview(repo) {
    try {
      const v = await get(`repos/${repo}/actions/variables/${AI_REVIEW_VAR}`)
      return String(v.value || '').trim().toLowerCase() === 'off' ? 'off' : 'on'
    } catch (e) {
      if (isNotFound(e)) return 'on'
      throw e
    }
  }

  async function setAiReview(repo, enabled) {
    if (enabled) {
      try { await run(['api', '-X', 'DELETE', `repos/${repo}/actions/variables/${AI_REVIEW_VAR}`]) } catch (e) { if (!isNotFound(e)) throw e }
      return 'on'
    }
    try {
      await run(['api', '-X', 'PATCH', `repos/${repo}/actions/variables/${AI_REVIEW_VAR}`, '-f', `name=${AI_REVIEW_VAR}`, '-f', 'value=off'])
    } catch (e) {
      if (!isNotFound(e)) throw e
      await run(['api', '-X', 'POST', `repos/${repo}/actions/variables`, '-f', `name=${AI_REVIEW_VAR}`, '-f', 'value=off'])
    }
    return 'off'
  }

  // The review workflow names each run `Review PR #<n>` (pull_request and manual
  // dispatch alike), so one list per repo covers every PR. Newest run wins.
  async function reviewRuns(repo) {
    let runs
    try {
      runs = (await get(`repos/${repo}/actions/workflows/${REVIEW_WORKFLOW}/runs?per_page=50`)).workflow_runs || []
    } catch (e) {
      if (isNotFound(e)) return new Map()
      throw e
    }
    const byPr = new Map()
    for (const r of [...runs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
      const n = /^Review PR #(\d+)$/.exec(String(r.display_title || ''))?.[1]
      if (n && !byPr.has(Number(n))) byPr.set(Number(n), { state: reviewState(r.status, r.conclusion), url: r.html_url })
    }
    return byPr
  }

  async function hasReviewWorkflow(repo) {
    const { workflows = [] } = await get(`repos/${repo}/actions/workflows?per_page=100`)
    return workflows.some((w) => String(w.path || '').endsWith(`/${REVIEW_WORKFLOW}`))
  }

  // Secret names only; GitHub never returns values. Listing needs admin, and an
  // unreadable list is `null` (unknown) rather than "missing".
  async function hasCiSecret(repo) {
    try {
      const { secrets = [] } = await get(`repos/${repo}/actions/secrets?per_page=100`)
      return secrets.some((x) => x.name === CI_KEY_SECRET)
    } catch {
      return null
    }
  }

  /** Whether gh can see the repo at all: the gate for watching it. */
  async function repoVisible(repo) {
    try { await get(`repos/${repo}`); return true } catch (e) { if (isNotFound(e)) return false; throw e }
  }

  /** Start the review workflow for one PR, whatever the AI review switch says. */
  async function dispatchReview(repo, number) {
    const [branch, present] = await Promise.all([defaultBranch(repo), hasReviewWorkflow(repo)])
    if (!present) {
      const error = new Error(`${repo} has no ${REVIEW_WORKFLOW} workflow.`)
      error.status = 400
      throw error
    }
    // gh builds nested JSON from key[subkey]=value; -f keeps the input a string,
    // which is what workflow_dispatch inputs must be.
    await run(['api', '-X', 'POST', `repos/${repo}/actions/workflows/${REVIEW_WORKFLOW}/dispatches`, '-f', `ref=${branch}`, '-f', `inputs[pr]=${number}`])
    return { repo, number, ref: branch, queued: true }
  }

  async function pullRequest(repo, pr, reviewRunsByPr) {
    const [checks, comments, reviews] = await Promise.all([
      get(`repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`),
      get(`repos/${repo}/issues/${pr.number}/comments?per_page=100`),
      get(`repos/${repo}/pulls/${pr.number}/reviews?per_page=100`),
    ])
    const runs = (checks.check_runs || []).map((c) => ({ name: String(c.name || ''), state: runState(c.status, c.conclusion) }))
    const states = runs.map((c) => c.state)
    // The review workflow is called Review and its job `claude`; a check run carries the job name.
    const claudeRun = runs.find((c) => /^review$/i.test(c.name) || /claude/i.test(c.name))
    // Prefer the review workflow's own run for this PR; older runs without the
    // `Review PR #<n>` name fall back to the check run on the head commit.
    const fromCheck = { pending: 'running', success: 'success', failure: 'failure' }[claudeRun?.state] || 'none'
    const claude = reviewRunsByPr.get(pr.number) || { state: fromCheck, url: null }
    const byCodex = (x) => String(x?.user?.login || '').startsWith(CODEX_LOGIN)
    return {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      draft: Boolean(pr.draft),
      sha: pr.head.sha,
      checks: !runs.length ? 'none'
        : states.includes('failure') ? 'failing'
          : states.includes('pending') ? 'pending'
            : 'passing',
      checkCount: runs.length,
      claude: claude.state,
      claudeUrl: claude.url || null,
      codex: comments.some(byCodex) || reviews.some(byCodex),
    }
  }

  async function pulls(repo, reviewRunsByPr) {
    const open = await get(`repos/${repo}/pulls?state=open&per_page=20`)
    return mapLimit(open, 4, (pr) => pullRequest(repo, pr, reviewRunsByPr))
  }

  /** Everything one repo card shows. A `gh` failure becomes `error`, not a throw. */
  async function repoStatus(repo) {
    try {
      const branch = await defaultBranch(repo)
      const [ci, prs, runnerInfo, review, workflow, secret] = await Promise.all([
        mainRuns(repo, branch),
        reviewRuns(repo).then((byPr) => pulls(repo, byPr)),
        runners(repo),
        aiReview(repo),
        hasReviewWorkflow(repo),
        hasCiSecret(repo),
      ])
      const setup = { reviewWorkflow: workflow, runner: runnerInfo.runners.length > 0, ciSecret: secret }
      setup.missing = [
        !setup.reviewWorkflow && 'reviewWorkflow',
        !setup.runner && 'runner',
        setup.ciSecret === false && 'ciSecret',
      ].filter(Boolean)
      return { repo, defaultBranch: branch, ci, prs, ...runnerInfo, aiReview: review, setup }
    } catch (e) {
      return { repo, ci: [], prs: [], runners: [], aiReview: null, setup: null, error: ghErrorMessage(e) }
    }
  }

  /**
   * Every PR the gh login authored and merged since `since` (YYYY-MM-DD), in any
   * repo. Search answers at most 1,000 results per query, so the range is asked
   * for in two-week slices, each paged 100 at a time.
   */
  async function mergedPulls(since, { today = new Date() } = {}) {
    const day = (d) => d.toISOString().slice(0, 10)
    const ranges = []
    for (let start = new Date(`${since}T00:00:00Z`); start <= today; start = new Date(start.getTime() + SLICE_DAYS * DAY_MS)) {
      const end = new Date(start.getTime() + (SLICE_DAYS - 1) * DAY_MS)
      ranges.push(end >= today ? `>=${day(start)}` : `${day(start)}..${day(end)}`)
    }
    const slices = await mapLimit(ranges, 2, async (range) => {
      const q = encodeURIComponent(`is:pr is:merged author:@me merged:${range}`)
      const items = []
      for (let page = 1; page <= 10; page++) {
        const { items: batch = [] } = await get(`search/issues?q=${q}&per_page=100&page=${page}`)
        items.push(...batch)
        if (batch.length < 100) break
      }
      return items
    })
    const byUrl = new Map()
    for (const item of slices.flat()) {
      const repo = String(item.repository_url || '').split('/repos/')[1]
      const mergedAt = item.pull_request?.merged_at || item.closed_at
      if (repo && mergedAt) byUrl.set(item.html_url, { repo, number: item.number, title: item.title, url: item.html_url, mergedAt, summary: prSummary(item.body) })
    }
    return [...byUrl.values()].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))
  }

  // One GraphQL call. GitHub may answer with data and `errors` both (one issue
  // in an org that blocks the token), and gh then exits 1: the data is kept and
  // the errors become warnings. A call with no data at all still throws.
  async function graph(args) {
    let text
    let failure = null
    try {
      text = await run(args)
    } catch (e) {
      failure = e
      text = e?.stdout
    }
    let answer = null
    try { answer = text ? JSON.parse(text) : null } catch { /* not JSON: the failure stands */ }
    if (!answer?.data) {
      if (failure) throw failure
      throw new Error(String(answer?.errors?.[0]?.message || 'GitHub answered without data'))
    }
    return answer
  }

  // Every page of one issue connection, newest-updated first, up to ISSUE_CAP.
  // `capped` when there is more than was read: pages left at the cap, or a
  // total above what came back (search stops at 1,000 results with no next page).
  async function issuePages(args, pick, fallbackRepo) {
    const issues = []
    const warnings = new Set()
    let cursor = null
    let total = 0
    let returned = 0
    let more = false
    for (let page = 0; page < ISSUE_CAP / ISSUE_PAGE; page++) {
      const answer = await graph([...args, ...(cursor ? ['-f', `cursor=${cursor}`] : [])])
      for (const e of answer.errors || []) warnings.add(ghErrorMessage(e?.message || e))
      const conn = pick(answer.data)
      if (!conn) throw new Error(String(answer.errors?.[0]?.message || 'GitHub answered without an issue list'))
      total = Number(conn.totalCount ?? conn.issueCount) || 0
      returned += (conn.nodes || []).length
      for (const node of conn.nodes || []) {
        const row = issueRow(node, fallbackRepo)
        if (row) issues.push(row)
      }
      more = Boolean(conn.pageInfo?.hasNextPage && conn.pageInfo.endCursor)
      if (!more) break
      cursor = conn.pageInfo.endCursor
    }
    return { issues, total, capped: more || total > returned, warnings: [...warnings].slice(0, 3) }
  }

  /** One repo's issues (never PRs), newest-updated first. `state` is open, closed or all. */
  function repoIssues(repo, state) {
    const [owner, name] = repo.split('/')
    return issuePages(['api', 'graphql', '-f', `query=${repoIssuesQuery(state)}`, '-f', `owner=${owner}`, '-f', `name=${name}`],
      (data) => data?.repository?.issues, repo)
  }

  /** Issues assigned to the gh login, in every repo it can see. */
  function assignedIssues(state) {
    const q = `is:issue assignee:@me archived:false sort:updated-desc${SEARCH_STATE[state]}`
    return issuePages(['api', 'graphql', '-f', `query=${SEARCH_QUERY}`, '-f', `q=${q}`], (data) => data?.search)
  }

  /** The gh login's name; throws when gh is not signed in. */
  async function viewerLogin() {
    const login = (await get('user'))?.login
    if (!login) throw new Error('gh answered without a login')
    return String(login)
  }

  /** The cheaper subset the background watcher needs: CI on main and runners. */
  async function watchStatus(repo) {
    const branch = await defaultBranch(repo)
    const [ci, runnerInfo] = await Promise.all([mainRuns(repo, branch), runners(repo)])
    return { repo, defaultBranch: branch, ci, ...runnerInfo }
  }

  return { repoStatus, watchStatus, setAiReview, aiReview, repoVisible, dispatchReview, mergedPulls, repoIssues, assignedIssues, viewerLogin }
}
