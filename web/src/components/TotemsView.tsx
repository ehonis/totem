import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api, AuthError, getJobs, updateJob, deleteJob, runJobNow } from '../api'
import { pushError, pushToast } from '../toast'
import { Hi } from '../icons'
import { iconFor } from '../studio'
import { THREAD_ICONS } from '../chat/threadIcons.gen'
import { TI } from '../chat/ui'
import { syncThreads, setActive } from '../chat/store'
import { IconArrowLeft, IconMessage, IconPlus, IconSparkles, IconLoader2, IconTrash, IconRefresh } from '../chat/icons'
import { ScheduleBuilder, RunHistory, Switch, NOTIFY_CHOICES, relativeTime } from './JobsView'
import './totems.css'

// Totems: standing agents that wake on a schedule, remember between runs, and
// tell the owner only what matters (totems/core.mjs on the bridge). Every
// scheduled job is one; the builder makes new ones from a description and
// recommends the cheapest model that can do the job.

interface Rec { provider: string; model: string; effort: string; label: string; account: string; driver: string; cost: number; why: string }
interface Draft {
  name: string; summary?: string; icon: string; taskType: string; instructions: string; schedule: any; browser: boolean
  notify: string; recommendations: Rec[]; questions: string[]
}

const COST = { 1: 'Low cost', 2: 'Medium cost', 3: 'High cost' } as Record<number, string>
const TYPE_LABEL: Record<string, string> = {
  watcher: 'Watcher', researcher: 'Researcher', analyst: 'Analyst', writer: 'Writer', organiser: 'Organiser', coach: 'Coach', coder: 'Coder', other: 'Agent',
}
const EXAMPLES = [
  'Watch a sold-out product page and tell me the moment it is back in stock.',
  'Every weekday morning, research AI news and write me a one-page brief.',
  'Every Sunday evening, analyse my Strava week against my goals and tell me what to change.',
]

function TotemIcon({ name, size = 20 }: { name?: string; size?: number }) {
  const tabler = name ? THREAD_ICONS[name] : null
  if (tabler) return <TI icon={tabler} size={size} />
  return <Hi icon={iconFor(name || '', 'sparkles')} size={size} />
}

function CostBadge({ cost }: { cost: number }) {
  return <span className={`tm-cost c${cost}`}>{COST[cost] || 'Cost unknown'}</span>
}

const kindOf = (job: any) => (job.runner ? 'Built-in' : job.skillId ? 'Skill' : TYPE_LABEL[job.taskType] || 'Agent')

function statusLine(job: any) {
  if (job.lastRun?.status === 'running') return 'Running now…'
  if (!job.enabled) return 'Paused'
  const next = job.nextRunAt ? `Next ${relativeTime(job.nextRunAt)}` : 'Not scheduled'
  if (job.lastRun?.status === 'error') return `Last run failed · ${next}`
  return next
}

async function openTotemChat(job: any, onOpenChat: () => void) {
  try {
    const { threadId } = await api<{ threadId: string }>(`/api/totems/${encodeURIComponent(job.id)}/thread`, { method: 'POST' })
    await syncThreads()
    setActive(threadId)
    onOpenChat()
  } catch (e: any) { pushError(`Couldn't open the chat: ${e.message}`) }
}

// --- builder -------------------------------------------------------------------

function Recommendations({ recs, value, onChange }: { recs: Rec[]; value: number; onChange: (i: number) => void }) {
  if (!recs.length) return <p className="muted">No model suggestions; it will use the default account.</p>
  return (
    <div className="tm-recs" role="radiogroup" aria-label="Model">
      {recs.map((r, i) => (
        <label key={`${r.provider}:${r.model}`} className={`tm-rec ${value === i ? 'on' : ''}`}>
          <input type="radio" checked={value === i} onChange={() => onChange(i)} />
          <span className="tm-rec-main">
            <span className="tm-rec-title">{r.label}<span className="tm-rec-acct">{r.account}{r.effort ? ` · ${r.effort} effort` : ''}</span></span>
            {r.why && <span className="tm-rec-why">{r.why}</span>}
          </span>
          <CostBadge cost={r.cost} />
          {i === 0 && <span className="tm-rec-pick">Recommended</span>}
        </label>
      ))}
    </div>
  )
}

