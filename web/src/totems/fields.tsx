import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TI } from '../chat/ui'
import { useChat, loadProviders, ensureModels } from '../chat/store'
import { normalizeModelSettings } from '../chat/models'
import ModelPicker from '../chat/ModelPicker'
import { THREAD_ICONS } from '../chat/threadIcons.gen'
import { IconCheck, IconPlus, IconTrash } from '../chat/icons'
import { SettingsRow, SettingsSection, Switch } from '../components/settings/ui'
import { ScheduleBuilder, NOTIFY_CHOICES } from './schedule'
import { TotemIcon, sourceKey, type Rec, type Watch, type WatchSource, type Choice } from './shared'

// The editing pieces a totem's settings and the builder's draft share. Each is a
// Settings section (components/settings/ui.tsx): a heading over one bordered group
// of rows, so a totem reads like every other settings surface. They take a value
// and an onChange; the caller decides whether a change saves at once (a totem) or
// waits for Create (a draft).

/** A textarea that grows with its text, from `rows` lines up to most of the window. */
export function AutoText({ value, onChange, rows = 5, mono, label, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; mono?: boolean; label: string; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, Math.max(320, window.innerHeight * 0.6))}px`
  }, [value])
  return <textarea ref={ref} className={mono ? 'mono' : undefined} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} placeholder={placeholder} spellCheck={!mono} />
}

const COST: Record<number, string> = { 1: 'Low cost', 2: 'Medium cost', 3: 'High cost' }

/** Icons a totem can wear: the chat icon set, cut to what a standing job is likely to be about. */
export const TOTEM_ICONS = [
  'sparkles', 'news', 'search', 'eye', 'bell', 'calendar', 'clock', 'chart-line', 'report-analytics', 'target',
  'trophy', 'run', 'bike', 'barbell', 'heartbeat', 'mail', 'inbox', 'brand-github', 'git-branch', 'code',
  'robot', 'bulb', 'book', 'notebook', 'writing', 'briefcase', 'coin', 'wallet', 'shopping-cart', 'home',
  'plane', 'map', 'world', 'camera', 'music', 'leaf', 'flask', 'shield', 'tool', 'list-check',
].filter((name) => THREAD_ICONS[name])

const iconLabel = (slug: string) => slug.replace(/^brand-/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** The icon row: the current icon as the control, the grid under it once opened. */
export function IconRow({ value, onChange, name }: { value: string; onChange: (icon: string) => void; name: string }) {
  const [open, setOpen] = useState(false)
  const icons = TOTEM_ICONS.includes(value) || !value ? TOTEM_ICONS : [value, ...TOTEM_ICONS]
  return (
    <SettingsRow
      title="Icon"
      description="Shown in the chats panel and on its replies in group chats."
      control={(
        <button type="button" className="tm-icon-btn" aria-expanded={open} aria-label={`Change ${name}'s icon`} onClick={() => setOpen((v) => !v)}>
          <TotemIcon name={value} size={18} />
        </button>
      )}
    >
      {open && (
        <div className="tm-icon-grid" role="radiogroup" aria-label={`Icon for ${name}`}>
          {icons.map((icon) => (
            <button key={icon} type="button" role="radio" aria-checked={icon === value} className={icon === value ? 'on' : ''} title={iconLabel(icon)} aria-label={iconLabel(icon)}
              onClick={() => { onChange(icon); setOpen(false) }}>
              <TotemIcon name={icon} size={18} />
            </button>
          ))}
        </div>
      )}
    </SettingsRow>
  )
}

