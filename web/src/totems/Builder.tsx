import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { pushError, pushToast } from '../toast'
import { TI } from '../chat/ui'
import { useChat } from '../chat/store'
import { modelLabel } from '../chat/models'
import { IconArrowLeft, IconArrowUp, IconLoader2, IconRefresh, IconSparkles } from '../chat/icons'
import { SettingsSection } from '../components/settings/ui'
import { TotemIcon, TYPE_LABEL, asWatch, type Draft, type Choice, type Msg, type DraftRecord } from './shared'
import { AutoText, BehaviourSection, IconRow, ModelSection, TextRow, WhenSection, watchReady } from './fields'

// The builder: a draft totem on the left, laid out like a totem's own settings,
// and the conversation that shapes it on the right (a T3-style card). The owner
// describes the job on the Totems page; the builder designs it, asks what it
// needs to know, and rewrites the draft on each reply while his own edits stay.
// Nothing is created until he presses Create, and an unfinished one is a draft
// (totems/drafts.mjs) the bridge keeps even if he leaves mid-turn.

// Not crypto.randomUUID: that needs a secure context, and the dashboard may be on plain http.
const newDraftId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
const DEFAULT_CHOICE: Choice = { provider: 'default', model: '', effort: '' }
const topChoice = (d: Draft | null): Choice => {
  const top = d?.recommendations[0]
  return top ? { provider: top.provider, model: top.model || '', effort: top.effort || '' } : DEFAULT_CHOICE
}
const sameChoice = (a: Choice, b: Choice) => a.provider === b.provider && (a.model || '') === (b.model || '') && (a.effort || '') === (b.effort || '')
export const MIN_DESCRIPTION = 8
const NOT_READY = 'It needs a name, instructions and a complete watch.'

function BuilderChat({ messages, pending, first, onSend }: { messages: Msg[]; pending: string | null; first?: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }) }, [messages.length, pending])
  const lastOwner = [...messages].reverse().find((m) => m.role === 'owner')
  const failed = messages[messages.length - 1]?.error
  const asking = !!messages[messages.length - 1]?.questions?.length
  const send = () => { const t = text.trim(); if (!t || pending) return; onSend(t); setText('') }
  return (
    <aside className="tm-chat" aria-label="Builder conversation">
      <div className="tm-chat-head">
        <TI icon={IconSparkles} size={16} />
        <strong>Builder</strong>
        <span>{pending ? (first ? 'Designing…' : 'Revising…') : asking ? 'Has questions for you' : 'Your edits are kept'}</span>
      </div>
      <div className="tm-chat-log" aria-live="polite">
        {messages.map((m, i) => (
          <div key={`${m.at}-${i}`} className={`tm-msg ${m.role}${m.error ? ' error' : ''}`}>
            <p>{m.text}</p>
            {m.questions && m.questions.length > 0 && <ol>{m.questions.map((q) => <li key={q}>{q}</li>)}</ol>}
          </div>
        ))}
        {pending && <div className="tm-msg builder busy"><TI icon={IconLoader2} size={14} className="tm-spin" />{first ? 'Designing it…' : 'Revising the draft…'}</div>}
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
          placeholder={asking ? 'Answer, or ask for a change…' : 'Ask for a change…'}
          disabled={first && !!pending}
          aria-label="Message the builder"
        />
        <button type="button" className="tm-send" disabled={!text.trim() || !!pending} onClick={send} aria-label="Send"><TI icon={IconArrowUp} size={16} stroke={2.25} /></button>
      </div>
    </aside>
  )
}

/** Before there is a draft: the description, and either the builder at work or a Build button. */
function Designing({ text, setText, designing, failure, onBuild }: { text: string; setText: (t: string) => void; designing: boolean; failure?: string; onBuild: () => void }) {
  if (designing) {
    return (
      <div className="tm-designing" role="status">
        <span className="tm-icon lg"><TI icon={IconLoader2} size={22} className="tm-spin" /></span>
        <h2>Designing your totem</h2>
        <p>It picks a schedule, writes the instructions and suggests the cheapest model that does the job well. This takes up to a minute; you can leave, it’s kept as a draft.</p>
      </div>
    )
  }
  return (
    <SettingsSection title="What should it do?" description="Say what it should do and how often, in your own words. Nothing is created until you confirm.">
      <div className="tm-editor">
        <textarea rows={5} autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label="Describe the totem"
          placeholder="e.g. Every Friday, go through my calendar and tasks and tell me where my week actually went."
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim().length >= MIN_DESCRIPTION) onBuild() }} />
      </div>
      <div className="tm-group-foot">
        <span className={`tm-foot-note${failure ? ' tm-bad' : ''}`}>{failure || 'Ctrl+Enter builds it.'}</span>
        <button type="button" className="btn compact primary" disabled={text.trim().length < MIN_DESCRIPTION} onClick={onBuild}>
          <TI icon={IconSparkles} size={14} />{failure ? 'Try again' : 'Build totem'}
        </button>
      </div>
    </SettingsSection>
  )
}