function Builder({ onClose, onCreated }: { onClose: () => void; onCreated: (job: any) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'' | 'build' | 'create'>('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [rec, setRec] = useState(0)

  async function build() {
    setBusy('build')
    try {
      const { draft } = await api<{ draft: Draft }>('/api/totems/build', { method: 'POST', body: JSON.stringify({ description: text }) })
      setDraft(draft)
      setRec(0)
    } catch (e: any) { pushError(e.message) } finally { setBusy('') }
  }

  async function create() {
    if (!draft) return
    setBusy('create')
    try {
      const { job } = await api<{ job: any }>('/api/totems', { method: 'POST', body: JSON.stringify({ draft, recommendation: rec }) })
      pushToast(`${job.name} is live. Its first run is starting now.`, 'info')
      onCreated(job)
    } catch (e: any) { pushError(e.message) } finally { setBusy('') }
  }

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d))

  return (
    <div className="tm-page">
      <button type="button" className="tm-back" onClick={onClose}><TI icon={IconArrowLeft} size={16} />Totems</button>
      {!draft ? (
        <div className="tm-build">
          <h1>New totem</h1>
          <p className="tm-lede">Say what it should do and how often, in your own words. The builder designs it, writes its instructions and suggests the cheapest model that can do the job well. Nothing is created until you confirm.</p>
          <textarea
            className="tm-input"
            rows={5}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Be a super analyst: every Friday, go through my calendar and tasks and tell me where my week actually went."
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) build() }}
          />
          <div className="tm-examples">
            {EXAMPLES.map((x) => <button key={x} type="button" className="tm-example" onClick={() => setText(x)}>{x}</button>)}
          </div>
          <div className="tm-actions">
            <button type="button" className="btn primary" disabled={text.trim().length < 8 || !!busy} onClick={build}>
              {busy === 'build' ? <><TI icon={IconLoader2} size={15} className="tm-spin" />Designing…</> : <><TI icon={IconSparkles} size={15} />Build totem</>}
            </button>
            {busy === 'build' && <span className="muted">This takes up to a minute.</span>}
          </div>
        </div>
      ) : (
        <div className="tm-build">
          <div className="tm-draft-head">
            <span className="tm-icon lg"><TotemIcon name={draft.icon} size={24} /></span>
            <input className="tm-name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} aria-label="Name" />
            <span className="tm-kind">{TYPE_LABEL[draft.taskType] || 'Agent'}</span>
          </div>
          <input className="tm-input tm-summary" value={draft.summary || ''} onChange={(e) => patch({ summary: e.target.value })} placeholder="One line: what it does for you" aria-label="Summary" />
          {draft.questions.length > 0 && (
            <div className="tm-questions">
              <strong>The builder wasn’t sure about:</strong>
              <ul>{draft.questions.map((q) => <li key={q}>{q}</li>)}</ul>
              <span className="muted">Answer by editing the instructions below, or tell the totem in its chat later.</span>
            </div>
          )}
          <section className="tm-section">
            <h2>Model</h2>
            <p className="muted">Cheapest first. You can change this any time.</p>
            <Recommendations recs={draft.recommendations} value={rec} onChange={setRec} />
          </section>
          <section className="tm-section">
            <h2>Instructions</h2>
            <textarea className="tm-input" rows={8} value={draft.instructions} onChange={(e) => patch({ instructions: e.target.value })} />
          </section>
          <section className="tm-section">
            <h2>When it runs</h2>
            <ScheduleBuilder value={draft.schedule} onChange={(schedule: any) => patch({ schedule })} />
          </section>
          <section className="tm-section tm-row-fields">
            <label className="field">
              <span>Notify me</span>
              <select value={draft.notify} onChange={(e) => patch({ notify: e.target.value })}>
                {NOTIFY_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
            <div className="field">
              <span>Browser</span>
              <span className="tm-switch-row"><Switch checked={draft.browser} onChange={(v: boolean) => patch({ browser: v })} label="Browser" />Use the browser for pages that need JavaScript</span>
              <span className="muted tm-hint">Off: web search and plain page fetches only.</span>
            </div>
          </section>
          <div className="tm-actions">
            <button type="button" className="btn primary" disabled={!!busy || !draft.name.trim() || !draft.instructions.trim()} onClick={create}>
              {busy === 'create' ? 'Creating…' : 'Create totem'}
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => setDraft(null)}>Back</button>
          </div>
        </div>
      )}
    </div>
  )
}

