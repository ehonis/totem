// How a finished reply hides its working. Everything the agent did on the way
// to the answer — its tool calls and the "let me check…" lines it said between
// them — folds into one line above the answer, the way T3 Code does, with the
// logos of the connectors it used stacked at the front. The answer is the text
// after the last call; the fold opens to show every step.
import type { ToolPart } from './types'
import { toolApp } from './ui'

/** One step inside the fold: a run of tool calls, or what the agent said between them. */
export type WorkItem = { kind: 'tools'; tools: ToolPart[]; key: string } | { kind: 'text'; text: string; key: string }
export type WorkBlock = { kind: 'work'; items: WorkItem[]; key: string }

/**
 * Pull the tool runs, and the text before the last of them, into one `work`
 * block placed where the first of them was. Anything else (a proposal, a file,
 * a sub-agent's card, the owner's steer) stays where it was, outside the fold.
 *
 * Only a settled reply folds. While it runs, what the agent says between its
 * calls stays in the reply where the owner can follow it, and each run of calls
 * is its own one-line step; the fold closes over them when the answer is in.
 */
export function foldWork<B extends { kind: string; key: string }>(list: B[], settled = true): (B | WorkBlock)[] {
  if (!settled) {
    return list.map((b) => (b.kind === 'tools' ? { kind: 'work', items: [b as unknown as WorkItem], key: b.key } : b))
  }
  let last = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].kind === 'tools' || list[i].kind === 'agent') { last = i; break }
  }
  if (!list.some((b, i) => i <= last && b.kind === 'tools')) return list
  const items: WorkItem[] = []
  const out: (B | WorkBlock | null)[] = []
  let at = -1
  list.forEach((b, i) => {
    if (i > last || (b.kind !== 'tools' && b.kind !== 'text')) { out.push(b); return }
    if (at < 0) { at = out.length; out.push(null) }
    items.push(b as unknown as WorkItem)
  })
  out[at] = { kind: 'work', items, key: `work-${items[0].key}` }
  return out as (B | WorkBlock)[]
}

/** A connector or Totem app the steps used, in first-use order. */
export interface WorkSource { key: string; label: string; server?: string; logo?: string }

export function workSources(tools: ToolPart[]): WorkSource[] {
  const seen = new Map<string, WorkSource>()
  for (const t of tools) {
    const label = t.app || toolApp(t.server)?.label
    if (!label) continue
    const key = (t.server || label).toLowerCase()
    const had = seen.get(key)
    if (!had) seen.set(key, { key, label, ...(t.server ? { server: t.server } : {}), ...(t.logo ? { logo: t.logo } : {}) })
    else if (!had.logo && t.logo) had.logo = t.logo
  }
  return [...seen.values()]
}

const names = (labels: string[]) =>
  labels.length <= 2 ? labels.join(' and ') : `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`

/** The fold's one line: the running call while it works, then what was used. */
export function summarizeWork(tools: ToolPart[], live: boolean) {
  const running = tools.find((t) => t.status === 'running')
  if (live && running) return { text: running.title + (running.detail ? ` · ${running.detail}` : ''), running: true }
  const failed = tools.filter((t) => t.status === 'error').length
  const steps = `${tools.length} step${tools.length === 1 ? '' : 's'}`
  const used = workSources(tools).map((s) => s.label)
  let text: string
  if (tools.length === 1) text = tools[0].title + (tools[0].detail ? ` · ${tools[0].detail}` : '')
  else if (used.length) text = `Used ${names(used)} · ${steps}`
  else text = `Worked through ${steps}`
  if (failed) text += ` · ${failed} failed`
  return { text, running: false }
}

/** First call started to last call ended. */
export function workElapsed(tools: ToolPart[]) {
  const start = Math.min(...tools.map((t) => t.startedAt || Infinity))
  const end = Math.max(...tools.map((t) => t.endedAt || 0))
  return Number.isFinite(start) && end > start ? end - start : 0
}
