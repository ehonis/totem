import { useCallback, useEffect, useState } from 'react'
import { getInboxCount } from './api'

// Data source for the Inbox tab's badge.
//
// It lives here rather than in InboxView because the badge has to be correct
// whether or not that tab has ever been opened — the whole point is to tell you
// there is something waiting before you go looking.
//
// Three refresh triggers, because a badge that lies is worse than no badge:
//   - a slow poll, for proposals that appear with nobody watching (the nightly
//     journal ingest and the MCP server both stage them unprompted);
//   - INBOX_CHANGED, so a resolve you just did in the UI updates the badge now
//     instead of up to a minute later;
//   - regaining visibility, for the tab that sat open overnight.
export const INBOX_CHANGED = 'totem:inbox-changed'
export const notifyInboxChanged = () => window.dispatchEvent(new Event(INBOX_CHANGED))

const POLL_MS = 60_000

export interface InboxCount {
  open: number | null           // null until the first load lands, so 0 never flashes
  byKind: Record<string, number>
}

export function useInboxCount(enabled: boolean): InboxCount {
  const [open, setOpen] = useState<number | null>(null)
  const [byKind, setByKind] = useState<Record<string, number>>({})

  const load = useCallback(async () => {
    try {
      const data = await getInboxCount()
      setOpen(typeof data?.open === 'number' ? data.open : 0)
      setByKind(data?.byKind || {})
    } catch {
      // Swallowed on purpose. The badge is decoration; a failed poll must not
      // raise a toast or trigger the auth gate on top of whatever view the user
      // is actually using. The last known count stays on screen.
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    load()
    const timer = window.setInterval(load, POLL_MS)
    const onVisible = () => { if (!document.hidden) load() }
    window.addEventListener(INBOX_CHANGED, load)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(INBOX_CHANGED, load)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, load])

  return { open, byKind }
}

// "3 proposals waiting · 1 agent run, 2 tasks" for the tab's tooltip. The counts
// are worth naming: an agent run waiting on you is a different kind of nag from
// two tasks waiting on you.
const KIND_LABELS: Record<string, [string, string]> = {
  prompt: ['agent run', 'agent runs'],
  command: ['command', 'commands'],
  todo: ['task', 'tasks'],
  calendar: ['event', 'events'],
  github: ['issue', 'issues'],
  goal: ['goal update', 'goal updates'],
}

export function describeInboxCount(open: number, byKind: Record<string, number>): string {
  const head = `${open} proposal${open === 1 ? '' : 's'} waiting on your yes/no`
  const parts = Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => {
      const [one, many] = KIND_LABELS[kind] || [kind, `${kind}s`]
      return `${n} ${n === 1 ? one : many}`
    })
  return parts.length > 1 ? `${head} · ${parts.join(', ')}` : head
}
