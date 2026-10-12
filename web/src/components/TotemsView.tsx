import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, AuthError, getJobs, updateJob, deleteJob, getSkills, updateSkill, resetSkill, previewSkill } from '../api'
import { pushError, pushToast } from '../toast'
import { TI } from '../chat/ui'
import { useChat, loadProviders, ensureModels, syncThreads, setActive, adoptThread, threadTitle } from '../chat/store'
import { ago } from '../chat/settle'
import Spark from '../chat/Spark'
import type { ChatThread } from '../chat/types'
import { normalizeModelSettings, modelLabel } from '../chat/models'
import ModelPicker from '../chat/ModelPicker'
import { IconArrowLeft, IconArrowUp, IconMessage, IconPlus, IconSparkles, IconLoader2, IconTrash, IconRefresh, IconSettings, IconUsersGroup } from '../chat/icons'
import { ScheduleBuilder, RunHistory, Switch, NOTIFY_CHOICES, relativeTime } from './JobsView'
import { TotemIcon, TYPE_LABEL, kindOf, statusLine, openTotemChat, runTotemNow, asWatch, sourceKey, type Rec, type Watch, type WatchSource, type Draft, type Choice, type Msg, type DraftRecord } from '../totems/shared'
import './totems.css'

// Totems: standing agents that wake on a schedule or when something they watch
// changes, remember between runs, and tell the owner only what matters
// (totems/core.mjs and jobs/triggers.mjs on the bridge). Every scheduled job is
// one; the builder makes new ones from a description and recommends the
// cheapest model that can do the job, and any model can be picked instead.

const COST = { 1: 'Low cost', 2: 'Medium cost', 3: 'High cost' } as Record<number, string>
const EXAMPLES = [
  'Watch a sold-out product page and tell me the moment it is back in stock.',
  'Every weekday morning, research AI news and write me a one-page brief.',
  'Every Sunday evening, analyse my Strava week against my goals and tell me what to change.',
]

