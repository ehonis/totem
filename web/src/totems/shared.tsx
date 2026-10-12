import React from 'react'
import { api, runJobNow, getJobs } from '../api'
import { pushError, pushToast } from '../toast'
import { Hi } from '../icons'
import { iconFor } from '../studio'
import { THREAD_ICONS } from '../chat/threadIcons.gen'
import { TI } from '../chat/ui'
import { syncThreads, setActive } from '../chat/store'
import { relativeTime } from '../components/JobsView'

// What the Totems list (components/TotemsView.tsx) and a totem's chat need to
// describe a totem.

export interface Rec { provider: string; model: string; effort: string; label: string; account: string; driver: string; cost: number; why: string }
export type WatchSource = { kind: 'git'; repo: string; ref: string } | { kind: 'url'; url: string; contains?: string }
/** What a totem watches (jobs/triggers.mjs). One check covers every source. */
export interface Watch { type: 'watch'; everyMinutes: number; sources: WatchSource[] }
/** A watch in the current shape; drafts saved before a watch could list several hold a single `source`. */
export function asWatch(w: any): Watch | null {
  if (!w) return null
  return { type: 'watch', everyMinutes: w.everyMinutes, sources: Array.isArray(w.sources) ? w.sources : w.source ? [w.source] : [] }
}
/** The key the bridge keeps a source's baseline under (`sourceKey` in jobs/triggers.mjs). */
export const sourceKey = (s: WatchSource) => (s.kind === 'git' ? `git ${s.repo} ${s.ref}` : `url ${s.url}${s.contains ? ` ${s.contains}` : ''}`)
export interface Draft {
  name: string; summary?: string; icon: string; taskType: string; instructions: string; schedule: any; trigger: Watch | null; browser: boolean
  notify: string; recommendations: Rec[]; questions: string[]; reply?: string
}
/** Which model runs it. `provider: 'default'` is the default account's default model. */
export interface Choice { provider: string; model: string; effort: string }
/** One turn of the builder conversation; the bridge writes these (totems/drafts.mjs). */
export interface Msg { role: 'owner' | 'builder'; text: string; questions?: string[]; error?: boolean; at: number }
/** A totem he started building and has not created yet. */
export interface DraftRecord {
  id: string; description: string; draft: Draft | null; choice: Choice | null; messages: Msg[]
  pending: { text: string; startedAt: number } | null; updatedAt: number
}

export const TYPE_LABEL: Record<string, string> = {
  watcher: 'Watcher', researcher: 'Researcher', analyst: 'Analyst', writer: 'Writer', organiser: 'Organiser', coach: 'Coach', coder: 'Coder', other: 'Agent',
}

export function TotemIcon({ name, size = 20 }: { name?: string; size?: number }) {
  const tabler = name ? THREAD_ICONS[name] : null
  if (tabler) return <TI icon={tabler} size={size} />
  return <Hi icon={iconFor(name || '', 'sparkles')} size={size} />
}

export const kindOf = (job: any) => (job.runner ? 'Built-in' : job.skillId ? 'Skill' : TYPE_LABEL[job.taskType] || 'Agent')

export function statusLine(job: any) {
  if (job.lastRun?.status === 'running') return 'Running now…'
  if (!job.enabled) return 'Paused'
  if (job.trigger) {
    const w = job.watch
    if (w?.error) return `Can’t check: ${w.error}`
    if (!w?.checkedAt) return 'First check within a minute'
    return `Checked ${relativeTime(w.checkedAt)}${w.changedAt ? ` · last change ${relativeTime(w.changedAt)}` : ''}${job.lastRun?.status === 'error' ? ' · last run failed' : ''}`
  }
  const next = job.nextRunAt ? `Next ${relativeTime(job.nextRunAt)}` : 'Not scheduled'
  if (job.lastRun?.status === 'error') return `Last run failed · ${next}`
  return next
}

export async function openTotemChat(job: any, onOpenChat: () => void) {
  try {
    const { threadId } = await api<{ threadId: string }>(`/api/totems/${encodeURIComponent(job.id)}/thread`, { method: 'POST' })
    await syncThreads()
    setActive(threadId)
    onOpenChat()
  } catch (e: any) { pushError(`Couldn't open the chat: ${e.message}`) }
}

/** Run a totem now and say how it went. Resolves to the refreshed job, if any. */
export async function runTotemNow(job: any): Promise<any | null> {
  try {
    const r: any = await runJobNow(job.id)
    const status = r.run?.status
    pushToast(status === 'error' ? `${job.name} failed: ${r.run?.error || 'no error text'}` : status === 'skipped' ? `${job.name} checked: nothing new` : `${job.name} ran. Its report is in its chat.`, status === 'error' ? 'error' : 'info')
    return (r.jobs || []).find((j: any) => j.id === job.id) || null
  } catch (e: any) { pushError(e.message); return null }
}

// Totem names and icons by id, for chat surfaces that only hold an id (a group
// chat's members, a totem asked mid-reply). One shared fetch, refreshed after a minute.
let directory: Map<string, any> = new Map()
let loadedAt = 0
let loading: Promise<void> | null = null
const dirSubs = new Set<() => void>()
export function refreshTotemDirectory(force = false) {
  if (loading || (!force && Date.now() - loadedAt < 60_000)) return loading
  loading = getJobs().then((p: any) => {
    directory = new Map((p.jobs || []).map((j: any) => [j.id, j]))
    loadedAt = Date.now()
    dirSubs.forEach((f) => f())
  }).catch(() => {}).finally(() => { loading = null })
  return loading
}
export function useTotemDirectory(): Map<string, any> {
  const [, bump] = React.useState(0)
  React.useEffect(() => {
    const f = () => bump((n) => n + 1)
    dirSubs.add(f)
    refreshTotemDirectory()
    return () => { dirSubs.delete(f) }
  }, [])
  return directory
}
