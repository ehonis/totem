import type { ChatThread } from './types'

// The chats panel's Totems section: every totem, the one that ran most recently
// first, each with what it is doing now. A row opens the totem's chat.

export type TotemNavState = 'running' | 'unread' | 'failed' | 'paused' | 'idle'

export interface TotemNavRow {
  job: any
  /** Its own chat, once it has one (`totem-<id>`, carrying `totemId`). */
  thread?: ChatThread
  /** When it last ran; 0 if never. */
  lastRanAt: number
  state: TotemNavState
}

/**
 * Rows for every totem, most recently run first (never-run ones last, by name).
 * State, strongest first: running now (a scheduled run or an answer in its chat),
 * a report waiting unread, a failed last run, paused, otherwise idle.
 */
export function totemNavRows(jobs: any[], threads: ChatThread[], running: Record<string, unknown> = {}): TotemNavRow[] {
  const own = new Map(threads.filter((t) => t.totemId).map((t) => [t.totemId!, t]))
  return jobs
    .map((job) => {
      const thread = own.get(job.id)
      const lastRanAt = Number(job.lastRun?.startedAt) || 0
      const state: TotemNavState = job.lastRun?.status === 'running' || (thread && running[thread.id]) ? 'running'
        : thread?.needsReply ? 'unread'
          : job.lastRun?.status === 'error' ? 'failed'
            : !job.enabled ? 'paused' : 'idle'
      return { job, thread, lastRanAt, state }
    })
    .sort((a, b) => b.lastRanAt - a.lastRanAt || String(a.job.name).localeCompare(String(b.job.name)))
}
