import React, { useEffect, useState } from 'react'
import { api, updateJob, deleteJob, getSkills, updateSkill, resetSkill, previewSkill } from '../api'
import { pushError, pushToast } from '../toast'
import { TI } from '../chat/ui'
import { IconArrowLeft, IconLoader2, IconMessage, IconPlayerPlay, IconRefresh, IconTrash } from '../chat/icons'
import { SettingsNote, SettingsRow, SettingsSection, Switch } from '../components/settings/ui'
import { findLanding, landKey, useLandOn } from '../landing'
import { RunHistory, relativeTime } from './schedule'
import { TotemIcon, kindOf, openTotemChat, setTotemEnabled, totemState, useTotemRun, type Rec, type Watch } from './shared'
import { AutoText, BehaviourSection, IconRow, ModelSection, SaveBar, TextRow, WhenSection, watchReady } from './fields'

// One totem's page, opened from a row's gear or its chat's header: what it is,
// how it runs, what it remembers and what it has done. Its chat is where it
// talks; this page is where it is set up. Every change saves at once, except the
// texts (instructions, memory, a watch), which wait for Save.

type Tab = 'settings' | 'memory' | 'runs'

function MemoryTab({ job }: { job: any }) {
  const [value, setValue] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    api<{ memory: string }>(`/api/totems/${encodeURIComponent(job.id)}/memory`)
      .then((r) => { setValue(r.memory); setDraft(r.memory) })
      .catch((e) => setError(e.message))
  }, [job.id])
  async function save() {
    setSaving(true)
    try {
      const r = await api<{ memory: string }>(`/api/totems/${encodeURIComponent(job.id)}/memory`, { method: 'PUT', body: JSON.stringify({ memory: draft }) })
      setValue(r.memory); setDraft(r.memory); pushToast('Saved its memory', 'info')
    } catch (e: any) { pushError(e.message) } finally { setSaving(false) }
  }
  const lines = (value || '').split('\n').filter((l) => l.trim()).length
  return (
    <SettingsSection
      id="memory"
      title="Memory"
      description={`What ${job.name} remembers between runs${value ? ` (${lines} line${lines === 1 ? '' : 's'})` : ''}. It keeps this up to date itself; fix anything that’s wrong.`}
    >
      <div className="tm-editor" data-land={landKey('totem-memory', job.id)}>
        {error ? <p className="tm-empty-line bad">Couldn’t read its memory: {error}</p>
          : value === null ? <p className="tm-empty-line">Loading memory…</p>
            : <AutoText mono rows={8} value={draft} onChange={setDraft} placeholder="Empty until its first run." label={`${job.name}'s memory`} />}
      </div>
      {value !== null && draft !== value && <SaveBar busy={saving} onSave={save} onDiscard={() => setDraft(value)} />}
    </SettingsSection>
  )
}

const andList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '')

// A built-in or skill totem runs a skill (skills/, data/skills/<id>/SKILL.md).
// Its instructions are edited here, in the totem, with the same save, reset and
// preview the skill store offers; nothing sends the owner elsewhere to change them.
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
  if (skill === undefined) return <SettingsSection title="Instructions"><p className="tm-empty-line">Loading…</p></SettingsSection>
  if (skill === null) {
    return <SettingsSection title="Instructions"><p className="tm-empty-line bad">Its instructions (“{job.skillId}”) are missing, so a run has nothing to follow.</p></SettingsSection>
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
  async function togglePreview() {
    setBusy(true)
    try { setPreview(preview ? null : await previewSkill(skill.id, body)) } catch (e: any) { pushError(e.message) } finally { setBusy(false) }
  }
  return (
    <SettingsSection
      title="Instructions"
      description={`What ${job.name} tells the AI each run.${others.length ? ` ${andList(others.map((j: any) => j.name))} ${others.length === 1 ? 'follows' : 'follow'} the same instructions, so a change here changes ${others.length === 1 ? 'it' : 'them'} too.` : ''}`}
      action={(
        <>
          <button type="button" className="btn compact ghost" disabled={busy} onClick={togglePreview}>{preview ? 'Hide preview' : 'Preview'}</button>
          {skill.kind === 'seeded' && skill.modified && (
            <button type="button" className="btn compact ghost" disabled={busy}
              onClick={() => { if (window.confirm('Put back the instructions that ship with Totem? Your changes are discarded.')) act(() => resetSkill(skill.id), 'Restored the original instructions') }}>
              Reset to original
            </button>
          )}
        </>
      )}
    >
      <div className="tm-editor" data-land={landKey('totem-instructions', job.id)}>
        <AutoText mono rows={8} value={body} onChange={setBody} label="Instructions" />
        {allowed.length > 0 && (
          <div className="tm-vars">
            <span>Filled in at run time:</span>
            {allowed.map((v) => (
              <button key={v} type="button" className={`tm-var${used.includes(v) ? ' used' : ''}`} title="Add to the end"
                onClick={() => setBody((b) => `${b}${b.endsWith('\n') || !b ? '' : ' '}{{${v}}}`)}>{`{{${v}}}`}</button>
            ))}
          </div>
        )}
        {unknown.length > 0 && <p className="tm-warn-line">{unknown.map((v) => `{{${v}}}`).join(', ')} {unknown.length === 1 ? 'is not a value' : 'are not values'} Totem can fill, so {unknown.length === 1 ? 'it' : 'they'} will come out blank. Check the spelling.</p>}
      </div>
      {preview && <pre className="tm-preview">{preview.text}</pre>}
      {dirty && <SaveBar busy={busy} disabled={!body.trim()} onSave={() => act(() => updateSkill(skill.id, { body }), 'Saved the instructions')} onDiscard={() => setBody(skill.body)} />}
    </SettingsSection>
  )
}