function CostBadge({ cost }: { cost: number }) {
  return <span className={`tm-cost c${cost}`}>{COST[cost] || 'Cost unknown'}</span>
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

// Any model on any account, through the same picker chats use.
function ModelChoice({ value, onChange }: { value: Choice; onChange: (c: Choice) => void }) {
  const providers = useChat((s) => s.providers)
  const defaultProvider = useChat((s) => s.defaultProvider)
  useEffect(() => { if (!providers.length) loadProviders() }, [providers.length])
  const provider = !value.provider || value.provider === 'default' ? defaultProvider : value.provider
  useEffect(() => { if (provider) ensureModels(provider) }, [provider, providers.length])
  const settings = { ...normalizeModelSettings(), modelId: value.model || '' }
  return (
    <span className="tm-model-pick">
      <ModelPicker provider={provider} settings={settings} onChange={({ provider: p, modelSettings }) => onChange({ provider: p, model: modelSettings.modelId || '', effort: value.effort })} />
      <label className="tm-effort">
        <span>Effort</span>
        <select value={value.effort || ''} onChange={(e) => onChange({ ...value, effort: e.target.value })} aria-label="Effort">
          <option value="">Default</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
    </span>
  )
}

// The builder's picks, cheapest first, then any model at all.
function ModelSection({ recs, value, onChange }: { recs: Rec[]; value: Choice; onChange: (c: Choice) => void }) {
  const picked = recs.findIndex((r) => r.provider === value.provider && (r.model || '') === (value.model || ''))
  return (
    <>
      {recs.length > 0 && (
        <Recommendations recs={recs} value={picked} onChange={(i) => onChange({ provider: recs[i].provider, model: recs[i].model || '', effort: recs[i].effort || '' })} />
      )}
      <div className={`tm-rec tm-rec-own ${picked < 0 ? 'on' : ''}`}>
        <span className="tm-rec-main">
          <span className="tm-rec-title">{recs.length ? 'Or choose any model' : 'Model'}</span>
          <span className="tm-rec-why">{!recs.length ? 'Any model on any account, the same list chats use.' : picked < 0 ? 'Your pick. It runs on this instead of the suggestions.' : 'Pick from every account, the same list chats use.'}</span>
        </span>
        <ModelChoice value={value} onChange={onChange} />
      </div>
    </>
  )
}

const NEW_GIT: WatchSource = { kind: 'git', repo: '', ref: 'main' }
const NEW_WATCH: Watch = { type: 'watch', everyMinutes: 5, sources: [NEW_GIT] }

function SourceFields({ source: s, onChange }: { source: WatchSource; onChange: (s: WatchSource) => void }) {
  return (
    <>
      <div className="sched-tabs" role="tablist" aria-label="What it watches">
        <button type="button" role="tab" aria-selected={s.kind === 'git'} className={`sched-tab ${s.kind === 'git' ? 'active' : ''}`}
          onClick={() => s.kind !== 'git' && onChange(NEW_GIT)}>A git branch</button>
        <button type="button" role="tab" aria-selected={s.kind === 'url'} className={`sched-tab ${s.kind === 'url' ? 'active' : ''}`}
          onClick={() => s.kind !== 'url' && onChange({ kind: 'url', url: '', contains: '' })}>A web page</button>
      </div>
      {s.kind === 'git' ? (
        <div className="tm-watch-fields">
          <label className="field tm-grow">
            <span>Repository</span>
            <input className="tm-input" value={s.repo} onChange={(e) => onChange({ ...s, repo: e.target.value })} placeholder="/home/you/projects/app, or https://github.com/owner/repo" spellCheck={false} />
          </label>
          <label className="field tm-ref">
            <span>Branch</span>
            <input className="tm-input" value={s.ref} onChange={(e) => onChange({ ...s, ref: e.target.value })} spellCheck={false} />
          </label>
        </div>
      ) : (
        <div className="tm-watch-fields">
          <label className="field tm-full">
            <span>Page</span>
            <input className="tm-input" value={s.url} onChange={(e) => onChange({ ...s, url: e.target.value })} placeholder="https://…" spellCheck={false} />
          </label>
          <label className="field tm-full">
            <span>Only when it shows this text <span className="muted">(optional)</span></span>
            <input className="tm-input" value={s.contains || ''} onChange={(e) => onChange({ ...s, contains: e.target.value })} placeholder="e.g. In stock" />
          </label>
        </div>
      )}
    </>
  )
}

const MAX_SOURCES = 20

/** `seen` is the job's saved baseline per source, shown under each one it still watches. */
function WatchEditor({ value, onChange, seen }: { value: Watch; onChange: (w: Watch) => void; seen?: Record<string, { label: string }> }) {
  const sources = value.sources
  const min = sources.some((s) => s.kind === 'url') ? 5 : 1
  const setSources = (next: WatchSource[]) => {
    const pageMin = next.some((s) => s.kind === 'url') && !sources.some((s) => s.kind === 'url')
    onChange({ ...value, sources: next, everyMinutes: pageMin ? Math.max(value.everyMinutes, 15) : value.everyMinutes })
  }
  return (
    <div className="tm-watch">
      {sources.map((s, i) => (
        <div className="tm-watch-source" key={i}>
          <SourceFields source={s} onChange={(n) => setSources(sources.map((x, j) => (j === i ? n : x)))} />
          {(seen?.[sourceKey(s)] || sources.length > 1) && (
            <div className="tm-watch-foot">
              <span className="muted tm-hint">{seen?.[sourceKey(s)] ? `Last seen: ${seen[sourceKey(s)].label}` : ''}</span>
              {sources.length > 1 && (
                <button type="button" className="btn ghost tm-watch-remove" onClick={() => setSources(sources.filter((_, j) => j !== i))}>
                  <TI icon={IconTrash} size={14} /> Remove
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {sources.length < MAX_SOURCES && (
        <div><button type="button" className="btn" onClick={() => setSources([...sources, NEW_GIT])}><TI icon={IconPlus} size={14} /> Watch another</button></div>
      )}
      {sources.some((s) => s.kind === 'git') && <span className="muted tm-hint">A checkout on this machine is watched through its origin remote, so it wakes on what was merged upstream, not on local commits.</span>}
      {sources.some((s) => s.kind === 'url') && <span className="muted tm-hint">With text, a page wakes it when that text appears or disappears. Without, any change to the page’s text counts, so pick a page that doesn’t change on every load.</span>}
      <label className="sched-time">
        <span>Check every</span>
        <input type="number" min={min} max={1440} value={value.everyMinutes} onChange={(e) => onChange({ ...value, everyMinutes: Math.max(min, Math.min(1440, Number(e.target.value) || min)) })} aria-label="Minutes between checks" />
        <span>minutes</span>
      </label>
      <p className="muted tm-hint">Checks use no AI. The first one only notes how things look now; the totem runs each time {sources.length > 1 ? 'any of them changes, told which ones did' : 'that changes'}.</p>
    </div>
  )
}

const sourceReady = (s: WatchSource) => (s.kind === 'git' ? !!s.repo.trim() && !!s.ref.trim() : /^https?:\/\/\S+/.test(s.url.trim()))
const watchReady = (w: Watch | null) => !w || (w.sources.length > 0 && w.sources.every(sourceReady))

function WhenItRuns({ schedule, trigger, seen, onSchedule, onTrigger }: { schedule: any; trigger: Watch | null; seen?: Record<string, { label: string }>; onSchedule: (s: any) => void; onTrigger: (t: Watch | null) => void }) {
  return (
    <>
      <div className="sched-tabs tm-mode" role="tablist" aria-label="What wakes it">
        <button type="button" role="tab" aria-selected={!trigger} className={`sched-tab ${!trigger ? 'active' : ''}`} onClick={() => trigger && onTrigger(null)}>On a schedule</button>
        <button type="button" role="tab" aria-selected={!!trigger} className={`sched-tab ${trigger ? 'active' : ''}`} onClick={() => !trigger && onTrigger(NEW_WATCH)}>When something changes</button>
      </div>
      {trigger ? <WatchEditor value={trigger} onChange={onTrigger} seen={seen} /> : <ScheduleBuilder value={schedule} onChange={onSchedule} />}
    </>
  )
}

// Not crypto.randomUUID: that needs a secure context, and the dashboard may be on plain http.
const newDraftId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
const DEFAULT_CHOICE: Choice = { provider: 'default', model: '', effort: '' }
const topChoice = (d: Draft | null): Choice => {
  const top = d?.recommendations[0]
  return top ? { provider: top.provider, model: top.model || '', effort: top.effort || '' } : DEFAULT_CHOICE
}
const sameChoice = (a: Choice, b: Choice) => a.provider === b.provider && (a.model || '') === (b.model || '') && (a.effort || '') === (b.effort || '')

// The conversation beside the draft: the builder's questions, his answers, and
// any change he asks for. Each message is one builder turn that rewrites the draft.
function BuilderChat({ messages, pending, onSend }: { messages: Msg[]; pending: string | null; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }) }, [messages.length, pending])
  const lastOwner = [...messages].reverse().find((m) => m.role === 'owner')
  const failed = messages[messages.length - 1]?.error
  const send = () => { const t = text.trim(); if (!t || pending) return; onSend(t); setText('') }
  return (
    <aside className="tm-chat" aria-label="Builder conversation">
      <div className="tm-chat-head">
        <strong>Builder</strong>
        <span className="muted">Answer its questions or ask for changes. It rewrites the draft; your own edits are kept.</span>
      </div>
      <div className="tm-chat-log">
        {messages.map((m, i) => (
          <div key={`${m.at}-${i}`} className={`tm-msg ${m.role}${m.error ? ' error' : ''}`}>
            <p>{m.text}</p>
            {m.questions && m.questions.length > 0 && <ol>{m.questions.map((q) => <li key={q}>{q}</li>)}</ol>}
          </div>
        ))}
        {pending && <div className="tm-msg builder busy"><TI icon={IconLoader2} size={14} className="tm-spin" />Revising the draft…</div>}
        {failed && !pending && lastOwner && (
          <button type="button" className="btn compact tm-retry" onClick={() => onSend(lastOwner.text)}><TI icon={IconRefresh} size={14} />Try again</button>
        )}
        <div ref={end} />
      </div>
      <div className="tm-chat-compose">
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
          placeholder={messages.some((m) => m.questions?.length) ? 'Answer, or ask for a change…' : 'Ask for a change…'}
          aria-label="Message the builder"
        />
        <button type="button" className="tm-chat-send" disabled={!text.trim() || !!pending} onClick={send} aria-label="Send"><TI icon={IconArrowUp} size={16} /></button>
      </div>
    </aside>
  )
}

function Builder({ initial, onClose, onCreated, onDiscarded }: { initial: DraftRecord | null; onClose: () => void; onCreated: (job: any) => void; onDiscarded: () => void }) {
  const id = useMemo(() => initial?.id || newDraftId(), [initial?.id])
  const [text, setText] = useState(initial?.description || '')
  const [busy, setBusy] = useState<'' | 'build' | 'create'>('')
  const [draft, setDraft] = useState<Draft | null>(initial?.draft || null)
  const [choice, setChoice] = useState<Choice>(initial?.choice || topChoice(initial?.draft || null))
  const [messages, setMessages] = useState<Msg[]>(initial?.messages || [])
  // A turn in flight, here or one still running from an earlier visit.
  const [pending, setPending] = useState<string | null>(initial?.pending?.text || null)
  const models = useChat((s) => s.models)

  const adopt = (rec: { draft: Draft | null; messages: Msg[] }, prev: Draft | null) => {
    if (rec.draft) {
      setDraft(rec.draft)
      // Follow the new top suggestion unless he picked a model himself.
      setChoice((c) => (!prev || sameChoice(c, topChoice(prev)) ? topChoice(rec.draft) : c))
    }
    setMessages(rec.messages)
  }

  // The bridge finishes a turn even if the page was closed; pick it up here.
  useEffect(() => {
    if (!initial?.pending) return
    let alive = true
    const poll = setInterval(async () => {
      try {
        const { draft: rec } = await api<{ draft: DraftRecord }>(`/api/totems/drafts/${id}`)
        if (!alive || rec.pending) return
        clearInterval(poll)
        adopt(rec, initial.draft)
        setPending(null)
      } catch { /* keep waiting; a 404 means it was discarded elsewhere */ }
    }, 3000)
    return () => { alive = false; clearInterval(poll) }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave his edits and model pick, so an unfinished totem is a draft, not lost.
  const saved = useRef(JSON.stringify([initial?.description || '', initial?.draft || null, initial?.choice || null]))
  const latest = useRef<() => void>(() => {})
  latest.current = () => {
    if (!draft || pending || busy) return
    const snap = JSON.stringify([text, draft, choice])
    if (snap === saved.current) return
    saved.current = snap
    api(`/api/totems/drafts/${id}`, { method: 'PUT', body: JSON.stringify({ description: text, draft, choice }) }).catch(() => { saved.current = '' })
  }
  useEffect(() => {
    const t = setTimeout(() => latest.current(), 700)
    return () => clearTimeout(t)
  }, [text, draft, choice, pending, busy])
  useEffect(() => () => latest.current(), [])

  async function turn(message: string | null) {
    const prev = draft
    const body = message ? { draftId: id, description: text, draft, choice, message } : { draftId: id, description: text }
    if (message) {
      setPending(message)
      // Shown at once; the bridge's copy replaces it when the turn ends.
      setMessages((m) => [...m, { role: 'owner', text: message, at: Date.now() }])
    } else setBusy('build')
    try {
      const r = await api<{ draft: Draft; messages: Msg[] }>('/api/totems/build', { method: 'POST', body: JSON.stringify(body) })
      adopt(r, prev)
      saved.current = JSON.stringify([text, r.draft, null])
    } catch (e: any) {
      // A failed turn is kept in the draft with his message, so retry is one tap.
      const rec = await api<{ draft: DraftRecord }>(`/api/totems/drafts/${id}`).then((x) => x.draft).catch(() => null)
      if (rec) setMessages(rec.messages)
      if (!rec || !message) pushError(e.message)
    } finally { setBusy(''); setPending(null) }
  }

  async function create() {
    if (!draft) return
    setBusy('create')
    try {
      const label = choice.model ? modelLabel(models[choice.provider], choice.model) : ''
      const { job } = await api<{ job: any }>('/api/totems', { method: 'POST', body: JSON.stringify({ draft, choice: { ...choice, label }, draftId: id }) })
      saved.current = JSON.stringify([text, draft, choice])
      pushToast(job.trigger ? `${job.name} is watching. It runs the first time that changes.` : `${job.name} is live. Its first run is starting now.`, 'info')
      onCreated(job)
    } catch (e: any) { pushError(e.message) } finally { setBusy('') }
  }

  async function discard() {
    if (!window.confirm(`Discard this draft${draft?.name ? ` (${draft.name})` : ''}?`)) return
    saved.current = JSON.stringify([text, draft, choice])
    setDraft(null)
    try { await api(`/api/totems/drafts/${id}`, { method: 'DELETE' }) } catch (e: any) { pushError(e.message) }
    onDiscarded()
  }

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d))
  const locked = !!busy || !!pending

  if (!draft) {
    const designing = busy === 'build' || !!pending
    return (
      <div className="tm-page">
        <button type="button" className="tm-back" onClick={onClose}><TI icon={IconArrowLeft} size={16} />Totems</button>
        <div className="tm-build">
          <h1>New totem</h1>
          <p className="tm-lede">Say what it should do and how often, in your own words. The builder designs it, asks about anything it needs to know, and suggests the cheapest model that can do the job well. Nothing is created until you confirm, and an unfinished one is kept as a draft.</p>
          <textarea
            className="tm-input"
            rows={5}
            autoFocus
            value={text}
            readOnly={designing}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Be a super analyst: every Friday, go through my calendar and tasks and tell me where my week actually went."
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim().length >= 8 && !designing) turn(null) }}
          />
          <div className="tm-examples">
            {EXAMPLES.map((x) => <button key={x} type="button" className="tm-example" disabled={designing} onClick={() => setText(x)}>{x}</button>)}
          </div>
          <div className="tm-actions">
            <button type="button" className="btn primary" disabled={text.trim().length < 8 || designing} onClick={() => turn(null)}>
              {designing ? <><TI icon={IconLoader2} size={15} className="tm-spin" />Designing…</> : <><TI icon={IconSparkles} size={15} />Build totem</>}
            </button>
            {designing && <span className="muted">This takes up to a minute. You can leave; it’s saved as a draft.</span>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="tm-page wide">
      <button type="button" className="tm-back" onClick={onClose}><TI icon={IconArrowLeft} size={16} />Totems</button>
      <div className="tm-builder">
        <BuilderChat messages={messages} pending={pending} onSend={(m) => turn(m)} />
        <fieldset className="tm-build tm-draft" disabled={locked}>
          <div className="tm-draft-head">
            <span className="tm-icon lg"><TotemIcon name={draft.icon} size={24} /></span>
            <input className="tm-name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} aria-label="Name" />
            <span className="tm-kind">{TYPE_LABEL[draft.taskType] || 'Agent'}</span>
          </div>
          <input className="tm-input tm-summary" value={draft.summary || ''} onChange={(e) => patch({ summary: e.target.value })} placeholder="One line: what it does for you" aria-label="Summary" />
          <section className="tm-section">
            <h2>Model</h2>
            <p className="muted">Suggestions are cheapest first. You can change this any time.</p>
            <ModelSection recs={draft.recommendations} value={choice} onChange={setChoice} />
          </section>
          <section className="tm-section">
            <h2>Instructions</h2>
            <textarea className="tm-input" rows={10} value={draft.instructions} onChange={(e) => patch({ instructions: e.target.value })} />
          </section>
          <section className="tm-section">
            <h2>When it runs</h2>
            <WhenItRuns schedule={draft.schedule} trigger={asWatch(draft.trigger)} onSchedule={(schedule) => patch({ schedule })} onTrigger={(trigger) => patch({ trigger })} />
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
            <button type="button" className="btn primary" disabled={locked || !draft.name.trim() || !draft.instructions.trim() || !watchReady(asWatch(draft.trigger))} onClick={create}>
              {busy === 'create' ? 'Creating…' : 'Create totem'}
            </button>
            <button type="button" className="btn" disabled={locked} onClick={discard}>Discard draft</button>
            <span className="muted tm-hint">{pending ? 'The builder is revising; editing is paused.' : 'Saved as a draft as you go.'}</span>
          </div>
        </fieldset>
      </div>
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

const andList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '')

// A built-in or skill totem runs a skill (skills/, data/skills/<id>/SKILL.md).
// Its instructions are edited here, in the totem, with the same save, reset and
// preview the skill store offers; nothing sends him elsewhere to change them.
function SkillInstructions({ job }: { job: any }) {
  const [skill, setSkill] = useState<any | null | undefined>(undefined)
  const [allVars, setAllVars] = useState<string[]>([])
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<any>(null)
  const adopt = (payload: any) => {
    const s = (payload.skills || []).find((x: any) => x.id === job.skillId) || null
    setSkill(s)
    setAllVars(payload.variables || [])
    setBody(s?.body || '')
    setPreview(null)
  }
  useEffect(() => { getSkills().then(adopt).catch((e: any) => { setSkill(null); pushError(e.message) }) }, [job.skillId]) // eslint-disable-line react-hooks/exhaustive-deps
  if (skill === undefined) return <section className="tm-section"><h2>Instructions</h2><p className="muted">Loading…</p></section>
  if (skill === null) {
    return (
      <section className="tm-section">
        <h2>Instructions</h2>
        <p className="muted">Its instructions (“{job.skillId}”) are missing, so a run has nothing to follow.</p>
      </section>
    )
  }
  const allowed: string[] = skill.knownVariables?.length ? skill.knownVariables : allVars
  const used = [...new Set([...String(body).matchAll(/\{\{\s*[#^/]?([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))]
  const unknown = used.filter((v) => !allowed.includes(v))
  const others = (skill.usedBy || []).filter((j: any) => j.id !== job.id)
  const dirty = body !== skill.body
  async function act(fn: () => Promise<any>, message: string) {
    setBusy(true)
    try { adopt(await fn()); pushToast(message, 'info') } catch (e: any) { pushError(e.message) } finally { setBusy(false) }
  }
  return (
    <section className="tm-section">
      <h2>Instructions</h2>
      <p className="muted">
        What {job.name} tells the AI each run.
        {others.length > 0 && ` ${andList(others.map((j: any) => j.name))} ${others.length === 1 ? 'follows' : 'follow'} the same instructions, so a change here changes ${others.length === 1 ? 'it' : 'them'} too.`}
      </p>
      <textarea className="tm-input mono" rows={16} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
      {allowed.length > 0 && (
        <div className="tm-vars">
          <span className="muted tm-hint">Values filled in at run time:</span>
          {allowed.map((v) => (
            <button key={v} type="button" className={`tm-var ${used.includes(v) ? 'used' : ''}`} onClick={() => setBody((b) => `${b}${b.endsWith('\n') || !b ? '' : ' '}{{${v}}}`)}>{`{{${v}}}`}</button>
          ))}
        </div>
      )}
      {unknown.length > 0 && <p className="tm-bad tm-hint">{unknown.map((v) => `{{${v}}}`).join(', ')} {unknown.length === 1 ? 'is not a value' : 'are not values'} Totem can fill, so {unknown.length === 1 ? 'it' : 'they'} will come out blank. Check the spelling.</p>}
      {preview && <pre className="tm-input mono tm-preview">{preview.text}</pre>}
      <div className="tm-actions">
        <button type="button" className="btn primary" disabled={busy || !dirty || !body.trim()} onClick={() => act(() => updateSkill(skill.id, { body }), 'Saved the instructions')}>Save instructions</button>
        {dirty && <button type="button" className="btn" disabled={busy} onClick={() => setBody(skill.body)}>Discard</button>}
        <button type="button" className="btn ghost" disabled={busy} onClick={async () => { setBusy(true); try { setPreview(preview ? null : await previewSkill(skill.id, body)) } catch (e: any) { pushError(e.message) } finally { setBusy(false) } }}>
          {preview ? 'Hide preview' : 'Preview what it receives'}
        </button>
        {skill.kind === 'seeded' && skill.modified && (
          <button type="button" className="btn ghost" disabled={busy} onClick={() => { if (window.confirm('Put back the instructions that ship with Totem? Your changes are discarded.')) act(() => resetSkill(skill.id), 'Restored the original instructions') }}>Reset to original</button>
        )}
      </div>
    </section>
  )
}

function SettingsTab({ job, onChanged, onDeleted }: { job: any; onChanged: (job: any) => void; onDeleted: () => void }) {
  const agent = !job.runner && !job.skillId
  const [instructions, setInstructions] = useState(job.prompt || '')
  const [recommending, setRecommending] = useState(false)
  // A watch is saved with a button, not per keystroke: half a path is not a watch.
  const [trigger, setTrigger] = useState<Watch | null>(job.trigger || null)
  useEffect(() => setInstructions(job.prompt || ''), [job.id, job.prompt])
  useEffect(() => setTrigger(job.trigger || null), [job.id, JSON.stringify(job.trigger)]) // eslint-disable-line react-hooks/exhaustive-deps
  const triggerDirty = JSON.stringify(trigger) !== JSON.stringify(job.trigger || null)
  const save = async (patch: any) => {
    try { const r: any = await updateJob(job.id, patch); onChanged(r.job) } catch (e: any) { pushError(e.message) }
  }
  const recs: Rec[] = job.recommendations || []
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
      ) : job.skillId ? (
        <SkillInstructions job={job} />
      ) : (
        <section className="tm-section">
          <h2>What it runs</h2>
          <p className="muted">Built-in code ({job.runner}), with no instructions to edit. Its schedule and notifications are below.</p>
        </section>
      )}
      <section className="tm-section">
        <h2>When it runs</h2>
        <WhenItRuns
          schedule={job.schedule}
          trigger={trigger}
          seen={triggerDirty ? undefined : job.watch?.seen}
          onSchedule={(schedule) => save({ schedule })}
          onTrigger={(t) => { setTrigger(t); if (!t && job.trigger) save({ trigger: null }) }}
        />
        {trigger && triggerDirty && (
          <div className="tm-actions">
            <button type="button" className="btn primary" disabled={!watchReady(trigger)} onClick={() => save({ trigger })}>{job.trigger ? 'Save watch' : 'Start watching'}</button>
            <button type="button" className="btn" onClick={() => setTrigger(job.trigger || null)}>Discard</button>
          </div>
        )}
        {job.trigger && !triggerDirty && job.watch?.checkedAt && <p className="muted tm-hint">Last checked {relativeTime(job.watch.checkedAt)}.{job.watch.error ? ` ${job.watch.error}` : ''}</p>}
      </section>
      {!job.agentless && !job.fixedProvider && (
        <section className="tm-section">
          <h2>Model</h2>
          <ModelSection
            recs={recs}
            value={{ provider: job.provider || 'default', model: job.model || '', effort: job.effort || '' }}
            onChange={(c) => save({ provider: c.provider, model: c.model || null, effort: c.effort || null })}
          />
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
    const fresh = await runTotemNow(job)
    if (fresh) onChanged(fresh)
    setRunning(false)
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

// --- the list ------------------------------------------------------------------------
// Like the chats list: each totem is a row with the latest thing in its chat, and
// a click opens that chat (its runs are posted there). Settings, memory and runs
// open from the gear, or from the totem's name at the top of its chat. Group
// chats, with several totems in one chat, sit above.

const plain = (s: string) => s.replace(/[*_`#>|]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()

/** The newest message in a chat, as one plain line. */
function lastLine(t: ChatThread | undefined): { text: string; at: number } | null {
  const m = t?.messages[t.messages.length - 1]
  if (!m) return null
  const text = plain(m.content || '') || (m.parts?.some((p) => p.type === 'tool') ? 'Worked on something' : '')
  return text ? { text: m.role === 'user' ? `You: ${text}` : text, at: m.createdAt || t!.updatedAt } : null
}

function TotemRow({ job, thread, live, onOpen, onSettings, onToggle }: { job: any; thread?: ChatThread; live: boolean; onOpen: () => void; onSettings: () => void; onToggle: (v: boolean) => void }) {
  const last = lastLine(thread)
  const bad = job.lastRun?.status === 'error'
  const running = live || job.lastRun?.status === 'running'
  return (
    <div className={`tm-row ${job.enabled ? '' : 'off'} ${bad ? 'bad' : ''}`}>
      <button type="button" className="tm-row-main" onClick={onOpen} title={`Open ${job.name}'s chat`}>
        <span className="tm-icon"><TotemIcon name={job.iconName} /></span>
        <span className="tm-row-text">
          <span className="tm-row-top">
            <span className="tm-row-name">{job.name}</span>
            <span className="tm-kind">{kindOf(job)}</span>
            {thread?.needsReply && <span className="tm-unread" aria-label="Unread" />}
          </span>
          <span className="tm-row-last">{last ? last.text : job.description || 'No messages yet. Its runs are posted here.'}</span>
          <span className={`tm-row-meta ${bad ? 'tm-bad' : ''}`}>{running ? <><Spark size={11} /> Running now…</> : statusLine(job)}</span>
        </span>
        {last && <span className="tm-row-time">{ago(last.at, Date.now())}</span>}
      </button>
      <div className="tm-card-side">
        <Switch checked={job.enabled} onChange={onToggle} label={`${job.name} on`} />
        <button type="button" className="tm-chat-btn" onClick={onSettings} aria-label={`${job.name} settings`} title="Settings, memory and runs"><TI icon={IconSettings} size={16} /></button>
      </div>
    </div>
  )
}

/** Up to three member icons, overlapped. */
function MemberStack({ ids, jobs }: { ids: string[]; jobs: any[] }) {
  const shown = ids.map((id) => jobs.find((j) => j.id === id)).filter(Boolean).slice(0, 3)
  return (
    <span className="tm-stack" aria-hidden>
      {shown.length ? shown.map((j) => <span key={j.id} className="tm-icon sm"><TotemIcon name={j.iconName} size={14} /></span>)
        : <span className="tm-icon sm"><TI icon={IconUsersGroup} size={14} /></span>}
    </span>
  )
}

function GroupRow({ t, jobs, live, onOpen }: { t: ChatThread; jobs: any[]; live: boolean; onOpen: () => void }) {
  const last = lastLine(t)
  const names = (t.members || []).map((id) => jobs.find((j) => j.id === id)?.name).filter(Boolean)
  return (
    <div className="tm-row">
      <button type="button" className="tm-row-main" onClick={onOpen}>
        <MemberStack ids={t.members || []} jobs={jobs} />
        <span className="tm-row-text">
          <span className="tm-row-top">
            <span className="tm-row-name">{threadTitle(t)}</span>
            {t.needsReply && <span className="tm-unread" aria-label="Unread" />}
          </span>
          <span className="tm-row-last">{live ? 'Answering…' : last ? last.text : 'No messages yet.'}</span>
          <span className="tm-row-meta">You{names.length ? `, ${names.join(', ')}` : ''}</span>
        </span>
        {last && <span className="tm-row-time">{ago(last.at, Date.now())}</span>}
      </button>
    </div>
  )
}

/** Pick totems for a new group chat. Only agent totems can talk. */
export function GroupPicker({ jobs, initial = [], title: heading = 'New group chat', action = 'Start group chat', named = false, allowEmpty = false, onCancel, onDone }: { jobs: any[]; initial?: string[]; title?: string; action?: string; named?: boolean; allowEmpty?: boolean; onCancel: () => void; onDone: (ids: string[], name: string) => Promise<void> | void }) {
  const askable = jobs.filter((j) => !j.runner && !j.skillId && String(j.prompt || '').trim())
  const [picked, setPicked] = useState<string[]>(initial)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  return (
    <div className="tm-group-pick">
      <div className="tm-group-pick-head">
        <strong>{heading}</strong>
        <span className="muted">The chat’s agent hosts it: it asks the totems you pick, passes their answers between them, and pulls the result together. Say “@name” to talk to one directly.</span>
      </div>
      {!askable.length && <p className="muted">No agent totems yet. Make one first; built-in jobs can’t talk.</p>}
      <div className="tm-group-list">
        {askable.map((j) => (
          <label key={j.id} className={`tm-group-opt ${picked.includes(j.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={picked.includes(j.id)} onChange={() => toggle(j.id)} />
            <span className="tm-icon sm"><TotemIcon name={j.iconName} size={14} /></span>
            <span className="tm-group-opt-text"><span>{j.name}</span>{j.description && <span className="muted">{j.description}</span>}</span>
          </label>
        ))}
      </div>
      {named && <input className="tm-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional), e.g. Weekly planning" aria-label="Group chat name" />}
      <div className="tm-actions">
        <button type="button" className="btn primary" disabled={(!picked.length && !allowEmpty) || busy} onClick={async () => { setBusy(true); try { await onDone(picked, name.trim()) } finally { setBusy(false) } }}>{busy ? 'Working…' : action}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/** Make a group chat and open it. */
export async function startGroupChat(ids: string[], title: string, onOpenChat: () => void) {
  try {
    const { thread } = await api<{ thread: ChatThread }>('/api/totems/groups', { method: 'POST', body: JSON.stringify({ members: ids, title }) })
    adoptThread(thread)
    setActive(thread.id)
    onOpenChat()
  } catch (e: any) { pushError(`Couldn't start the group chat: ${e.message}`) }
}

export default function TotemsView({ onAuthError, onOpenChat }: { onAuthError: () => void; onOpenChat: () => void }) {
  const [jobs, setJobs] = useState<any[] | null>(null)
  const [drafts, setDrafts] = useState<DraftRecord[]>([])
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get('totem'))
  // false: the list; null: a new totem; a record: continuing that draft.
  const [building, setBuilding] = useState<DraftRecord | null | false>(false)
  const [grouping, setGrouping] = useState(false)
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)

  // The chat header's totem link lands here with ?totem=<id>.
  useEffect(() => {
    const onPop = () => setOpen(new URLSearchParams(window.location.search).get('totem'))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const openSettings = (id: string | null) => {
    setOpen(id)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('totem', id)
    else url.searchParams.delete('totem')
    window.history.replaceState(window.history.state, '', url.pathname + url.search)
  }

  const loadDrafts = useCallback(() => {
    api<{ drafts: DraftRecord[] }>('/api/totems/drafts').then((r) => setDrafts(r.drafts || [])).catch(() => {})
  }, [])
  const load = useCallback(() => {
    getJobs().then((p: any) => setJobs(p.jobs || [])).catch((e) => { if (e instanceof AuthError) onAuthError(); else pushError(e.message) })
    loadDrafts()
  }, [onAuthError, loadDrafts])
  useEffect(() => {
    load()
    syncThreads()
    const t = setInterval(() => { load(); syncThreads() }, 30_000)
    return () => clearInterval(t)
  }, [load])

  const replace = (job: any) => setJobs((list) => (list || []).map((j) => (j.id === job.id ? job : j)))
  const toggle = async (j: any, v: boolean) => { try { const r: any = await updateJob(j.id, { enabled: v }); replace(r.job) } catch (e: any) { pushError(e.message) } }
  const ownChat = useMemo(() => new Map(threads.filter((t) => t.totemId).map((t) => [t.totemId!, t])), [threads])
  // Agent totems first, then built-ins; then whichever spoke last; then by name.
  const sorted = useMemo(() => [...(jobs || [])].sort((a, b) =>
    Number(!!(a.runner || a.skillId)) - Number(!!(b.runner || b.skillId))
    || (ownChat.get(b.id)?.updatedAt || 0) - (ownChat.get(a.id)?.updatedAt || 0)
    || Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)), [jobs, ownChat])
  const groups = useMemo(() => threads.filter((t) => t.members?.length).sort((a, b) => b.updatedAt - a.updatedAt), [threads])
  const job = open ? jobs?.find((j) => j.id === open) : null

  const closeBuilder = () => { setBuilding(false); loadDrafts() }
  async function discardDraft(d: DraftRecord) {
    if (!window.confirm(`Discard the draft${d.draft?.name ? ` “${d.draft.name}”` : ''}?`)) return
    try { await api(`/api/totems/drafts/${d.id}`, { method: 'DELETE' }); setDrafts((l) => l.filter((x) => x.id !== d.id)) } catch (e: any) { pushError(e.message) }
  }
  const openGroup = (id: string) => { setActive(id); onOpenChat() }

  if (building !== false) {
    return (
      <div className="view tm-view">
        <Builder
          key={building?.id || 'new'}
          initial={building}
          onClose={closeBuilder}
          onDiscarded={closeBuilder}
          onCreated={(j) => { closeBuilder(); setJobs((l) => [...(l || []), j]); openTotemChat(j, onOpenChat) }}
        />
      </div>
    )
  }
  if (job) return <div className="view tm-view"><Detail job={job} onBack={() => openSettings(null)} onChanged={replace} onDeleted={() => { openSettings(null); load() }} onOpenChat={onOpenChat} /></div>

  return (
    <div className="view tm-view">
      <div className="tm-page">
        <div className="tm-head">
          <div>
            <h1>Totems</h1>
            <p className="tm-lede">Standing agents that work on their own schedule, remember what they’ve seen, and only tell you what matters. Open one to read its runs and talk to it.</p>
          </div>
          <div className="tm-head-actions">
            <button type="button" className="btn" onClick={() => setGrouping(true)} disabled={!jobs?.length}><TI icon={IconUsersGroup} size={15} />Group chat</button>
            <button type="button" className="btn primary" onClick={() => setBuilding(null)}><TI icon={IconPlus} size={15} />New totem</button>
          </div>
        </div>
        {grouping && jobs && (
          <GroupPicker jobs={jobs} named onCancel={() => setGrouping(false)} onDone={async (ids, name) => { await startGroupChat(ids, name, onOpenChat); setGrouping(false) }} />
        )}
        {!jobs && <p className="muted">Loading…</p>}
        {groups.length > 0 && (
          <section className="tm-drafts">
            <h2>Group chats</h2>
            <div className="tm-list">
              {groups.map((t) => <GroupRow key={t.id} t={t} jobs={jobs || []} live={!!runs[t.id]} onOpen={() => openGroup(t.id)} />)}
            </div>
          </section>
        )}
        {drafts.length > 0 && (
          <section className="tm-drafts">
            <h2>Drafts</h2>
            <div className="tm-list">
              {drafts.map((d) => (
                <div key={d.id} className="tm-row draft">
                  <button type="button" className="tm-row-main" onClick={() => setBuilding(d)}>
                    <span className="tm-icon"><TotemIcon name={d.draft?.icon || 'sparkles'} /></span>
                    <span className="tm-row-text">
                      <span className="tm-row-top"><span className="tm-row-name">{d.draft?.name || 'Untitled totem'}</span><span className="tm-kind">Draft</span></span>
                      <span className="tm-row-last">{d.draft?.summary || d.description}</span>
                      <span className="tm-row-meta">
                        {d.pending ? 'The builder is working on it…' : `Edited ${relativeTime(d.updatedAt)}`}
                        {!d.pending && d.messages[d.messages.length - 1]?.questions?.length ? ' · Has questions for you' : ''}
                      </span>
                    </span>
                  </button>
                  <div className="tm-card-side">
                    <button type="button" className="tm-chat-btn" onClick={() => discardDraft(d)} aria-label={`Discard ${d.draft?.name || 'draft'}`} title="Discard draft"><TI icon={IconTrash} size={16} /></button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        {jobs && !jobs.length && (
          <button type="button" className="tm-empty" onClick={() => setBuilding(null)}>
            <TI icon={IconSparkles} size={22} />
            <strong>Make your first totem</strong>
            <span>Describe a job, such as watching a listing or writing a weekly review, and the builder sets it up.</span>
          </button>
        )}
        {jobs && jobs.length > 0 && (
          <section className="tm-drafts">
            {(groups.length > 0 || drafts.length > 0) && <h2>Totems</h2>}
            <div className="tm-list">
              {sorted.map((j) => (
                <TotemRow
                  key={j.id}
                  job={j}
                  thread={ownChat.get(j.id)}
                  live={!!(ownChat.get(j.id) && runs[ownChat.get(j.id)!.id])}
                  onOpen={() => openTotemChat(j, onOpenChat)}
                  onSettings={() => openSettings(j.id)}
                  onToggle={(v) => toggle(j, v)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