export default function Builder({ initial, start, onClose, onCreated, onDiscarded }: {
  initial: DraftRecord | null
  /** A description typed on the Totems page: designing starts at once. */
  start?: string
  onClose: () => void
  onCreated: (job: any) => void
  onDiscarded: () => void
}) {
  const id = useMemo(() => initial?.id || newDraftId(), [initial?.id])
  const [text, setText] = useState(initial?.description || start || '')
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

  async function turn(message: string | null, description = text) {
    const prev = draft
    const body = message ? { draftId: id, description, draft, choice, message } : { draftId: id, description }
    if (message) setPending(message)
    else setBusy('build')
    // Shown at once; the bridge's copy replaces it when the turn ends.
    setMessages((m) => (message ? [...m, { role: 'owner', text: message, at: Date.now() }] : [{ role: 'owner', text: description.trim(), at: Date.now() }]))
    try {
      const r = await api<{ draft: Draft; messages: Msg[] }>('/api/totems/build', { method: 'POST', body: JSON.stringify(body) })
      adopt(r, prev)
      saved.current = JSON.stringify([description, r.draft, null])
    } catch (e: any) {
      // A failed turn is kept in the draft with his message, so retry is one tap.
      const rec = await api<{ draft: DraftRecord }>(`/api/totems/drafts/${id}`).then((x) => x.draft).catch(() => null)
      if (rec) setMessages(rec.messages)
      if (!rec || !message) pushError(e.message)
    } finally { setBusy(''); setPending(null) }
  }

  // Started from the Totems page's composer: design it straight away, once.
  const started = useRef(false)
  useEffect(() => {
    if (start && !initial && !started.current && start.trim().length >= MIN_DESCRIPTION) { started.current = true; void turn(null, start) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
  const designing = !draft && (busy === 'build' || !!pending)
  const failure = !draft && !designing ? messages.filter((m) => m.error).pop()?.text : undefined
  const ready = !!draft && !!draft.name.trim() && !!draft.instructions.trim() && watchReady(asWatch(draft.trigger))

  return (
    <div className={`tm-page${draft || designing ? ' wide' : ''}`}>
      <button type="button" className="tm-crumb" onClick={onClose}><TI icon={IconArrowLeft} size={15} />Totems</button>
      <header className="tm-hero">
        <span className="tm-icon lg"><TotemIcon name={draft?.icon || 'sparkles'} size={24} /></span>
        <div className="tm-hero-text">
          {draft
            ? <input className="tm-name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} aria-label="Name" disabled={locked} />
            : <h1>New totem</h1>}
          <p className="tm-hero-sub">
            {draft ? <>
              <span className="tm-tag">Draft</span>
              <span>{TYPE_LABEL[draft.taskType] || 'Agent'}</span>
              <span className="tm-sep" aria-hidden>·</span>
              <span>{pending ? 'The builder is revising; editing is paused' : 'Saved as you go'}</span>
            </> : <span>A standing agent: it runs on its own, remembers what it has seen, and tells you what matters.</span>}
          </p>
        </div>
        {draft && (
          <div className="tm-hero-actions tm-hero-create">
            <button type="button" className="btn primary" disabled={locked || !ready} onClick={create} aria-describedby={ready ? undefined : 'tm-create-why'}>{busy === 'create' ? 'Creating…' : 'Create totem'}</button>
            {!ready && <span className="tm-foot-note" id="tm-create-why">{NOT_READY}</span>}
          </div>
        )}
      </header>
      <div className={`tm-builder${draft || designing ? ' split' : ''}`}>
        <div className="tm-draft">
          {!draft ? (
            <Designing text={text} setText={setText} designing={designing} failure={failure} onBuild={() => turn(null)} />
          ) : (
            <fieldset className="tm-fields" disabled={locked}>
              <SettingsSection title="Totem">
                <TextRow title="Summary" description="One line: what it does for you." value={draft.summary || ''} live wide maxLength={200} placeholder="What it does for you" onCommit={(summary) => patch({ summary })} />
                <IconRow value={draft.icon} name={draft.name || 'the totem'} onChange={(icon) => patch({ icon })} />
              </SettingsSection>
              <SettingsSection title="Instructions" description="What it is told each run. Edit freely; the builder keeps your changes.">
                <div className="tm-editor"><AutoText rows={5} value={draft.instructions} onChange={(instructions) => patch({ instructions })} label="Instructions" /></div>
              </SettingsSection>
              <WhenSection schedule={draft.schedule} trigger={asWatch(draft.trigger)} onSchedule={(schedule) => patch({ schedule })} onTrigger={(trigger) => patch({ trigger })} />
              <ModelSection recs={draft.recommendations} value={choice} onChange={setChoice} />
              <BehaviourSection agent notify={draft.notify} browser={draft.browser} access={draft.access === 'full'}
                onChange={(p) => patch({ ...(p.notify ? { notify: p.notify } : {}), ...('browser' in p ? { browser: !!p.browser } : {}), ...('access' in p ? { access: p.access ?? null } : {}) })} />
            </fieldset>
          )}
          {draft && (
            <div className="tm-createbar">
              <span className="tm-foot-note" id="tm-create-note">{ready ? (asWatch(draft.trigger) ? 'It starts watching once created.' : 'Its first run starts once created.') : NOT_READY}</span>
              <button type="button" className="btn ghost" disabled={locked} onClick={discard}>Discard draft</button>
              <button type="button" className="btn primary" disabled={locked || !ready} onClick={create} aria-describedby="tm-create-note">{busy === 'create' ? 'Creating…' : 'Create totem'}</button>
            </div>
          )}
        </div>
        {(draft || designing) && <BuilderChat messages={messages} pending={pending || (busy === 'build' ? text : null)} first={!draft} onSend={(m) => turn(m)} />}
      </div>
    </div>
  )
}