// --- one totem ---------------------------------------------------------------------

function MemoryTab({ job }: { job: any }) {
  const [value, setValue] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    api<{ memory: string }>(`/api/totems/${encodeURIComponent(job.id)}/memory`).then((r) => { setValue(r.memory); setDraft(r.memory) }).catch((e) => pushError(e.message))
  }, [job.id])
  if (value === null) return <p className="muted">Loading memory…</p>
  async function save() {
    setSaving(true)
    try { const r = await api<{ memory: string }>(`/api/totems/${encodeURIComponent(job.id)}/memory`, { method: 'PUT', body: JSON.stringify({ memory: draft }) }); setValue(r.memory); pushToast('Saved', 'info') }
    catch (e: any) { pushError(e.message) } finally { setSaving(false) }
  }
  return (
    <div>
      <p className="muted">What {job.name} remembers between runs. It keeps this up to date itself; edit anything that’s wrong.</p>
      <textarea className="tm-input mono" rows={16} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Empty until its first run." />
      <div className="tm-actions">
        <button type="button" className="btn primary" disabled={saving || draft === value} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        {draft !== value && <button type="button" className="btn" onClick={() => setDraft(value)}>Discard</button>}
      </div>
    </div>
  )
}

function SettingsTab({ job, onChanged, onDeleted }: { job: any; onChanged: (job: any) => void; onDeleted: () => void }) {
  const agent = !job.runner && !job.skillId
  const [instructions, setInstructions] = useState(job.prompt || '')
  const [recommending, setRecommending] = useState(false)
  useEffect(() => setInstructions(job.prompt || ''), [job.id, job.prompt])
  const save = async (patch: any) => {
    try { const r: any = await updateJob(job.id, patch); onChanged(r.job) } catch (e: any) { pushError(e.message) }
  }
  const recs: Rec[] = job.recommendations || []
  const current = recs.findIndex((r) => r.provider === job.provider && (r.model || null) === (job.model || null))
  async function recommend() {
    setRecommending(true)
    try { const r = await api<{ job: any }>(`/api/totems/${encodeURIComponent(job.id)}/recommend`, { method: 'POST' }); onChanged(r.job) }
    catch (e: any) { pushError(e.message) } finally { setRecommending(false) }
  }
  async function remove() {
    if (!window.confirm(`Delete ${job.name}? Its memory and chat are deleted too.${job.kind === 'seeded' ? ' It shipped with Totem; you can restore it from Settings → Jobs.' : ''}`)) return
    try { await deleteJob(job.id); pushToast(`Deleted ${job.name}`, 'info'); onDeleted() } catch (e: any) { pushError(e.message) }
  }
  return (
    <div className="tm-settings">
      {agent ? (
        <section className="tm-section">
          <h2>Instructions</h2>
          <textarea className="tm-input" rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          {instructions !== (job.prompt || '') && (
            <div className="tm-actions"><button type="button" className="btn primary" onClick={() => save({ prompt: instructions })}>Save instructions</button></div>
          )}
        </section>
      ) : (
        <section className="tm-section">
          <h2>What it runs</h2>
          <p className="muted">{job.runner ? `Built-in code: ${job.runner}.` : `The “${job.skillId}” skill.`} Edit the prompt in Settings → Skills.</p>
        </section>
      )}
      <section className="tm-section">
        <h2>When it runs</h2>
        <ScheduleBuilder value={job.schedule} onChange={(schedule: any) => save({ schedule })} />
      </section>
      {!job.agentless && !job.fixedProvider && (
        <section className="tm-section">
          <h2>Model</h2>
          {recs.length > 0 && <Recommendations recs={recs} value={current} onChange={(i) => save({ provider: recs[i].provider, model: recs[i].model || null, effort: recs[i].effort || null })} />}
          {current < 0 && <p className="muted">Now: {job.provider === 'default' ? 'the default account' : job.provider}{job.model ? ` · ${job.model}` : ''}.</p>}
          <div className="tm-actions">
            <button type="button" className="btn compact" disabled={recommending} onClick={recommend}>
              {recommending ? <><TI icon={IconLoader2} size={14} className="tm-spin" />Asking…</> : <><TI icon={IconRefresh} size={14} />{recs.length ? 'Recommend again' : 'Recommend models'}</>}
            </button>
          </div>
        </section>
      )}
      <section className="tm-section tm-row-fields">
        <label className="field">
          <span>Notify me</span>
          <select value={job.notify} onChange={(e) => save({ notify: e.target.value })}>
            {NOTIFY_CHOICES.filter((c) => agent || c.id !== 'agent').map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        {agent && (
          <div className="field">
            <span>Browser</span>
            <span className="tm-switch-row"><Switch checked={!!job.browser} onChange={(v: boolean) => save({ browser: v })} label="Browser" />Use the browser for pages that need JavaScript</span>
          </div>
        )}
      </section>
      <section className="tm-section">
        <button type="button" className="btn danger compact" onClick={remove}><TI icon={IconTrash} size={14} />Delete totem</button>
      </section>
    </div>
  )
}

function Detail({ job, onBack, onChanged, onDeleted, onOpenChat }: { job: any; onBack: () => void; onChanged: (job: any) => void; onDeleted: () => void; onOpenChat: () => void }) {
  const [tab, setTab] = useState<'settings' | 'memory' | 'runs'>('settings')
  const [running, setRunning] = useState(false)
  async function run() {
    setRunning(true)
    try {
      const r: any = await runJobNow(job.id)
      const fresh = (r.jobs || []).find((j: any) => j.id === job.id)
      if (fresh) onChanged(fresh)
      const status = r.run?.status
      pushToast(status === 'error' ? `${job.name} failed: ${r.run?.error || 'no error text'}` : status === 'skipped' ? `${job.name} checked: nothing new` : `${job.name} ran. Its report is in its chat.`, status === 'error' ? 'error' : 'info')
    }
    catch (e: any) { pushError(e.message) } finally { setRunning(false) }
  }
  return (
    <div className="tm-page">
      <button type="button" className="tm-back" onClick={onBack}><TI icon={IconArrowLeft} size={16} />Totems</button>
      <div className="tm-detail-head">
        <span className="tm-icon lg"><TotemIcon name={job.iconName} size={24} /></span>
        <div className="tm-detail-title">
          <h1>{job.name}</h1>
          <span className="muted">{kindOf(job)} · {job.scheduleLabel} · {statusLine(job)}</span>
        </div>
        <Switch checked={job.enabled} onChange={async (v: boolean) => { try { const r: any = await updateJob(job.id, { enabled: v }); onChanged(r.job) } catch (e: any) { pushError(e.message) } }} label={job.enabled ? 'On' : 'Paused'} />
      </div>
      <div className="tm-actions">
        <button type="button" className="btn primary" onClick={() => openTotemChat(job, onOpenChat)}><TI icon={IconMessage} size={15} />Chat with it</button>
        <button type="button" className="btn" disabled={running || job.lastRun?.status === 'running'} onClick={run}>{running ? 'Running…' : 'Run now'}</button>
      </div>
      <div className="tm-tabs" role="tablist">
        {(['settings', 'memory', 'runs'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'settings' ? 'Settings' : t === 'memory' ? 'Memory' : 'Runs'}
          </button>
        ))}
      </div>
      {tab === 'settings' && <SettingsTab job={job} onChanged={onChanged} onDeleted={onDeleted} />}
      {tab === 'memory' && <MemoryTab job={job} />}
      {tab === 'runs' && <RunHistory jobId={job.id} />}
    </div>
  )
}

