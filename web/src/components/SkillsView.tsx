import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Hi, SparklesIcon, PlusIcon, TrashIcon, CommandLineIcon, XMarkIcon,
  ArrowPathIcon, EyeIcon, ClockIcon, ExclamationTriangleIcon, InformationCircleIcon,
} from '../icons'
import { iconFor } from '../studio'
import IconPicker from './IconPicker'
import SkillReviser from './SkillReviser'
import {
  getSkills, createSkill, updateSkill, deleteSkill, resetSkill, previewSkill, AuthError,
} from '../api'
import { pushSuccess, pushError } from '../toast'

// Skills — every prompt Totem runs, and all of them editable.
//
// What this replaces: a hardcoded `SYSTEM_SKILLS` array in studio.ts that could
// only be toggled on and off, plus a separate localStorage bag of "user skills"
// the bridge never read. So the skills that shipped couldn't be changed, and the
// ones you wrote couldn't actually run. Worse, the real work — the sixty-line
// prompts behind the daily brief and both Plaud ingests — wasn't here at all. It
// was a template literal inside bridge.mjs, reachable only by editing the server
// and restarting it.
//
// Now every skill is a Markdown file on the bridge that this tab reads and writes.
// A skill that shipped with Totem is edited, renamed and deleted exactly like one
// you wrote; the only difference is that it has a shipped version to reset back to,
// which is what makes editing one safe to try.

const MODE_CHOICES = [
  { id: 'send', label: 'Run it straight away' },
  { id: 'fill', label: 'Put it in the composer to finish' },
]

// What each {{variable}} the bridge can fill actually means. The editor lists
// these next to the body, because a placeholder you can't discover may as well
// not exist — and a typo'd one renders as an empty hole.
const VARIABLE_HELP: Record<string, string> = {
  now: 'The current date and time, spelled out, in your briefing timezone.',
  weather: 'Today’s weather snapshot. Costs a network call, so only ask when you use it.',
  news: 'Recent AI and world headlines. Also a network call.',
  inboxFile: 'Path to the brain’s inbox.md, where confirm-only proposals are staged.',
  since: 'The journal watermark as an exact instant — empty on a first run.',
  sinceDate: 'The same watermark as YYYY-MM-DD, for Plaud’s whole-day filter.',
  stateFile: 'Path to the Plaud meetings state file.',
  processedSummary: 'The Plaud recordings already processed, as a skip list.',
}

interface SkillCardProps {
  skill: any
  active: boolean
  onOpen: (skill: any) => void
}

function SkillCard({ skill, active, onOpen }: SkillCardProps) {
  const Icon = iconFor(skill.iconName, skill.kind === 'seeded' ? 'sparkles' : 'command')
  return (
    <button
      type="button"
      className={`skill-card as-button ${skill.enabled ? '' : 'off'} ${active ? 'active' : ''}`}
      onClick={() => onOpen(skill)}
    >
      <div className="skill-card-head">
        <span className={`skill-glyph ${skill.kind}`}><Hi icon={Icon} size={16} /></span>
        <div className="skill-card-title">
          <strong>{skill.name}</strong>
          {skill.command && <span className="skill-command">{skill.command}</span>}
        </div>
      </div>
      <p className="skill-card-desc">{skill.description || 'No description.'}</p>
      <div className="skill-card-meta">
        <span className={`skill-tag ${skill.kind}`}>{skill.kind === 'seeded' ? 'Default' : 'Yours'}</span>
        {skill.modified && <span className="skill-tag edited">Edited</span>}
        {!skill.enabled && <span className="skill-tag off">Off</span>}
        {skill.usedBy?.map((job: any) => (
          <span key={job.id} className="skill-tag usage" title={`Runs as the job “${job.name}”`}>
            <Hi icon={ClockIcon} size={11} /> {job.scheduleLabel}
          </span>
        ))}
      </div>
    </button>
  )
}

interface EditorProps {
  skill: any
  variables: string[]
  onSaved: (payload: any) => void
  onClose: () => void
  onAuthError?: () => void
}

