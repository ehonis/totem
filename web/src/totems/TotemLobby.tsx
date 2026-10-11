import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { updateJob } from '../api'
import { pushError } from '../toast'
import { TI } from '../chat/ui'
import { IconMessage, IconPlus, IconSparkles, IconTrash } from '../chat/icons'
import { Switch, NOTIFY_CHOICES, relativeTime } from '../components/JobsView'
import { TotemIcon, TYPE_LABEL, kindOf, statusLine, openTotemChat, runTotemNow, type DraftRecord } from './shared'
import { ringFor, type FigureSpec, type FigureStatus } from './lobbyModel'
import { createLobby, type Lobby, type LobbyItem } from './scene'
import IconLayoutList from '@tabler/icons-react/dist/esm/icons/IconLayoutList.mjs'
import IconChevronLeft from '@tabler/icons-react/dist/esm/icons/IconChevronLeft.mjs'
import IconChevronRight from '@tabler/icons-react/dist/esm/icons/IconChevronRight.mjs'
import './lobby.css'

// The Totems tab on a desktop: every totem standing in a 3D lobby (scene.ts),
// the one in front described in a panel. Hovering a totem previews it; clicking
// brings it forward, and clicking the one in front opens it. Drafts stand as
// holograms and the last slot is an empty plinth for a new one. Phones, and
// anyone who prefers it, get the list (components/TotemsView.tsx).

const NEW_ID = '__new'
const FOCUS_KEY = 'totems.lobby.focus'

type Entry =
  | { kind: 'job'; id: string; name: string; icon: string; job: any; spec: FigureSpec }
  | { kind: 'draft'; id: string; name: string; icon: string; draft: DraftRecord; spec: FigureSpec }
  | { kind: 'new'; id: string; name: string; icon: string; spec: FigureSpec }

function statusOf(job: any): FigureStatus {
  if (job.lastRun?.status === 'running') return 'running'
  if (!job.enabled) return 'off'
  if (job.lastRun?.status === 'error' || job.watch?.error) return 'error'
  return 'on'
}


function modelText(job: any): string {
  if (job.agentless) return 'No AI: plain code'
  if (job.fixedProvider) return 'The default AI'
  const rec = (job.recommendations || []).find((r: any) => r.provider === job.provider && (r.model || '') === (job.model || ''))
  const name = rec?.label || job.model || (job.provider && job.provider !== 'default' ? `${job.provider}, its default model` : 'Default model')
  return job.effort ? `${name} · ${job.effort} effort` : name
}

const notifyText = (id: string) => NOTIFY_CHOICES.find((c) => c.id === id)?.label || id

// The SVG of an icon rendered into the hidden tray, made standalone and white so
// the scene can paint it onto the totem's emblem.
function svgFrom(tray: HTMLElement | null, id: string): string | null {
  const svg = tray?.querySelector(`[data-id="${CSS.escape(id)}"] svg`)
  if (!svg) return null
  const c = svg.cloneNode(true) as SVGElement
  c.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  c.setAttribute('width', '256')
  c.setAttribute('height', '256')
  c.removeAttribute('style')
  c.removeAttribute('class')
  return c.outerHTML.replace(/currentColor/g, '#ffffff')
}


interface Props {
  jobs: any[] | null
  drafts: DraftRecord[]
  onOpen: (id: string) => void
  onBuild: (draft: DraftRecord | null) => void
  onDiscardDraft: (draft: DraftRecord) => void
  onChanged: (job: any) => void
  onOpenChat: () => void
  onList: () => void
  reduced: boolean
}

