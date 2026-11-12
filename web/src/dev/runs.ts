// What the Runs card (RunsCard.tsx) works out from a run, kept apart from the
// component so it can be tested. docs/dev-tab.md → Runs.
import type { DevRun, DevRunThread } from '../api'

export const STALE_MS = 2 * 60 * 60_000

/** Active runs newest-updated first, then the archived ones newest-archived first. */
export function splitRuns(runs: DevRun[]) {
  const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0)
  const active = runs.filter((r) => !r.archived).sort((a, b) => at(b.updatedAt) - at(a.updatedAt))
  const finished = runs.filter((r) => r.archived).sort((a, b) => at(b.archivedAt || b.updatedAt) - at(a.archivedAt || a.updatedAt))
  return { active, finished }
}

export const isStale = (run: Pick<DevRun, 'updatedAt'>, now = Date.now()) => now - (Date.parse(run.updatedAt) || 0) > STALE_MS

const STAGE_LABEL: Record<DevRunThread['stage'], string> = {
  building: 'Building', pr: 'PR open', review: 'Review', fixing: 'Fixing', ready: 'Ready', merged: 'Merged', blocked: 'Blocked',
}

export const stageLabel = (t: Pick<DevRunThread, 'stage' | 'round'>) =>
  t.stage === 'review' && t.round ? `Review, round ${t.round}` : STAGE_LABEL[t.stage] || t.stage

/** The dot beside a stage: the Dev tab's success / failure / pending / neutral. */
export function stageTone(stage: DevRunThread['stage']) {
  if (stage === 'blocked') return 'failure'
  if (stage === 'ready' || stage === 'merged') return 'success'
  if (stage === 'building' || stage === 'fixing') return 'pending'
  return 'neutral'
}

export const ciTone = (ci: DevRunThread['ci']) =>
  ci === 'passing' ? 'success' : ci === 'failing' ? 'failure' : ci === 'pending' ? 'pending' : 'neutral'

export const CI_LABEL: Record<DevRunThread['ci'], string> = { passing: 'CI passing', failing: 'CI failing', pending: 'CI running', none: 'No CI' }

/** "#12", "12" and "owner/repo#12" all read as "#12". */
export const issueLabel = (issue: string | null) => {
  if (!issue) return null
  const m = /#?(\d+)$/.exec(issue)
  return m ? `#${m[1]}` : issue
}

/** "3 of 5 merged · 1 blocked": a run's threads at a glance. */
export function threadSummary(threads: DevRunThread[]) {
  if (!threads.length) return 'No threads yet'
  const merged = threads.filter((t) => t.stage === 'merged').length
  const blocked = threads.filter((t) => t.stage === 'blocked').length
  const parts = [`${merged} of ${threads.length} merged`]
  if (blocked) parts.push(`${blocked} blocked`)
  return parts.join(' · ')
}
