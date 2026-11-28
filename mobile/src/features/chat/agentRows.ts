// What a sub-agent's row says, after T3 Code's mobile SubagentRow and its
// subagentDisplay helpers: a status dot and label, the title, how long it has run,
// and one detail line (what it is doing while it works, what it handed back after).
// The app reads agents brief (chat/subagents.mjs): no steps, only stepCount, now and
// lastAt, so nothing here needs the log. Pure, so node can test it (agentRows.test.mjs).
import type { AgentInfo } from '../../lib/chat/types'

export type AgentTone = 'working' | 'completed' | 'failed' | 'stopped'

export const agentTone = (status: AgentInfo['status']): AgentTone =>
  status === 'running' ? 'working' : status === 'done' ? 'completed' : status === 'error' ? 'failed' : 'stopped'

/** T3's row labels. */
export const AGENT_STATUS_LABEL: Record<AgentInfo['status'], string> = { running: 'Working', done: 'Completed', error: 'Failed', stopped: 'Stopped' }

const firstLine = (s?: string) => (s || '').split('\n').map((l) => l.trim()).find(Boolean) || ''

/** How many steps its log has, whether this copy holds the log or only the count. */
export const stepCountOf = (a: AgentInfo) => a.stepCount ?? (a.steps?.length || 0) + (a.dropped || 0)

/** What it is doing now, in one line. */
export function agentNowOf(a: AgentInfo) {
  if (a.now) return a.now
  const last = a.steps?.[a.steps.length - 1]
  if (last?.kind === 'tool') return [last.title, last.detail].filter(Boolean).join(' · ')
  if (last?.kind === 'thinking') return 'Thinking'
  if (last?.kind === 'text') return firstLine(last.text)
  return a.progress || 'Starting'
}

/** The last moment this copy saw the agent at work. */
export const lastSeen = (a: AgentInfo) => Math.max(a.startedAt || 0, a.lastAt || 0, ...(a.steps || []).map((s) => s.endedAt || s.at || 0))

/**
 * How long it has run. In a reply that is not live here, an agent still marked running
 * is one whose end this copy has not heard yet (the bridge settles every agent when a run
 * ends), so its clock stops at the last step seen rather than counting on.
 */
export const elapsedOf = (a: AgentInfo, live: boolean, now = Date.now()) =>
  (a.startedAt ? (a.endedAt || (live ? now : lastSeen(a))) - a.startedAt : 0)

/** A group's time: from the first start to the last end (or now, while one works here). */
export function groupElapsed(agents: AgentInfo[], live: boolean, now = Date.now()) {
  const starts = agents.map((a) => a.startedAt).filter((n): n is number => !!n)
  if (!starts.length) return 0
  const ends = agents.map((a) => (a.status === 'running' ? (live ? now : lastSeen(a)) : a.endedAt || lastSeen(a)))
  return Math.max(...ends) - Math.min(...starts)
}

/** T3's group line: "2 working · 1 done". */
export function statusSummary(agents: Pick<AgentInfo, 'status'>[]) {
  const counts = { working: 0, done: 0, failed: 0, stopped: 0 }
  for (const a of agents) {
    if (a.status === 'running') counts.working++
    else if (a.status === 'done') counts.done++
    else if (a.status === 'error') counts.failed++
    else counts.stopped++
  }
  return (Object.keys(counts) as (keyof typeof counts)[]).filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`).join(' · ')
}

/** The row's title: what it was started for. */
export const agentTitle = (a: AgentInfo, fallback = 'Subagent') => a.title?.trim() || firstLine(a.prompt) || fallback

/**
 * One line under the title, T3's subagentDetailPreview and subagentCardDetail: while it
 * works, what it is doing; once it ends, what it handed back (Markdown flattened).
 */
export function rowDetail(a: AgentInfo) {
  const ended = a.status !== 'running'
  const summary = (a.summary || '').trim()
  const handedBack = summary && summary !== a.title?.trim() ? summary : ''
  const text = ended ? handedBack || a.progress || '' : agentNowOf(a)
  return text
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/^[ \t]*[-*#>]+[ \t]+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280)
}

/** The model line: "Claude · claude-opus-5-5", the sub-agent type when it has one. */
export function agentMeta(a: AgentInfo, providerName: string) {
  return [providerName, a.model, a.name && a.name !== 'general-purpose' ? a.name : ''].filter(Boolean).join(' · ')
}
