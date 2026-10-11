import React, { useCallback, useEffect, useMemo, useState } from 'react'
import GithubView from './GithubView'
import {
  getDevStatus, setDevAiReview, setDevWatch, requestDevReview, AuthError,
  type DevAlert, type DevHealth, type DevPull, type DevRepo, type DevStatus,
} from '../api'
import { relTime } from '../usageMeta'
import { pushToast } from '../toast'
import { Hi, ArrowPathIcon, ClipboardDocumentIcon, WarnIcon } from '../icons'

// The Dev tab: CI on each repo's default branch, its open PRs and whether the AI
// reviewers ran, its self-hosted runners, and a switch that pauses AI review
// (the repo variable AI_REVIEW). GitHub is the source of truth; this only reads
// it, flips that one variable and starts one-off reviews. The watched repos are
// picked from "All repositories" at the bottom (data/dev.json; docs/dev-tab.md).

const ago = (iso?: string | null) => (iso ? relTime(new Date(iso).getTime()) : null)

const STATE_LABEL: Record<string, string> = {
  success: 'Passed', failure: 'Failed', pending: 'Running', cancelled: 'Cancelled', neutral: 'Skipped',
  passing: 'Checks pass', failing: 'Checks fail', none: 'No checks',
}

function Dot({ state }: { state: string }) {
  return <span className={`dev-dot dev-dot-${state}`} aria-hidden="true" />
}

const reviewMark = (state: DevPull['claude']) =>
  state === 'success' ? '✓' : state === 'failure' ? '✗' : state === 'queued' || state === 'running' ? '…' : '–'

const SETUP_MISSING: Record<string, string> = {
  reviewWorkflow: 'The review workflow (.github/workflows/review.yml)',
  runner: 'A self-hosted runner',
  ciSecret: 'The CLIPROXY_API_KEY secret',
}

const runnerState = (r: { status: string; busy: boolean }) =>
  r.status !== 'online' ? 'failure' : r.busy ? 'pending' : 'success'

