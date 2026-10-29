import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat, getState, setActive, stop, settleThread, snoozeThread, markRead, threadTitle, type RunState } from './store'
import { useOnScreen, getOnScreen } from './onScreen'
import { isSnoozed, ago } from './settle'
import { pushToast } from '../toast'
import ThreadIcon from './ThreadIcon'
import ProjectIcon from './ProjectIcon'
import SnoozeMenu from './SnoozeMenu'
import { TI } from './ui'
import { IconPlayerStopFilled, IconClock, IconCheck, IconMailOpened, IconChevronDown, IconHome } from './icons'
import type { ChatThread, Project } from './types'
import { pendingQuestions } from './questions'

// The running-chats panel, bottom-right on every screen. It lists the chats that
// are answering and the finished ones he hasn't read yet (`needsReply`), that he
// can't already see: a chat open in the chat view, or whose row is on screen in
// the chats panel or a project page, is left out (onScreen.ts). An unread chat
// stays until he replies, marks it read, settles or snoozes it. The panel starts
// folded to its pill and stays that way until he opens it, so a reload doesn't
// put it in front of him; opened, it groups chats by where they live and offers
// what the chats panel does: open, stop, snooze, settle, mark as read.
//
// On a phone, a project or folder page lists that place's recent chats, and the
// panel would sit on top of them: there it drops the unread chats from elsewhere
// and folds to its pill, so the page's own list is what shows.
//
// A reply that finishes also raises a toast, unless that chat is open in front
// of him.

/** Wait this long before a chat joins the panel, so a row still mounting doesn't flash into it. */
const JOIN_DELAY_MS = 500
const FINISHED_TOAST_MS = 8000

/** Where a chat lives: Home, a project, or "Project › Folder". */
function placeOf(t: ChatThread, projects: Project[]): { key: string; label: string; project: Project | null } {
  const p = t.projectId ? projects.find((x) => x.id === t.projectId) : undefined
  if (!p) return { key: 'home', label: 'Home', project: null }
  const parent = p.parentId ? projects.find((x) => x.id === p.parentId) : undefined
  return { key: p.id, label: parent ? `${parent.name} › ${p.name}` : p.name, project: p }
}