function SkillEditor({ skill, variables, onSaved, onClose, onAuthError }: EditorProps) {
  // Some prompts get values only their caller has, so the allowed set is
  // per-skill, not global.
  const allowed = skill.knownVariables?.length ? skill.knownVariables : variables
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description)
  const [iconName, setIconName] = useState(skill.iconName)
  const [command, setCommand] = useState(skill.command || '')
  const [mode, setMode] = useState(skill.mode || 'send')
  const [enabled, setEnabled] = useState(skill.enabled !== false)
  const [body, setBody] = useState(skill.body)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<any>(null)

  // Reset local state when a different skill is opened in the same panel.
  useEffect(() => {
    setName(skill.name); setDescription(skill.description); setIconName(skill.iconName)
    setCommand(skill.command || ''); setMode(skill.mode || 'send')
    setEnabled(skill.enabled !== false); setBody(skill.body); setPreview(null)
  }, [skill.id])

  const dirty = name !== skill.name || description !== skill.description
    || iconName !== skill.iconName || (command || '') !== (skill.command || '')
    || mode !== (skill.mode || 'send') || enabled !== (skill.enabled !== false)
    || body !== skill.body

  // Placeholders in the body the bridge has no value for. These render as an
  // empty string at run time, which is the quiet failure worth catching here
  // rather than at 08:00 tomorrow.
  const unknownVars = useMemo(() => {
    const used = [...String(body).matchAll(/\{\{\s*[#^/]?([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1])
    return [...new Set(used)].filter((v) => !allowed.includes(v))
  }, [body, allowed])

  async function act(fn: () => Promise<any>, message: string) {
    setBusy(true)
    try {
      const payload = await fn()
      onSaved(payload)
      pushSuccess(message)
    } catch (e: any) {
      pushError(e?.message || 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  const save = () => act(
    () => updateSkill(skill.id, { name, description, iconName, command, mode, enabled, body }),
    `Saved “${name}”`,
  )

  function reset() {
    if (!window.confirm(`Discard your changes to “${skill.name}” and restore the version that ships with Totem?`)) return
    act(() => resetSkill(skill.id), `Restored the default “${skill.name}”`)
  }

  function remove() {
    const warning = skill.usedBy?.length
      ? `“${skill.name}” is what ${skill.usedBy.map((j: any) => `the ${j.name} job`).join(' and ')} runs. Deleting it will leave that job with nothing to do. Continue?`
      : `Delete “${skill.name}”?${skill.kind === 'seeded' ? ' It ships with Totem, so it will not come back on restart — but you can restore it later.' : ''}`
    if (!window.confirm(warning)) return
    act(async () => { const p = await deleteSkill(skill.id); onClose(); return p }, `Deleted “${skill.name}”`)
  }

  async function showPreview() {
    setBusy(true)
    try {
      setPreview(await previewSkill(skill.id, body))
    } catch (e: any) {
      pushError(e?.message || 'Could not build a preview.')
    } finally {
      setBusy(false)
    }
  }

  function insertVariable(v: string) {
    setBody((b: string) => `${b}${b.endsWith('\n') || !b ? '' : ' '}{{${v}}}`)
  }

  return (
    <div className="skill-editor">
      <div className="skill-form-head">
        <strong>{skill.kind === 'seeded' ? 'Edit default skill' : 'Edit skill'}</strong>
        <button type="button" className="icon-btn small" onClick={onClose} aria-label="Close editor">
          <Hi icon={XMarkIcon} size={15} />
        </button>
      </div>

      {skill.usedBy?.length > 0 && (
        <div className="job-form-note">
          <Hi icon={InformationCircleIcon} size={14} />
          Editing this changes {skill.usedBy.map((j: any) => `“${j.name}” (${j.scheduleLabel.toLowerCase()})`).join(' and ')}.
        </div>
      )}

      <label className="catalog-field">
        <span>Name</span>
        <div className="workflow-name-row">
          <IconPicker value={iconName} onChange={setIconName} fallback="sparkles" label="Choose skill icon" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekly review" />
        </div>
      </label>

      <label className="catalog-field">
        <span>Short description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this skill does, in a sentence"
        />
      </label>

      <div className="skill-field-row">
        <label className="catalog-field">
          <span>Chat command</span>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="/weekly-review" />
          <em>Type this in chat to run it. Leave blank for a skill only jobs use.</em>
        </label>
        <label className="catalog-field">
          <span>When you type it</span>
          <select className="model-select" value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODE_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
      </div>

      <label className="catalog-field">
        <span>Instructions</span>
        <textarea
          className="skill-body"
          rows={18}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Tell Totem exactly what to do. This is sent to the AI as written, with Totem's usual tools and memory."
          spellCheck={false}
        />
      </label>

      <SkillReviser
        skillId={skill.id}
        body={body}
        onApply={setBody}
        onAuthError={onAuthError}
      />

      <div className="catalog-field">
        <span>Values you can drop in</span>
        <div className="skill-var-chips">
          {allowed.map((v: string) => (
            <button
              key={v}
              type="button"
              className={`skill-var-chip ${body.includes(`{{${v}}}`) ? 'used' : ''}`}
              title={VARIABLE_HELP[v] || 'Filled in by Totem when this runs.'}
              onClick={() => insertVariable(v)}
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
        {unknownVars.length > 0 && (
          <em className="field-warn">
            <Hi icon={ExclamationTriangleIcon} size={12} />
            {' '}{unknownVars.map((v) => `{{${v}}}`).join(', ')} {unknownVars.length === 1 ? 'is not a value' : 'are not values'} Totem
            {' '}can fill — {unknownVars.length === 1 ? 'it' : 'they'} will come out blank. Check the spelling.
          </em>
        )}
      </div>

      {preview && (
        <div className="catalog-field">
          <span>What the AI will actually receive</span>
          <pre className="skill-preview">{preview.text}</pre>
          {preview.missing?.length > 0 && (
            <em className="field-warn">
              <Hi icon={ExclamationTriangleIcon} size={12} /> Rendered empty: {preview.missing.map((m: string) => `{{${m}}}`).join(', ')}
            </em>
          )}
        </div>
      )}

      <div className="skill-editor-actions">
        <div className="skill-editor-actions-left">
          <button type="button" className="link-btn" onClick={showPreview} disabled={busy}>
            <Hi icon={EyeIcon} size={13} /> Preview
          </button>
          {skill.kind === 'seeded' && (
            <button type="button" className="link-btn" onClick={reset} disabled={busy || !skill.modified}>
              <Hi icon={ArrowPathIcon} size={13} /> Reset to default
            </button>
          )}
          <button type="button" className="link-btn danger" onClick={remove} disabled={busy}>
            <Hi icon={TrashIcon} size={13} /> Delete
          </button>
        </div>
        <div className="skill-form-actions">
          <label className="skill-enable-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Enabled</span>
          </label>
          <button type="button" className="btn compact primary" onClick={save} disabled={busy || !dirty || !name.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function NewSkillForm({ onCreate, onCancel }: { onCreate: (f: any) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onCreate({ name: name.trim(), description: description.trim(), body: body.trim() })
  }

  return (
    <form className="skill-form" onSubmit={submit}>
      <div className="skill-form-head">
        <strong>New skill</strong>
        <button type="button" className="icon-btn small" onClick={onCancel} aria-label="Cancel">
          <Hi icon={XMarkIcon} size={15} />
        </button>
      </div>
      <label className="catalog-field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekly review" autoFocus />
      </label>
      <label className="catalog-field">
        <span>Short description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this skill does, in a sentence" />
      </label>
      <label className="catalog-field">
        <span>Instructions</span>
        <textarea
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Tell Totem how to perform this skill — steps, tone, which apps to touch…"
        />
      </label>
      <div className="skill-form-actions">
        <button type="button" className="btn compact" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn compact primary" disabled={!name.trim()}>Create skill</button>
      </div>
    </form>
  )
}

export default function SkillsView({ onAuthError }: { onAuthError?: () => void }) {
  const [payload, setPayload] = useState<any>(null)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      setPayload(await getSkills())
      setError('')
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError?.()
      setError(e?.message || 'Could not load skills.')
    }
  }, [onAuthError])

  useEffect(() => { load() }, [load])

  const skills = payload?.skills || []
  const variables = payload?.variables || []
  const open = skills.find((s: any) => s.id === openId) || null

  // Defaults first, then yours — same ordering rule as Jobs, so the two tabs read
  // the same way.
  const [seeded, mine] = useMemo(() => [
    skills.filter((s: any) => s.kind === 'seeded'),
    skills.filter((s: any) => s.kind !== 'seeded'),
  ], [skills])

  async function create(fields: any) {
    try {
      const result = await createSkill(fields)
      setPayload(result)
      setCreating(false)
      setOpenId(result.skill.id)
      pushSuccess(`Created “${result.skill.name}”`)
    } catch (e: any) {
      pushError(e?.message || 'Could not create that skill.')
    }
  }

  function onSaved(next: any) {
    setPayload(next)
    if (next?.skill) setOpenId(next.skill.id)
  }

  return (
    <div className="studio-pane">
      <header className="studio-pane-head">
        <div>
          <h2>Skills</h2>
          <p>
            Every prompt Totem runs, including the ones it ships with. Edit any of them — the daily brief,
            the Plaud ingest, all of it. Each one is a file{payload?.dir ? <> under <code>{payload.dir}</code></> : null},
            so you can edit them here or in your editor.
          </p>
        </div>
        {!creating && (
          <button className="btn compact primary" onClick={() => { setCreating(true); setOpenId(null) }}>
            <Hi icon={PlusIcon} size={15} /> New skill
          </button>
        )}
      </header>

      {error && <div className="studio-empty error"><Hi icon={ExclamationTriangleIcon} size={22} /><span>{error}</span></div>}
      {creating && <NewSkillForm onCreate={create} onCancel={() => setCreating(false)} />}
      {open && (
        <SkillEditor
          key={open.id}
          skill={open}
          variables={variables}
          onSaved={onSaved}
          onClose={() => setOpenId(null)}
          onAuthError={onAuthError}
        />
      )}

      <div className="settings-section-title"><span /><strong>Ships with Totem</strong></div>
      {seeded.length ? (
        <div className="skill-grid">
          {seeded.map((s: any) => <SkillCard key={s.id} skill={s} active={s.id === openId} onOpen={(x) => { setOpenId(x.id); setCreating(false) }} />)}
        </div>
      ) : (
        <div className="studio-empty">
          <Hi icon={SparklesIcon} size={22} />
          <span>You’ve deleted every default skill. New ones still arrive when Totem ships them.</span>
        </div>
      )}

      <div className="settings-section-title"><span /><strong>Yours</strong></div>
      {mine.length ? (
        <div className="skill-grid">
          {mine.map((s: any) => <SkillCard key={s.id} skill={s} active={s.id === openId} onOpen={(x) => { setOpenId(x.id); setCreating(false) }} />)}
        </div>
      ) : (
        <div className="studio-empty">
          <Hi icon={CommandLineIcon} size={22} />
          <span>No skills of your own yet. Create one, or copy a default and change it.</span>
        </div>
      )}
    </div>
  )
}