export default function TotemLobby({ jobs, drafts, onOpen, onBuild, onDiscardDraft, onChanged, onOpenChat, onList, reduced }: Props) {
  const entries = useMemo<Entry[]>(() => {
    // Agent totems first, then built-ins; awake before asleep; then by name.
    const sorted = [...(jobs || [])].sort((a, b) =>
      Number(!!(a.runner || a.skillId)) - Number(!!(b.runner || b.skillId)) || Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
    const list: Entry[] = sorted.map((job) => ({
      kind: 'job', id: job.id, name: job.name, icon: job.iconName, job,
      spec: { id: job.id, kind: job.runner || job.skillId ? 'builtin' : 'agent', type: job.taskType || 'other', status: statusOf(job), watcher: !!job.trigger },
    }))
    for (const d of drafts) {
      list.push({
        kind: 'draft', id: `draft:${d.id}`, name: d.draft?.name || 'Untitled totem', icon: d.draft?.icon || 'sparkles', draft: d,
        spec: { id: `draft:${d.id}`, kind: 'draft', type: d.draft?.taskType || 'other', status: 'on', watcher: !!d.draft?.trigger },
      })
    }
    list.push({ kind: 'new', id: NEW_ID, name: 'New totem', icon: 'plus', spec: { id: NEW_ID, kind: 'new', type: '', status: 'on', watcher: false } })
    return list
  }, [jobs, drafts])

  const [focusId, setFocusId] = useState<string | null>(() => sessionStorage.getItem(FOCUS_KEY))
  const [hoverId, setHoverId] = useState<string | null>(null)
  const focus = entries.find((e) => e.id === focusId) || entries[0]
  const shown = entries.find((e) => e.id === hoverId) || focus

  useEffect(() => { if (focus && focus.id !== focusId) setFocusId(focus.id) }, [focus, focusId])
  useEffect(() => { if (focusId) sessionStorage.setItem(FOCUS_KEY, focusId) }, [focusId])

  const host = useRef<HTMLDivElement>(null)
  const tray = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const roster = useRef<HTMLDivElement>(null)
  const labels = useRef(new Map<string, HTMLElement>())
  const lobby = useRef<Lobby | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()

  const activate = useCallback((e: Entry | undefined) => {
    if (!e) return
    if (e.kind === 'job') onOpen(e.job.id)
    else if (e.kind === 'draft') onBuild(e.draft)
    else onBuild(null)
  }, [onOpen, onBuild])

  const step = useCallback((dir: number) => {
    setHoverId(null)
    setFocusId((cur) => {
      const i = Math.max(0, entries.findIndex((e) => e.id === cur))
      const n = entries.length
      const next = ringFor(n).full ? (i + dir + n) % n : Math.min(n - 1, Math.max(0, i + dir))
      return entries[next]?.id ?? cur
    })
  }, [entries])

  // The scene calls back through refs so it is created once, not per render.
  const latest = useRef({ entries, focusId, activate, step })
  latest.current = { entries, focusId: focus?.id ?? null, activate, step }

  // A layout effect, so the scene exists before the one below hands it figures.
  useLayoutEffect(() => {
    if (!host.current) return
    const l = createLobby(host.current, {
      onHover: (id) => {
        clearTimeout(hoverTimer.current)
        // Linger a moment, so moving from a totem to its panel doesn't lose it.
        if (id) setHoverId(id)
        else hoverTimer.current = setTimeout(() => setHoverId(null), 450)
      },
      onClick: (id) => {
        const { entries: list, focusId: cur, activate: act } = latest.current
        if (id === cur) act(list.find((e) => e.id === id))
        else { setHoverId(null); setFocusId(id) }
      },
      onSettle: (id) => setFocusId(id),
      onStep: (dir) => latest.current.step(dir),
      label: (id) => labels.current.get(id) || null,
    }, { reduced })
    lobby.current = l
    return () => { clearTimeout(hoverTimer.current); l.dispose(); lobby.current = null }
  }, [reduced])

  // Hand the scene its figures once their icons are in the tray.
  useLayoutEffect(() => {
    const items: LobbyItem[] = entries.map((e) => ({ spec: e.spec, sig: JSON.stringify(e.spec), icon: svgFrom(tray.current, e.id) }))
    lobby.current?.setItems(items)
  }, [entries, reduced])

  useEffect(() => { lobby.current?.focus(focus?.id ?? null) }, [focus?.id, reduced])

  // Keep the front totem clear of the panel and roster.
  useEffect(() => {
    const measure = () => lobby.current?.setInsets((panel.current?.offsetWidth || 0) + 32, (roster.current?.offsetHeight || 0) + 24)
    measure()
    const ro = new ResizeObserver(measure)
    if (panel.current) ro.observe(panel.current)
    if (roster.current) ro.observe(roster.current)
    return () => ro.disconnect()
  }, [reduced])

  // Arrows browse, Enter opens: only when nothing that takes typing has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const t = e.target instanceof Element ? e.target : null
      if (t && (t.closest('input, textarea, select, [contenteditable="true"], .xterm') || (t.tagName === 'BUTTON' && e.key === 'Enter'))) return
      if (e.key === 'ArrowRight') { e.preventDefault(); latest.current.step(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); latest.current.step(-1) }
      else if (e.key === 'Enter') {
        const { entries: list, focusId: cur, activate: act } = latest.current
        e.preventDefault(); act(list.find((x) => x.id === cur))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The roster follows the ring.
  useEffect(() => {
    roster.current?.querySelector(`[data-id="${CSS.escape(focus?.id || '')}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduced ? 'auto' : 'smooth' })
  }, [focus?.id, reduced])

  const counts = useMemo(() => {
    const js = jobs || []
    return { on: js.filter((j) => j.enabled).length, paused: js.filter((j) => !j.enabled).length }
  }, [jobs])

  return (
    <div className="tl-root">
      <div className="tl-stage" ref={host} />

      <div className="tl-tags" aria-hidden>
        {entries.map((e) => (
          <div
            key={e.id}
            ref={(el) => { if (el) labels.current.set(e.id, el); else labels.current.delete(e.id) }}
            className={`tl-tag ${e.id === focus?.id ? 'front' : ''} ${e.id === hoverId ? 'hover' : ''} ${e.kind !== 'job' ? 'ghost' : ''} s-${e.spec.status}`}
            style={{ opacity: 0 }}
          >
            {e.kind === 'job' && <i />}{e.name}
          </div>
        ))}
      </div>

      <div className="tl-tray" ref={tray} hidden>
        {entries.map((e) => <span key={e.id} data-id={e.id}>{e.kind === 'new' ? <TI icon={IconPlus} size={24} /> : <TotemIcon name={e.icon} size={24} />}</span>)}
      </div>

      <header className="tl-hud">
        <div>
          <h1>Totems</h1>
          <p className="tm-lede">
            {jobs ? <>{counts.on} on · {counts.paused} paused{drafts.length ? ` · ${drafts.length} draft${drafts.length === 1 ? '' : 's'}` : ''}</> : 'Loading…'}
          </p>
        </div>
        <div className="tm-head-actions">
          <button type="button" className="btn" onClick={onList} title="Show as a list"><TI icon={IconLayoutList} size={15} />List</button>
          <button type="button" className="btn primary" onClick={() => onBuild(null)}><TI icon={IconPlus} size={15} />New totem</button>
        </div>
      </header>

      {shown && (
        <aside ref={panel} className="tl-panel" onPointerEnter={() => clearTimeout(hoverTimer.current)} aria-live="polite">
          <Details key={shown.id} entry={shown} onActivate={() => activate(shown)} onChanged={onChanged} onOpenChat={onOpenChat} onDiscardDraft={onDiscardDraft} />
        </aside>
      )}

      <nav className="tl-roster" ref={roster} aria-label="Totems">
        <button type="button" className="tm-chat-btn" onClick={() => step(-1)} aria-label="Previous totem"><TI icon={IconChevronLeft} size={16} /></button>
        <div className="tl-chips">
          {entries.map((e) => (
            <button
              key={e.id}
              type="button"
              data-id={e.id}
              className={`tl-chip ${e.id === focus?.id ? 'on' : ''} ${e.kind !== 'job' ? 'ghost' : ''} s-${e.spec.status}`}
              onClick={() => { setHoverId(null); if (e.id === focus?.id) activate(e); else setFocusId(e.id) }}
              onPointerEnter={() => { clearTimeout(hoverTimer.current); setHoverId(e.id) }}
              onPointerLeave={() => { hoverTimer.current = setTimeout(() => setHoverId(null), 250) }}
              aria-current={e.id === focus?.id ? 'true' : undefined}
              title={e.id === focus?.id ? `Open ${e.name}` : e.name}
            >
              {e.kind === 'new' ? <TI icon={IconPlus} size={15} /> : <TotemIcon name={e.icon} size={15} />}
              <span>{e.name}</span>
            </button>
          ))}
        </div>
        <button type="button" className="tm-chat-btn" onClick={() => step(1)} aria-label="Next totem"><TI icon={IconChevronRight} size={16} /></button>
      </nav>
      <p className="tl-hint muted">Arrow keys or drag to turn · Enter opens</p>
    </div>
  )
}

function Row({ label, children, bad }: { label: string; children: React.ReactNode; bad?: boolean }) {
  return (
    <div className="tl-row">
      <dt>{label}</dt>
      <dd className={bad ? 'tm-bad' : ''}>{children}</dd>
    </div>
  )
}

function Details({ entry, onActivate, onChanged, onOpenChat, onDiscardDraft }: {
  entry: Entry; onActivate: () => void; onChanged: (job: any) => void; onOpenChat: () => void; onDiscardDraft: (d: DraftRecord) => void
}) {
  const [running, setRunning] = useState(false)

  if (entry.kind === 'new') {
    return (
      <>
        <div className="tm-detail-head">
          <span className="tm-icon lg"><TI icon={IconPlus} size={24} /></span>
          <div className="tm-detail-title"><h2>New totem</h2></div>
        </div>
        <p className="tl-desc">Describe a job, such as watching a listing or writing a weekly review, and the builder sets it up. Nothing is created until you confirm.</p>
        <div className="tm-actions">
          <button type="button" className="btn primary" onClick={onActivate}><TI icon={IconSparkles} size={15} />Build a totem</button>
        </div>
      </>
    )
  }

  if (entry.kind === 'draft') {
    const d = entry.draft
    const asks = !d.pending && d.messages[d.messages.length - 1]?.questions?.length
    return (
      <>
        <div className="tm-detail-head">
          <span className="tm-icon lg"><TotemIcon name={entry.icon} size={24} /></span>
          <div className="tm-detail-title">
            <h2>{entry.name}</h2>
            <span className="muted">Draft{d.draft?.taskType ? ` · ${TYPE_LABEL[d.draft.taskType] || 'Agent'}` : ''} · Edited {relativeTime(d.updatedAt)}</span>
          </div>
        </div>
        <p className="tl-desc">{d.draft?.summary || d.description}</p>
        {(d.pending || asks) ? <span className="tm-kind tl-note">{d.pending ? 'The builder is working on it…' : 'Has questions for you'}</span> : null}
        <div className="tm-actions">
          <button type="button" className="btn primary" onClick={onActivate}>Continue</button>
          <button type="button" className="btn" onClick={() => onDiscardDraft(d)}><TI icon={IconTrash} size={14} />Discard</button>
        </div>
      </>
    )
  }

  const job = entry.job
  const agent = !job.runner && !job.skillId
  const last = job.lastRun
  const desc = job.description || (agent && job.prompt ? job.prompt.split('\n').find((l: string) => l.trim()) : '')
  const toggle = async (v: boolean) => { try { const r: any = await updateJob(job.id, { enabled: v }); onChanged(r.job) } catch (e: any) { pushError(e.message) } }
  const run = async () => { setRunning(true); const fresh = await runTotemNow(job); if (fresh) onChanged(fresh); setRunning(false) }
  return (
    <>
      <div className="tm-detail-head">
        <span className="tm-icon lg"><TotemIcon name={job.iconName} size={24} /></span>
        <div className="tm-detail-title">
          <h2>{job.name}</h2>
          <span className="muted">{kindOf(job)} · {job.scheduleLabel}</span>
        </div>
        <Switch checked={job.enabled} onChange={toggle} label={job.enabled ? 'On' : 'Paused'} />
      </div>
      {desc && <p className="tl-desc">{desc}</p>}
      <div className="tm-actions">
        <button type="button" className="btn primary" onClick={() => openTotemChat(job, onOpenChat)}><TI icon={IconMessage} size={15} />Chat with it</button>
        <button type="button" className="btn" disabled={running || last?.status === 'running'} onClick={run}>{running ? 'Running…' : 'Run now'}</button>
        <button type="button" className="btn" onClick={onActivate}>Open</button>
      </div>
      <dl className="tl-rows">
        <Row label="Status" bad={entry.spec.status === 'error'}>{statusLine(job)}</Row>
        {!job.agentless && <Row label="Model">{modelText(job)}</Row>}
        <Row label="Notify me">{notifyText(job.notify)}</Row>
        {agent && <Row label="Browser">{job.browser ? 'On' : 'Off'}</Row>}
      </dl>
      {last && last.status !== 'running' && (last.preview || last.error) && (
        <div className={`tl-last ${last.status === 'error' ? 'bad' : ''}`}>
          <span className="muted">{last.status === 'error' ? 'Last run failed' : 'Last run'}{last.ts ? ` · ${relativeTime(last.ts)}` : ''}</span>
          <p>{last.status === 'error' ? last.error : last.preview}</p>
        </div>
      )}
    </>
  )
}