/** A one-line text setting that saves on blur or Enter (a totem) or on every keystroke (a draft). */
export function TextRow({ title, description, value, onCommit, live, required, placeholder, maxLength, wide }: {
  title: string; description?: string; value: string; onCommit: (v: string) => void; live?: boolean
  /** Blank is refused: the old value comes back. */
  required?: boolean; placeholder?: string; maxLength?: number; wide?: boolean
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => {
    const v = text.trim()
    if (required && !v) { setText(value); return }
    if (v !== value.trim()) onCommit(v)
  }
  return (
    <SettingsRow
      title={title}
      description={description}
      control={(
        <input
          className={`s-input tm-text${wide ? ' wide' : ''}`} value={text} maxLength={maxLength} placeholder={placeholder} aria-label={title}
          onChange={(e) => { setText(e.target.value); if (live) onCommit(e.target.value) }}
          onBlur={live ? undefined : commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        />
      )}
    />
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
      <select className="model-select tm-effort" value={value.effort || ''} onChange={(e) => onChange({ ...value, effort: e.target.value })} aria-label="Effort">
        <option value="">Default effort</option>
        <option value="low">Low effort</option>
        <option value="medium">Medium effort</option>
        <option value="high">High effort</option>
      </select>
    </span>
  )
}

/**
 * The model: the builder's suggestions as rows (cheapest first, the first one
 * recommended), then a row for any model at all. `action` sits in the heading
 * (Recommend again, on a saved totem).
 */
export function ModelSection({ recs, value, onChange, action }: { recs: Rec[]; value: Choice; onChange: (c: Choice) => void; action?: React.ReactNode }) {
  const picked = recs.findIndex((r) => r.provider === value.provider && (r.model || '') === (value.model || ''))
  return (
    <SettingsSection title="Model" description={recs.length ? 'Suggestions are cheapest first. You can change this any time.' : 'Which model runs it. Any model on any account, the same list chats use.'} action={action}>
      {recs.length > 0 && (
        <div className="tm-recs" role="radiogroup" aria-label="Suggested models">
          {recs.map((r, i) => {
            const on = picked === i
            return (
              <button key={`${r.provider}:${r.model}`} type="button" role="radio" aria-checked={on} className={`tm-rec${on ? ' on' : ''}`}
                onClick={() => onChange({ provider: r.provider, model: r.model || '', effort: r.effort || '' })}>
                <span className="tm-radio" aria-hidden>{on && <TI icon={IconCheck} size={12} stroke={2.5} />}</span>
                <span className="tm-rec-main">
                  <span className="tm-rec-title">
                    <strong>{r.label}</strong>
                    <span className="tm-rec-acct">{r.account}{r.effort ? ` · ${r.effort} effort` : ''}</span>
                    {i === 0 && <span className="tm-tag accent">Recommended</span>}
                  </span>
                  {r.why && <span className="tm-rec-why">{r.why}</span>}
                </span>
                <span className={`tm-cost c${r.cost}`}>{COST[r.cost] || 'Cost unknown'}</span>
              </button>
            )
          })}
        </div>
      )}
      <SettingsRow
        title={recs.length ? 'Any model' : 'Model'}
        description={recs.length ? (picked < 0 ? 'Your pick. It runs on this instead of the suggestions.' : 'Pick from every account instead.') : 'Leave it on the default to follow Settings → Providers.'}
        control={<ModelChoice value={value} onChange={onChange} />}
      />
    </SettingsSection>
  )
}

const NEW_GIT: WatchSource = { kind: 'git', repo: '', ref: 'main' }
export const NEW_WATCH: Watch = { type: 'watch', everyMinutes: 5, sources: [NEW_GIT] }
const MAX_SOURCES = 20

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tm-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => value !== o.id && onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  )
}

function SourceFields({ source: s, onChange }: { source: WatchSource; onChange: (s: WatchSource) => void }) {
  return (
    <div className="tm-source-fields">
      <Segmented label="What it watches" value={s.kind} options={[{ id: 'git', label: 'A git branch' }, { id: 'url', label: 'A web page' }]}
        onChange={(k) => onChange(k === 'git' ? NEW_GIT : { kind: 'url', url: '', contains: '' })} />
      {s.kind === 'git' ? (
        <div className="tm-field-row">
          <label className="tm-field tm-grow">
            <span>Repository</span>
            <input className="s-input" value={s.repo} onChange={(e) => onChange({ ...s, repo: e.target.value })} placeholder="/home/you/projects/app, or https://github.com/owner/repo" spellCheck={false} />
          </label>
          <label className="tm-field tm-ref">
            <span>Branch</span>
            <input className="s-input" value={s.ref} onChange={(e) => onChange({ ...s, ref: e.target.value })} spellCheck={false} />
          </label>
        </div>
      ) : (
        <div className="tm-field-row">
          <label className="tm-field tm-grow">
            <span>Page</span>
            <input className="s-input" value={s.url} onChange={(e) => onChange({ ...s, url: e.target.value })} placeholder="https://…" spellCheck={false} />
          </label>
          <label className="tm-field tm-grow">
            <span>Only when it shows this text <em>optional</em></span>
            <input className="s-input" value={s.contains || ''} onChange={(e) => onChange({ ...s, contains: e.target.value })} placeholder="e.g. In stock" />
          </label>
        </div>
      )}
    </div>
  )
}