export default function DevView({ onAuthError }: { onAuthError: () => void }) {
  const [data, setData] = useState<DevStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const auth = useCallback((e: unknown) => {
    if (e instanceof AuthError) { onAuthError(); return true }
    return false
  }, [onAuthError])

  // `quiet` keeps what is on screen while it reloads (after a watch change).
  const load = useCallback(async (refresh = false, quiet = false) => {
    if (refresh || quiet) setRefreshing(true); else setLoading(true)
    setError(null)
    try {
      setData(await getDevStatus(refresh))
    } catch (e: any) {
      if (!auth(e)) setError(e.message)
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [auth])

  useEffect(() => { load() }, [load])

  const patchRepo = (repo: string, aiReview: DevRepo['aiReview']) =>
    setData((d) => d && { ...d, repos: d.repos?.map((r) => (r.repo === repo ? { ...r, aiReview } : r)) })

  const watched = useMemo(() => new Set(data?.watched || []), [data?.watched])
  const setWatched = (list: string[]) => setData((d) => d && { ...d, watched: list })

  // Optimistic like the review switch; the cards catch up on the reload after.
  const toggleWatch = async (repo: string) => {
    const before = data?.watched || []
    const watch = !before.includes(repo)
    setWatched(watch ? [...before, repo] : before.filter((r) => r !== repo))
    try {
      setWatched((await setDevWatch(repo, watch)).watched)
      load(false, true)
    } catch (e: any) {
      setWatched(before)
      if (!auth(e)) pushToast(`Could not ${watch ? 'watch' : 'unwatch'} ${repo}: ${e.message}`)
    }
  }

  // Optimistic: the switch moves at once and moves back if GitHub refuses.
  const toggleReview = async (r: DevRepo) => {
    const before = r.aiReview
    const enabled = before !== 'on'
    patchRepo(r.repo, enabled ? 'on' : 'off')
    try {
      const res = await setDevAiReview(r.repo, enabled)
      patchRepo(r.repo, res.aiReview)
    } catch (e: any) {
      patchRepo(r.repo, before)
      if (!auth(e)) pushToast(`Could not change AI review on ${r.repo}: ${e.message}`)
    }
  }

  return (
    <div className="view dev-view">
      <div className="view-head">
        <div>
          <h1 style={{ marginBottom: 2 }}>Dev</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            {data?.fetchedAt ? `Checked ${ago(data.fetchedAt)}` : 'CI, reviews and runners across your repos'}
          </div>
        </div>
        <button className="btn" onClick={() => load(true)} disabled={refreshing || loading}>
          <Hi icon={ArrowPathIcon} size={14} className={refreshing ? 'spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <div className="muted inline-warn"><WarnIcon /> {error}</div>
      ) : loading || !data ? (
        <div className="spinner">Asking GitHub…</div>
      ) : (
        <>
          {!data.enabled && <DevSetup />}
          {!!data.health?.length && <HealthRow health={data.health} />}
          {data.repos?.filter((r) => watched.has(r.repo)).map((r) => (
            <RepoCard
              key={r.repo}
              repo={r}
              onToggleReview={() => toggleReview(r)}
              onUnwatch={() => { if (window.confirm(`Stop watching ${r.repo}? Its GitHub settings stay as they are.`)) toggleWatch(r.repo) }}
              onAuth={auth}
            />
          ))}
          <AlertList alerts={data.alerts} />
        </>
      )}

      <GithubView onAuthError={onAuthError} embedded watched={watched} onToggleWatch={toggleWatch} />
    </div>
  )
}

function DevSetup() {
  return (
    <div className="card dev-card">
      <h2>Set up the Dev tab</h2>
      <p className="muted">
        Pick repos to watch from All repositories below. The bridge reads them with the server's own <code>gh</code> login.
      </p>
      <p className="muted">
        Health checks are optional: add <code>{'"health": [{ "name", "url", "expect": [200] }]'}</code> to{' '}
        <code>data/dev.json</code>.
      </p>
      <p className="muted">
        Alerts from outside, such as a PostHog webhook, arrive at <code>POST /api/alerts/&lt;source&gt;</code> once{' '}
        <code>ALERT_INGEST_TOKEN</code> is set. They are listed below either way.
      </p>
    </div>
  )
}

function HealthRow({ health }: { health: DevHealth[] }) {
  return (
    <div className="dev-health">
      {health.map((h) => (
        <span key={h.name} className="dev-chip" title={h.error || `HTTP ${h.status} in ${h.ms} ms`}>
          <Dot state={h.ok ? 'success' : 'failure'} />
          {h.name}
          <span className="muted">{h.error || h.status}</span>
        </span>
      ))}
    </div>
  )
}

// What a watched repo still needs before AI review works on it, and the one
// command that sets it up (the review-ci-setup skill, run on the dev box).
function SetupMissing({ repo, missing }: { repo: string; missing: string[] }) {
  const command = `/review-ci-setup ${repo}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      pushToast('Copied.', 'success', { duration: 2000 })
    } catch {
      pushToast('Could not copy; select the line instead.')
    }
  }
  return (
    <div className="dev-setup">
      <h3>Not set up for AI review</h3>
      <ul>{missing.map((m) => <li key={m}>{SETUP_MISSING[m] || m}</li>)}</ul>
      <div className="dev-setup-command">
        <code>{command}</code>
        <button type="button" className="btn compact" onClick={copy} title="Copy">
          <Hi icon={ClipboardDocumentIcon} size={13} /> Copy
        </button>
      </div>
      <p className="muted">Run this in a T3 thread on the dev box.</p>
    </div>
  )
}

function RepoCard({ repo: r, onToggleReview, onUnwatch, onAuth }: {
  repo: DevRepo
  onToggleReview: () => void
  onUnwatch: () => void
  onAuth: (e: unknown) => boolean
}) {
  const gh = `https://github.com/${r.repo}`
  const canReview = Boolean(r.setup?.reviewWorkflow)
  const [queued, setQueued] = useState<Set<number>>(new Set())

  // "Queued" for a few seconds; the run itself shows on the next refresh.
  const review = async (pr: DevPull) => {
    setQueued((q) => new Set(q).add(pr.number))
    try {
      await requestDevReview(r.repo, pr.number)
      setTimeout(() => setQueued((q) => { const next = new Set(q); next.delete(pr.number); return next }), 5000)
    } catch (e: any) {
      setQueued((q) => { const next = new Set(q); next.delete(pr.number); return next })
      if (!onAuth(e)) pushToast(`Could not start a review of #${pr.number}: ${e.message}`)
    }
  }

  return (
    <section className="card dev-card">
      <div className="dev-card-head">
        <a href={gh} target="_blank" rel="noreferrer" className="gh-repo-name">
          <span className="gh-owner">{r.repo.split('/')[0]}/</span><b>{r.repo.split('/')[1]}</b>
        </a>
        <span className="dev-card-actions">
          {canReview && (
            <label className="dev-switch-label">
              AI review
              <button
                type="button"
                role="switch"
                aria-checked={r.aiReview === 'on'}
                className={`switch ${r.aiReview === 'on' ? 'on' : ''}`}
                disabled={!r.aiReview}
                onClick={onToggleReview}
                title={r.aiReview === 'off' ? 'Paused: the repo variable AI_REVIEW is off' : 'On: AI_REVIEW is unset'}
              ><span /></button>
            </label>
          )}
          <button type="button" className="btn compact" onClick={onUnwatch}>Unwatch</button>
        </span>
      </div>

      {!!r.setup?.missing.length && <SetupMissing repo={r.repo} missing={r.setup.missing} />}

      {r.error ? (
        <div className="muted inline-warn"><WarnIcon /> {r.error}</div>
      ) : (
        <>
          <h3>CI on {r.defaultBranch || 'main'}</h3>
          {r.ci.length === 0 ? <div className="muted dev-none">No workflow runs yet.</div> : r.ci.map((run) => (
            <div className="dev-row" key={run.workflow}>
              <Dot state={run.state} />
              <a href={run.url} target="_blank" rel="noreferrer" className="dev-grow">{run.workflow}</a>
              <span className="muted">{STATE_LABEL[run.state]}</span>
              <span className="muted dev-time">{ago(run.createdAt)}</span>
            </div>
          ))}

          <h3>Open pull requests</h3>
          {r.prs.length === 0 ? <div className="muted dev-none">None open.</div> : r.prs.map((pr) => (
            <div className="dev-row dev-pr" key={pr.number}>
              <a href={pr.url} target="_blank" rel="noreferrer" className="dev-grow">
                <span className="muted">#{pr.number}</span> {pr.title}
                {pr.draft && <span className="pill gh-badge">Draft</span>}
              </a>
              <span className="dev-pr-meta">
                <span className="dev-inline"><Dot state={pr.checks === 'passing' ? 'success' : pr.checks === 'failing' ? 'failure' : pr.checks === 'pending' ? 'pending' : 'neutral'} />{STATE_LABEL[pr.checks]}</span>
                {pr.claudeUrl
                  ? <a className="muted" href={pr.claudeUrl} target="_blank" rel="noreferrer" title={`Claude review: ${pr.claude}`}>Claude {reviewMark(pr.claude)}</a>
                  : <span className="muted" title="Claude review">Claude {reviewMark(pr.claude)}</span>}
                <span className="muted" title="Codex review">Codex {pr.codex ? '✓' : '–'}</span>
                {canReview && (
                  <button type="button" className="btn compact" disabled={queued.has(pr.number)} onClick={() => review(pr)}
                    title="Run the Claude review on this PR now, whatever the AI review switch says">
                    {queued.has(pr.number) ? 'Queued' : 'Review'}
                  </button>
                )}
              </span>
            </div>
          ))}

          {(r.runners.length > 0 || r.runnersError) && <h3>Runners</h3>}
          {r.runnersError && r.runners.length === 0 && <div className="muted dev-none">{r.runnersError}</div>}
          {r.runners.map((runner) => (
            <div className="dev-row" key={runner.name}>
              <Dot state={runnerState(runner)} />
              <span className="dev-grow">{runner.name}</span>
              <span className="muted">{runner.status !== 'online' ? 'Offline' : runner.busy ? 'Busy' : 'Idle'}</span>
            </div>
          ))}
        </>
      )}
    </section>
  )
}

function AlertList({ alerts }: { alerts: DevAlert[] }) {
  return (
    <section className="card dev-card">
      <h2>Recent alerts</h2>
      {alerts.length === 0 ? <div className="muted dev-none">Nothing yet.</div> : alerts.map((a) => (
        <div className="dev-row dev-alert" key={a.id}>
          <span className="pill">{a.source}</span>
          <span className="dev-grow">
            {a.url ? <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a> : a.title}
            {a.body && <span className="muted dev-alert-body">{a.body}</span>}
          </span>
          <span className="muted dev-time" title={a.delivered ? 'Sent to your devices' : 'Repeat within the hour; recorded, not sent'}>{ago(a.at)}</span>
        </div>
      ))}
    </section>
  )
}