/** Elapsed time, compactly: 8s, 1m 05s, 1h 12m. */
function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function useTick(ms: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** The last reply failed rather than finished. */
const failedReply = (t: ChatThread) => t.messages[t.messages.length - 1]?.status === 'error'

function Row({ t, run, now, onOpen, onSnooze }: {
  t: ChatThread
  run?: RunState
  now: number
  onOpen: () => void
  onSnooze: () => void
}) {
  const title = threadTitle(t)
  const failed = !run && failedReply(t)
  const asking = pendingQuestions(t)
  const status = asking
    ? <span className="vc-asking">{asking.part.questions.length === 1 ? 'A question for you' : `${asking.part.questions.length} questions for you`}</span>
    : run
    ? <><span className="vc-live-dot" aria-hidden /><span>{elapsed(now - run.startedAt)} · {run.activity || 'Working'}</span></>
    : failed
      ? <span>Failed {ago(t.updatedAt, now) !== 'now' ? `${ago(t.updatedAt, now)} ago` : 'just now'}</span>
      : <span>{ago(t.updatedAt, now) !== 'now' ? `Done ${ago(t.updatedAt, now)} ago` : 'Done just now'}</span>
  return (
    <div className="vc-runs-row">
      <button type="button" className="vc-runs-main" onClick={onOpen} title={`Open “${title}”`}>
        <ThreadIcon t={t} size={16} />
        <span className="vc-runs-text">
          <span className="vc-runs-name">{title}</span>
          <span className={`vc-runs-status ${run ? '' : failed ? 'failed' : 'done'}`}>{status}</span>
        </span>
      </button>
      {run && (
        <button type="button" className="vc-runs-act" onClick={() => stop(t.id)} aria-label={`Stop ${title}`} title="Stop">
          <TI icon={IconPlayerStopFilled} size={14} />
        </button>
      )}
      <button type="button" className="vc-runs-act" onClick={onSnooze} aria-label={`Snooze ${title}`} title="Snooze">
        <TI icon={IconClock} size={15} />
      </button>
      <button type="button" className="vc-runs-act" onClick={() => settleThread(t.id)} disabled={!!run} aria-label={`Settle ${title}`} title={run ? 'Settle once the reply finishes' : 'Settle'}>
        <TI icon={IconCheck} size={15} />
      </button>
      {!run && (
        <button type="button" className="vc-runs-act" onClick={() => markRead(t.id)} aria-label={`Mark ${title} as read`} title="Mark as read">
          <TI icon={IconMailOpened} size={15} />
        </button>
      )}
    </div>
  )
}

export default function RunningChats({ onOpenChat, onShowPanel, narrow }: { onOpenChat: () => void; onShowPanel: () => void; narrow: boolean }) {
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)
  const projects = useChat((s) => s.projects)
  const onScreen = useOnScreen()
  const [collapsed, setCollapsed] = useState(true)
  const [snoozing, setSnoozing] = useState<string | null>(null)
  const now = useTick(Object.keys(runs).length ? 1000 : 30_000)
  // Folded on arriving at a place's page.
  const placePage = narrow ? onScreen.page : null
  const onPlacePage = !!placePage
  useEffect(() => { if (onPlacePage) setCollapsed(true) }, [placePage]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((id: string) => {
    setActive(id)
    onOpenChat()
    onShowPanel()
  }, [onOpenChat, onShowPanel])

  // A run that ended. Stopped by hand, or dropped mid-stream (the store re-attaches
  // or re-syncs), is not news; a finished or failed reply is.
  const prevRuns = useRef(runs)
  useEffect(() => {
    const before = prevRuns.current
    prevRuns.current = runs
    for (const id of Object.keys(before)) {
      if (runs[id]) continue
      const t = getState().threads.find((x) => x.id === id)
      const last = t?.messages[t.messages.length - 1]
      if (!t || t.totemId || last?.role !== 'assistant' || (last.status !== 'done' && last.status !== 'error')) continue
      const seen = getOnScreen()
      if (seen.open.has(id)) continue
      const failed = last.status === 'error'
      const place = placeOf(t, getState().projects)
      pushToast(
        `${failed ? 'Failed' : 'Finished'}: “${threadTitle(t)}”${place.project ? ` in ${place.label}` : ''}`,
        failed ? 'error' : 'success',
        { duration: FINISHED_TOAST_MS, action: { label: 'Open', icon: null, onClick: () => open(id) } },
      )
    }
  }, [runs, open])

  const candidates = useMemo(() => threads.filter((t) => (
    !t.totemId && (runs[t.id] || pendingQuestions(t) || (t.needsReply && !onPlacePage)) && !onScreen.rows.has(t.id) && !onScreen.open.has(t.id)
    && !isSnoozed(t, now) && t.settledOverride !== 'settled'
  )), [threads, runs, onScreen, now, onPlacePage])

  // Leaving is immediate; joining waits a moment.
  const [shown, setShown] = useState<string[]>([])
  const shownRef = useRef(shown)
  const commit = (ids: string[]) => { shownRef.current = ids; setShown(ids) }
  const key = candidates.map((t) => t.id).join(',')
  useEffect(() => {
    const ids = key ? key.split(',') : []
    const keep = shownRef.current.filter((id) => ids.includes(id))
    if (keep.length !== shownRef.current.length) commit(keep)
    if (ids.every((id) => keep.includes(id))) return
    const timer = setTimeout(() => commit(ids), JOIN_DELAY_MS)
    return () => clearTimeout(timer)
  }, [key])

  const visible = candidates.filter((t) => shown.includes(t.id))
  const groups = useMemo(() => {
    const out = new Map<string, { label: string; project: Project | null; threads: ChatThread[] }>()
    for (const t of visible) {
      const place = placeOf(t, projects)
      const g = out.get(place.key) || { label: place.label, project: place.project, threads: [] }
      g.threads.push(t)
      out.set(place.key, g)
    }
    return [...out.values()]
  }, [visible, projects])

  const closeSnooze = useCallback(() => setSnoozing(null), [])
  if (!visible.length) return null

  const running = visible.filter((t) => runs[t.id]).length
  const done = visible.length - running
  const summary = [running && `${running} running`, done && `${done} unread`].filter(Boolean).join(' · ')

  if (collapsed) {
    return (
      <button type="button" className="vc-runs-pill" onClick={() => setCollapsed(false)} title="Show running chats">
        {running > 0 ? <span className="vc-live-dot" aria-hidden /> : <TI icon={IconCheck} size={14} />}
        <span>{summary}</span>
      </button>
    )
  }

  return (
    <section className="vc-runs" aria-label="Running chats">
      <header className="vc-runs-head">
        <span className="vc-runs-title">Chats <span className="vc-runs-count">{summary}</span></span>
        <button type="button" className="vc-runs-act" onClick={() => setCollapsed(true)} aria-label="Minimise" title="Minimise">
          <TI icon={IconChevronDown} size={16} />
        </button>
      </header>
      <div className="vc-runs-body">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="vc-runs-group">
              {g.project ? <ProjectIcon p={g.project} size={13} /> : <TI icon={IconHome} size={13} />}
              <span>{g.label}</span>
            </div>
            {g.threads.map((t) => (
              <Row
                key={t.id}
                t={t}
                run={runs[t.id]}
                now={now}
                onOpen={() => open(t.id)}
                onSnooze={() => setSnoozing((cur) => (cur === t.id ? null : t.id))}
              />
            ))}
          </div>
        ))}
      </div>
      {snoozing && <SnoozeMenu onSnooze={(until) => snoozeThread(snoozing, until)} onClose={closeSnooze} />}
    </section>
  )
}