function AgentInstructions({ job, onSave }: { job: any; onSave: (prompt: string) => Promise<void> }) {
  const [text, setText] = useState(job.prompt || '')
  const [busy, setBusy] = useState(false)
  useEffect(() => setText(job.prompt || ''), [job.id, job.prompt])
  return (
    <SettingsSection title="Instructions" description={`What ${job.name} is told each run, with its memory pasted in after.`}>
      <div className="tm-editor" data-land={landKey('totem-instructions', job.id)}>
        <AutoText rows={5} value={text} onChange={setText} label="Instructions" />
      </div>
      {text !== (job.prompt || '') && <SaveBar busy={busy} disabled={!text.trim()} onSave={async () => { setBusy(true); await onSave(text); setBusy(false) }} onDiscard={() => setText(job.prompt || '')} />}
    </SettingsSection>
  )
}

function SettingsTab({ job, onChanged, onDeleted }: { job: any; onChanged: (job: any) => void; onDeleted: () => void }) {
  const agent = !job.runner && !job.skillId
  const [recommending, setRecommending] = useState(false)
  // A watch is saved with a button, not per keystroke: half a path is not a watch.
  const [trigger, setTrigger] = useState<Watch | null>(job.trigger || null)
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
    if (!window.confirm(`Delete ${job.name}? Its memory and chat are deleted too.${job.kind === 'seeded' ? ' It shipped with Totem; you can restore it from “More built in” at the bottom of the Totems page.' : ''}`)) return
    try { await deleteJob(job.id); pushToast(`Deleted ${job.name}`, 'info'); onDeleted() } catch (e: any) { pushError(e.message) }
  }
  return (
    <>
      <SettingsSection title="Totem">
        <TextRow title="Name" value={job.name} maxLength={80} required onCommit={(name) => save({ name })} />
        <TextRow title="Description" description="One line, shown under its name." value={job.description || ''} maxLength={200} wide placeholder="What it does for you" onCommit={(description) => save({ description })} />
        <IconRow value={job.iconName || ''} name={job.name} onChange={(iconName) => save({ iconName })} />
      </SettingsSection>
      {agent ? <AgentInstructions job={job} onSave={(prompt) => save({ prompt })} />
        : job.skillId ? <SkillInstructions job={job} />
          : (
            <SettingsSection title="What it runs">
              <SettingsRow title="Built-in code" description={`Totem’s own ${job.runner} job, with no instructions to edit. Its schedule and notifications are below.`} />
            </SettingsSection>
          )}
      <WhenSection
        schedule={job.schedule}
        trigger={trigger}
        seen={triggerDirty ? undefined : job.watch?.seen}
        onSchedule={(schedule) => save({ schedule })}
        onTrigger={(t) => { setTrigger(t); if (!t && job.trigger) save({ trigger: null }) }}
        footer={trigger && triggerDirty ? (
          <SaveBar disabled={!watchReady(trigger)} saveLabel={job.trigger ? 'Save watch' : 'Start watching'} onSave={() => save({ trigger })} onDiscard={() => setTrigger(job.trigger || null)}>
            {watchReady(trigger) ? 'Not saved yet' : 'Fill in what it watches to save'}
          </SaveBar>
        ) : undefined}
      />
      {!job.agentless && !job.fixedProvider && (
        <ModelSection
          recs={recs}
          value={{ provider: job.provider || 'default', model: job.model || '', effort: job.effort || '' }}
          onChange={(c) => save({ provider: c.provider, model: c.model || null, effort: c.effort || null })}
          action={(
            <button type="button" className="btn compact ghost" disabled={recommending} onClick={recommend}>
              {recommending ? <><TI icon={IconLoader2} size={14} className="tm-spin" />Asking…</> : <><TI icon={IconRefresh} size={14} />{recs.length ? 'Suggest again' : 'Suggest models'}</>}
            </button>
          )}
        />
      )}
      <BehaviourSection agent={agent} notify={job.notify} browser={!!job.browser} access={job.access === 'full'} onChange={save} />
      <SettingsSection>
        <SettingsRow
          title="Delete totem"
          description={job.kind === 'seeded' ? 'It shipped with Totem, so it can be restored from “More built in” at the bottom of the Totems page. Its memory and chat go.' : 'Its memory and chat are deleted too. This can’t be undone.'}
          control={<button type="button" className="btn compact danger" onClick={remove}><TI icon={IconTrash} size={14} />Delete</button>}
        />
      </SettingsSection>
    </>
  )
}