/** Each watched source is a row of the group; `seen` is the saved baseline per source. */
function WatchRows({ value, onChange, seen }: { value: Watch; onChange: (w: Watch) => void; seen?: Record<string, { label: string }> }) {
  const sources = value.sources
  const min = sources.some((s) => s.kind === 'url') ? 5 : 1
  const setSources = (next: WatchSource[]) => {
    const pageMin = next.some((s) => s.kind === 'url') && !sources.some((s) => s.kind === 'url')
    onChange({ ...value, sources: next, everyMinutes: pageMin ? Math.max(value.everyMinutes, 15) : value.everyMinutes })
  }
  const hint = [
    sources.some((s) => s.kind === 'git') && 'A checkout on this machine is watched through its origin remote, so it wakes on what was merged upstream, not on local commits.',
    sources.some((s) => s.kind === 'url') && 'With text, a page wakes it when that text appears or disappears; without, any change to the page’s text counts.',
  ].filter(Boolean).join(' ')
  return (
    <>
      {sources.map((s, i) => (
        <SettingsRow
          key={i} stack
          title={sources.length > 1 ? `Watch ${i + 1}` : 'What it watches'}
          description={seen?.[sourceKey(s)] ? `Last seen: ${seen[sourceKey(s)].label}` : undefined}
        >
          <SourceFields source={s} onChange={(n) => setSources(sources.map((x, j) => (j === i ? n : x)))} />
          {sources.length > 1 && (
            <button type="button" className="btn ghost compact tm-remove" onClick={() => setSources(sources.filter((_, j) => j !== i))}>
              <TI icon={IconTrash} size={14} /> Stop watching this
            </button>
          )}
        </SettingsRow>
      ))}
      <SettingsRow
        title="Check every"
        description={`Checks use no AI. The first one only notes how things look now; it runs each time ${sources.length > 1 ? 'any of them changes, told which ones did' : 'that changes'}.`}
        control={(
          <span className="tm-minutes">
            <input className="s-input" type="number" min={min} max={1440} value={value.everyMinutes} aria-label="Minutes between checks"
              onChange={(e) => onChange({ ...value, everyMinutes: Math.max(min, Math.min(1440, Number(e.target.value) || min)) })} />
            minutes
          </span>
        )}
      />
      {sources.length < MAX_SOURCES && (
        <SettingsRow
          title="Watch something else too"
          description={hint || undefined}
          control={<button type="button" className="btn compact" onClick={() => setSources([...sources, NEW_GIT])}><TI icon={IconPlus} size={14} /> Add</button>}
        />
      )}
    </>
  )
}

export const sourceReady = (s: WatchSource) => (s.kind === 'git' ? !!s.repo.trim() && !!s.ref.trim() : /^https?:\/\/\S+/.test(s.url.trim()))
export const watchReady = (w: Watch | null) => !w || (w.sources.length > 0 && w.sources.every(sourceReady))

/** "When it runs": a schedule, or a watch on branches and pages. */
export function WhenSection({ schedule, trigger, seen, onSchedule, onTrigger, footer }: {
  schedule: any; trigger: Watch | null; seen?: Record<string, { label: string }>
  onSchedule: (s: any) => void; onTrigger: (t: Watch | null) => void
  /** Save/Discard for an edited watch (a SaveBar). */
  footer?: React.ReactNode
}) {
  return (
    <SettingsSection title="When it runs">
      <SettingsRow
        title="Wakes"
        description={trigger ? 'When something it watches changes.' : 'On a schedule, in the time zone the scheduler runs in.'}
        control={(
          <Segmented label="What wakes it" value={trigger ? 'watch' : 'schedule'} options={[{ id: 'schedule', label: 'On a schedule' }, { id: 'watch', label: 'On a change' }]}
            onChange={(v) => onTrigger(v === 'watch' ? NEW_WATCH : null)} />
        )}
      />
      {trigger ? <WatchRows value={trigger} onChange={onTrigger} seen={seen} /> : (
        <SettingsRow title="Schedule" stack><ScheduleBuilder value={schedule} onChange={onSchedule} /></SettingsRow>
      )}
      {footer}
    </SettingsSection>
  )
}

/** Notifications, the browser and full access. Built-in totems have only the first. */
export function BehaviourSection({ agent, notify, browser, access, onChange }: {
  agent: boolean; notify: string; browser: boolean; access: boolean
  onChange: (patch: { notify?: string; browser?: boolean; access?: 'full' | null }) => void
}) {
  return (
    <SettingsSection title="Behaviour">
      <SettingsRow
        title="Notify me"
        description={agent ? 'It ends each run deciding whether you need to hear about it.' : 'When a run should reach your phone.'}
        control={(
          <select className="model-select" value={notify} onChange={(e) => onChange({ notify: e.target.value })} aria-label="Notify me">
            {NOTIFY_CHOICES.filter((c) => agent || c.id !== 'agent').map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        )}
      />
      {agent && (
        <SettingsRow
          title="Browser"
          description="Open pages in a real browser, for sites that need JavaScript. Off: web search and plain page fetches."
          control={<Switch checked={browser} onChange={(v) => onChange({ browser: v })} label="Browser" />}
        />
      )}
      {agent && (
        <SettingsRow
          title="Full access"
          description="Run any command (ssh included) and write anywhere, with nobody approving. Off: reads, the web, and its own memory and files."
          control={<Switch checked={access} onChange={(v) => onChange({ access: v ? 'full' : null })} label="Full access" />}
        />
      )}
    </SettingsSection>
  )
}

/** The bar under an editor with unsaved changes: shown only while there is something to save. */
export function SaveBar({ busy, onSave, onDiscard, saveLabel = 'Save', disabled, children }: {
  busy?: boolean; onSave: () => void; onDiscard: () => void; saveLabel?: string; disabled?: boolean; children?: React.ReactNode
}) {
  return (
    <div className="tm-group-foot">
      <span className="tm-foot-note">{children}</span>
      <button type="button" className="btn compact ghost" disabled={busy} onClick={onDiscard}>Discard</button>
      <button type="button" className="btn compact primary" disabled={busy || disabled} onClick={onSave}>{busy ? 'Saving…' : saveLabel}</button>
    </div>
  )
}
