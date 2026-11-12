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
 * What the agent says between calls is folded only while it is commentary: a
 * line or two of "let me check…". Anything longer, or shaped like an answer (a
 * heading, a list, a table, code), stays in the reply, because agents often
 * answer first and then save a note or file a task, and the line after that
 * last call ("Noted in memory.") is not the answer.
 */
export function isCommentary(text: string) {
  const t = text.trim()
  return t.length < 280 && !/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||```)/m.test(t) && !/\n\s*\n/.test(t)
}

/**
 * Pull the tool runs, and the commentary before the last of them, into `work`
 * blocks, each placed where its first step was. Text before the last call that
 * is not commentary stays in the reply and splits the fold around it, so the
 * reply still reads in order. Anything else (a proposal, a file, a sub-agent's
 * card, the owner's steer) stays where it was, outside the fold.
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
  const out: (B | WorkBlock | null)[] = []
  let items: WorkItem[] = []
  let at = -1
  const close = () => {
    if (at < 0) return
    if (items.some((it) => it.kind === 'tools')) out[at] = { kind: 'work', items, key: `work-${items[0].key}` }
    else out.splice(at, 1, ...(items as unknown as B[]))
    items = []
    at = -1
  }
  list.forEach((b, i) => {
    const folds = i <= last && (b.kind === 'tools' || (b.kind === 'text' && isCommentary((b as unknown as { text: string }).text)))
    if (!folds) {
      if (b.kind === 'text') close()
      out.push(b)
      return
    }
    if (at < 0) { at = out.length; out.push(null) }
    items.push(b as unknown as WorkItem)
  })
  close()
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