export default function Detail({ job, onBack, onChanged, onDeleted, onOpenChat }: { job: any; onBack: () => void; onChanged: (job: any) => void; onDeleted: () => void; onOpenChat: () => void }) {
  const [tab, setTab] = useState<Tab>('settings')
  const { running, run } = useTotemRun(job, onChanged)
  // A search hit on its instructions or memory opens that tab and flashes the section (landing.ts).
  useLandOn('totem', {
    prepare: ({ id, extra }) => { if (id === job.id) setTab(extra.section === 'memory' ? 'memory' : 'settings') },
    find: ({ id, extra }) => (id === job.id ? findLanding(landKey(extra.section === 'memory' ? 'totem-memory' : 'totem-instructions', id)) : null),
  })
  const state = totemState(job, running)
  const failed = job.lastRun?.status === 'error' && !running
  const toggle = async (v: boolean) => { const fresh = await setTotemEnabled(job, v); if (fresh) onChanged(fresh) }
  return (
    <div className="tm-page">
      <button type="button" className="tm-crumb" onClick={onBack}><TI icon={IconArrowLeft} size={15} />Totems</button>
      <header className="tm-hero">
        <span className={`tm-icon lg${job.enabled ? '' : ' off'}`}><TotemIcon name={job.iconName} size={24} /></span>
        <div className="tm-hero-text">
          <h1>{job.name}</h1>
          <p className="tm-hero-sub">
            <span className="tm-tag">{kindOf(job)}</span>
            <span className={`tm-state${state.tone === 'bad' ? ' tm-bad' : ''}`}><span className={`tm-dot ${state.tone}`} aria-hidden />{state.text}</span>
          </p>
        </div>
        <div className="tm-hero-actions">
          <button type="button" className="btn compact" onClick={() => openTotemChat(job, onOpenChat)}><TI icon={IconMessage} size={15} />Open chat</button>
          <button type="button" className="btn compact" aria-disabled={running} onClick={run} title="Run it now, without waiting for its schedule">
            {running ? <TI icon={IconLoader2} size={15} className="tm-spin" /> : <TI icon={IconPlayerPlay} size={15} />}{running ? 'Running' : 'Run now'}
          </button>
          <label className="tm-onoff">
            <Switch checked={job.enabled} onChange={toggle} label={`${job.name} on`} />
            <span>{job.enabled ? 'On' : 'Paused'}</span>
          </label>
        </div>
      </header>
      {failed && (
        <SettingsNote tone="error">
          <span>
            <strong>Its last run failed{job.lastRun?.ts ? ` ${relativeTime(job.lastRun.ts)}` : ''}.</strong>{' '}
            {job.lastRun?.error || 'No error text was recorded.'}{tab !== 'runs' && <> · <button type="button" className="tm-link" onClick={() => setTab('runs')}>See its runs</button></>}
          </span>
        </SettingsNote>
      )}
      <div className="tm-tabs" role="tablist" aria-label={`${job.name}`}>
        {(['settings', 'memory', 'runs'] as const).map((t) => (
          <button key={t} type="button" role="tab" id={`tm-tab-${t}`} aria-selected={tab === t} aria-controls={`tm-panel-${t}`} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'settings' ? 'Settings' : t === 'memory' ? 'Memory' : 'Runs'}
          </button>
        ))}
      </div>
      <div className="tm-panel" role="tabpanel" id={`tm-panel-${tab}`} aria-labelledby={`tm-tab-${tab}`}>
        {tab === 'settings' && <SettingsTab job={job} onChanged={onChanged} onDeleted={onDeleted} />}
        {tab === 'memory' && <MemoryTab job={job} />}
        {tab === 'runs' && (
          <SettingsSection title="Runs" description="The last 20, newest first. Each report is in its chat.">
            <RunHistory jobId={job.id} />
          </SettingsSection>
        )}
      </div>
    </div>
  )
}