// --- the list ---------------------------------------------------------------------

export default function TotemsView({ onAuthError, onOpenChat }: { onAuthError: () => void; onOpenChat: () => void }) {
  const [jobs, setJobs] = useState<any[] | null>(null)
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get('totem'))
  const [building, setBuilding] = useState(false)

  const load = useCallback(() => {
    getJobs().then((p: any) => setJobs(p.jobs || [])).catch((e) => { if (e instanceof AuthError) onAuthError(); else pushError(e.message) })
  }, [onAuthError])
  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const replace = (job: any) => setJobs((list) => (list || []).map((j) => (j.id === job.id ? job : j)))
  // Agent totems first, then built-ins; on before paused; then by name.
  const sorted = useMemo(() => [...(jobs || [])].sort((a, b) =>
    Number(!!(a.runner || a.skillId)) - Number(!!(b.runner || b.skillId)) || Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)), [jobs])
  const job = open ? jobs?.find((j) => j.id === open) : null

  if (building) return <div className="view tm-view"><Builder onClose={() => setBuilding(false)} onCreated={(j) => { setBuilding(false); setJobs((l) => [...(l || []), j]); setOpen(j.id) }} /></div>
  if (job) return <div className="view tm-view"><Detail job={job} onBack={() => setOpen(null)} onChanged={replace} onDeleted={() => { setOpen(null); load() }} onOpenChat={onOpenChat} /></div>

  return (
    <div className="view tm-view">
      <div className="tm-page">
        <div className="tm-head">
          <div>
            <h1>Totems</h1>
            <p className="tm-lede">Standing agents that work on their own schedule, remember what they’ve seen, and only tell you what matters.</p>
          </div>
          <button type="button" className="btn primary" onClick={() => setBuilding(true)}><TI icon={IconPlus} size={15} />New totem</button>
        </div>
        {!jobs && <p className="muted">Loading…</p>}
        {jobs && !jobs.length && (
          <button type="button" className="tm-empty" onClick={() => setBuilding(true)}>
            <TI icon={IconSparkles} size={22} />
            <strong>Make your first totem</strong>
            <span>Describe a job, such as watching a listing or writing a weekly review, and the builder sets it up.</span>
          </button>
        )}
        <div className="tm-grid">
          {sorted.map((j) => (
            <div key={j.id} className={`tm-card ${j.enabled ? '' : 'off'} ${j.lastRun?.status === 'error' ? 'bad' : ''}`}>
              <button type="button" className="tm-card-main" onClick={() => setOpen(j.id)}>
                <span className="tm-icon"><TotemIcon name={j.iconName} /></span>
                <span className="tm-card-text">
                  <span className="tm-card-name">{j.name}</span>
                  <span className="tm-card-desc">{j.description || j.scheduleLabel}</span>
                  <span className="tm-card-meta">
                    <span className="tm-kind">{kindOf(j)}</span>
                    {j.scheduleLabel}
                    <span className="tm-dot">·</span>
                    <span className={j.lastRun?.status === 'error' ? 'tm-bad' : ''}>{statusLine(j)}</span>
                  </span>
                </span>
              </button>
              <div className="tm-card-side">
                <Switch checked={j.enabled} onChange={async (v: boolean) => { try { const r: any = await updateJob(j.id, { enabled: v }); replace(r.job) } catch (e: any) { pushError(e.message) } }} label={`${j.name} on`} />
                <button type="button" className="tm-chat-btn" onClick={() => openTotemChat(j, onOpenChat)} aria-label={`Chat with ${j.name}`} title="Chat with it"><TI icon={IconMessage} size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
