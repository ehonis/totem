import React, { useCallback, useEffect, useState } from 'react'
import { getDevRuns, setDevRunArchived, AuthError, type DevRun, type DevRunThread } from '../api'
import { relTime } from '../usageMeta'
import { readDevCache, writeDevCache } from '../devCache'
import { pushToast } from '../toast'
import { WarnIcon } from '../icons'
import { CI_LABEL, ciTone, isStale, issueLabel, splitRuns, stageLabel, stageTone, threadSummary } from './runs'
import './runs.css'

// The Dev tab's first card: every orchestrated run whose ORCH thread pushes its
// status here (POST /api/dev/runs/:slug, dev/runs.mjs). One block per active
// run, newest first; archived runs fold into Finished. Nothing shows until a run
// has reported. docs/dev-tab.md → Runs.

const POLL_MS = 60_000
const ago = (iso?: string | null) => (iso ? relTime(new Date(iso).getTime()) : null)

function Dot({ state }: { state: string }) {
  return <span className={`dev-dot dev-dot-${state}`} aria-hidden="true" />
}

export default function RunsCard({ onAuthError, reload = 0 }: { onAuthError: () => void; reload?: number }) {
  const [runs, setRuns] = useState<DevRun[] | null>(() => readDevCache<DevRun[]>('runs'))
  const [error, setError] = useState<string | null>(null)
  const [, tick] = useState(0)

  const load = useCallback(async () => {
    try {
      const { runs: next } = await getDevRuns()
      setRuns(next)
      setError(null)
      writeDevCache('runs', next)
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError()
      else setError(e.message)
    }
  }, [onAuthError])

  // Asks again every minute while the tab is on screen; "updated N min ago" moves with it.
  useEffect(() => {
    load()
    const id = window.setInterval(() => { if (!document.hidden) { load(); tick((n) => n + 1) } }, POLL_MS)
    const onShow = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onShow)
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onShow) }
  }, [load])
  useEffect(() => { if (reload) load() }, [reload, load])

  const archive = async (run: DevRun, archived: boolean) => {
    const before = runs
    setRuns((list) => list && list.map((r) => (r.slug === run.slug ? { ...r, archived, archivedAt: archived ? new Date().toISOString() : null } : r)))
    try {
      await setDevRunArchived(run.slug, archived)
    } catch (e: any) {
      setRuns(before)
      if (e instanceof AuthError) onAuthError()
      else pushToast(`Could not ${archived ? 'archive' : 'restore'} ${run.title}: ${e.message}`)
    }
  }

  if (!runs?.length) return error ? <div className="muted inline-warn"><WarnIcon /> Runs: {error}</div> : null
  const { active, finished } = splitRuns(runs)

  return (
    <section className="card dev-card dev-runs" aria-labelledby="dev-runs-title">
      <div className="dev-card-head">
        <h2 id="dev-runs-title" style={{ margin: 0 }}>Runs</h2>
        <span className="muted dev-runs-count">{active.length ? `${active.length} active` : 'None active'}</span>
      </div>
      {error && <div className="muted inline-warn"><WarnIcon /> {error}</div>}
      {active.map((run) => <RunBlock key={run.slug} run={run} onArchive={() => archive(run, true)} />)}
      {finished.length > 0 && (
        <details className="dev-runs-finished">
          <summary>Finished <span className="muted">{finished.length}</span></summary>
          {finished.map((run) => (
            <div className="dev-row" key={run.slug}>
              <span className="dev-grow">
                {run.orchUrl ? <a href={run.orchUrl} target="_blank" rel="noreferrer">{run.title}</a> : run.title}
                {run.repo && <span className="muted"> · {run.repo}</span>}
              </span>
              {run.handoffUrl && <a className="muted" href={run.handoffUrl} target="_blank" rel="noreferrer">Handoff</a>}
              <span className="muted dev-time">{ago(run.finishedAt || run.archivedAt)}</span>
              <button type="button" className="btn compact" onClick={() => archive(run, false)}>Restore</button>
            </div>
          ))}
        </details>
      )}
    </section>
  )
}

function RunBlock({ run, onArchive }: { run: DevRun; onArchive: () => void }) {
  const stale = isStale(run)
  return (
    <article className="dev-run" aria-label={run.title}>
      <div className="dev-run-head">
        <div className="dev-run-name">
          {run.orchUrl
            ? <a href={run.orchUrl} target="_blank" rel="noreferrer" title="Open the ORCH thread in T3 Code"><b>{run.title}</b></a>
            : <b>{run.title}</b>}
          <span className="muted dev-run-sub">
            {run.repo && <>{run.repo} · </>}
            {threadSummary(run.threads)}
            {' · '}
            <span className={stale ? 'dev-run-stale' : undefined} title={new Date(run.updatedAt).toLocaleString()}>
              {stale ? `Stale, updated ${ago(run.updatedAt)}` : `Updated ${ago(run.updatedAt)}`}
            </span>
          </span>
        </div>
        <button type="button" className="btn compact" onClick={onArchive} title="Move to Finished">Archive</button>
      </div>

      {run.waitingOnEthan.length > 0 && (
        <div className="dev-run-waiting">
          <b>Waiting on you</b>
          <ul>{run.waitingOnEthan.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      {run.incidents.length > 0 && (
        <ul className="dev-run-incidents" aria-label="Incidents">
          {run.incidents.map((i) => <li key={i}><WarnIcon /> {i}</li>)}
        </ul>
      )}

      {run.threads.length > 0 && (
        <table className="dev-run-threads">
          <thead>
            <tr><th>Thread</th><th>Stage</th><th>PR</th><th className="num">Code</th><th className="num">UX</th><th>Skipped</th></tr>
          </thead>
          <tbody>{run.threads.map((t, i) => <ThreadRow key={`${t.issue || ''}-${i}`} t={t} />)}</tbody>
        </table>
      )}
    </article>
  )
}

function ThreadRow({ t }: { t: DevRunThread }) {
  const issue = issueLabel(t.issue)
  const reported = ago(t.lastReportAt)
  return (
    <tr className={t.stage === 'blocked' ? 'is-blocked' : undefined}>
      <td className="dev-run-thread">
        {issue && <span className="muted">{issue} </span>}
        <span title={reported ? `Last report ${reported}` : undefined}>{t.title || 'Untitled'}</span>
      </td>
      <td className="dev-run-stage"><span className="dev-inline"><Dot state={stageTone(t.stage)} />{stageLabel(t)}</span></td>
      <td className="dev-run-pr">
        {t.pr ? (
          <span className="dev-inline" title={CI_LABEL[t.ci]}>
            <Dot state={ciTone(t.ci)} />
            {t.pr.url ? <a href={t.pr.url} target="_blank" rel="noreferrer">#{t.pr.number ?? 'PR'}</a> : `#${t.pr.number}`}
            <span className="sr-only">{CI_LABEL[t.ci]}</span>
          </span>
        ) : <span className="muted">No PR</span>}
      </td>
      <td className={`num dev-run-score${t.codeScore == null ? ' is-empty' : ''}`} data-label="Code">{t.codeScore ?? <span className="muted">–</span>}</td>
      <td className={`num dev-run-score${t.uxScore == null ? ' is-empty' : ''}`} data-label="UX">{t.uxScore ?? <span className="muted">–</span>}</td>
      <td className="dev-run-skipped muted" data-label={t.skippedSeats.length ? 'Skipped' : undefined}>{t.skippedSeats.join(', ')}</td>
    </tr>
  )
}
