import React, { useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react'
import { useOwnerName } from '../useOwnerName'
import { COMMANDS } from '../shortcuts'
import { useCommand } from '../useShortcuts'
import {
  Hi,
  ChatBubbleLeftRightIcon,
  ChatBubbleLeftEllipsisIcon,
  CommandLineIcon,
  WrenchScrewdriverIcon,
  ChevronDownIcon,
  AdjustmentsHorizontalIcon,
  Bars3Icon,
  PlusIcon,
  MinusIcon,
  XMarkIcon,
  TrashIcon,
  ArrowUpSolidIcon,
  StopSolidIcon,
} from '../icons'
import { chatStream, getChatModels, getSkills, AuthError } from '../api'
import { pushError } from '../toast'
import { getChatCommands, setChatCommands, subscribeChatCommands } from '../studio'
import {
  loadThreads,
  saveThreads,
  syncThreads,
  pushThread,
  removeThread,
  newId,
  threadTitle,
  relTime,
  pruneExpiredThreads,
  isTemporaryThread,
} from '../threads'
import Markdown from './Markdown'
import { DRIVER_LOGOS } from '../providers'

interface ModelSettings {
  modelId: string
  speed: string
  effort: string
  context: string
}

const DEFAULT_MODEL_SETTINGS: ModelSettings = { modelId: 'composer-2.5', speed: 'fast', effort: 'default', context: 'default' }

const EFFORT_OPTIONS: [string, string][] = [
  ['default', 'Model default'],
  ['none', 'None'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
]
const SPEED_OPTIONS: [string, string][] = [
  ['default', 'Model default'],
  ['fast', 'Fast'],
  ['quality', 'Quality'],
]
const CONTEXT_OPTIONS: [string, string][] = [
  ['default', 'Model default'],
  ['1m', '1M context'],
]

function normalizeModelSettings(settings?: Partial<ModelSettings> | null): ModelSettings {
  return { ...DEFAULT_MODEL_SETTINGS, ...(settings || {}) }
}

// Inverse of buildModelSpec: turn a stored model spec string (e.g.
// "composer-2.5[fast=true,effort=high]") back into structured settings so a
// server-provided default model seeds a thread's model controls.
function parseModelSpec(spec?: string | null): ModelSettings {
  if (!spec || typeof spec !== 'string') return { ...DEFAULT_MODEL_SETTINGS }
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(spec.trim())
  if (!m) return { ...DEFAULT_MODEL_SETTINGS }
  const out: ModelSettings = { ...DEFAULT_MODEL_SETTINGS, modelId: m[1].trim(), speed: 'default', effort: 'default', context: 'default' }
  for (const part of (m[2] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split('=')
    if (k === 'fast') out.speed = v === 'true' ? 'fast' : 'quality'
    else if (k === 'effort') out.effort = v
    else if (k === 'context') out.context = v
  }
  return out
}

function buildModelSpec(settings?: Partial<ModelSettings> | null): string {
  const normalized = normalizeModelSettings(settings)
  const modelId = normalized.modelId || DEFAULT_MODEL_SETTINGS.modelId
  const params: string[] = []
  if (normalized.speed === 'fast') params.push('fast=true')
  if (normalized.speed === 'quality') params.push('fast=false')
  if (normalized.effort && normalized.effort !== 'default') params.push(`effort=${normalized.effort}`)
  if (normalized.context && normalized.context !== 'default') params.push(`context=${normalized.context}`)
  return params.length ? `${modelId}[${params.join(',')}]` : modelId
}

function modelName(models: any[], id: string): string {
  const found = models.find((m) => m.id === id)
  return found?.name || id
}

// Visible models for a provider, in picker order: hidden ones dropped, favorites
// pinned to the top (stable otherwise). Shared by the dropdown and the defaults.
function visibleModels(models?: any[]): any[] {
  return (models || []).filter((m) => !m.hidden).slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0))
}

// Starting model settings for a chat that lands on `providerId`. Cursor uses its
// full default spec (with thinking/speed/context params); Codex/Claude take a
// bare model id and no params. A provider only carries a preset model id when it's
// the default provider with one configured - otherwise the picker's first visible
// option (or the CLI default) applies.
function providerModelSettings(providerId: string, defaultProvider: string, defaultModel?: string | null, driver?: string): ModelSettings {
  if ((driver || providerId) === 'cursor') {
    return providerId === defaultProvider
      ? normalizeModelSettings(parseModelSpec(defaultModel))
      : { ...DEFAULT_MODEL_SETTINGS }
  }
  const modelId = providerId === defaultProvider ? (defaultModel || '').split('[')[0].trim() : ''
  return { modelId, speed: 'default', effort: 'default', context: 'default' }
}

function greeting(name: string): string {
  const h = new Date().getHours()
  const part = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  return name ? `${part}, ${name}` : part
}

function endOfToday(): number {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

function createThread(kind = 'regular', modelSettings: Partial<ModelSettings> = DEFAULT_MODEL_SETTINGS, provider: string | null = null): any {
  const now = Date.now()
  const thread: any = {
    id: newId(),
    kind,
    provider: provider || undefined,
    messages: [],
    modelSettings: normalizeModelSettings(modelSettings),
    createdAt: now,
    updatedAt: now,
  }
  if (kind === 'temporary') thread.expiresAt = endOfToday()
  return thread
}

// The composer shows command autocomplete only while the text is a single
// "/word" or "$word" token at the very start. Slash means skills; dollar means
// a manual workflow trigger.
function commandQuery(value: string): { prefix: string; term: string } | null {
  const m = /^([/$])(\S*)$/.exec(value)
  return m ? { prefix: m[1], term: m[2].toLowerCase() } : null
}

// A single tool-call row: a terminal/wrench glyph, the action ("Ran command"),
// and a muted monospace detail (the command or path). We never show completion.
function ToolRow({ tool }: { tool: any }) {
  const icon = tool.kind === 'command' ? CommandLineIcon : WrenchScrewdriverIcon
  return (
    <div className="tool-row">
      <Hi icon={icon} className="tool-icon" size={14} />
      <span className="tool-title">{tool.title || 'Tool call'}</span>
      {tool.detail && <span className="tool-detail">{tool.detail}</span>}
    </div>
  )
}

// A run of consecutive tool calls. The most recent shows as the header row; any
// earlier ones collapse behind a "+N previous tool calls" toggle.
function ToolGroup({ tools }: { tools: any[] }) {
  const [open, setOpen] = useState(false)
  const latest = tools[tools.length - 1]
  const previous = tools.slice(0, -1)
  return (
    <div className="tool-group">
      <ToolRow tool={latest} />
      {previous.length > 0 && (
        <>
          <button className="tool-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Hi icon={ChevronDownIcon} className={`tool-chevron ${open ? 'open' : ''}`} size={14} />
            {open ? 'Hide' : `+${previous.length}`} previous tool call{previous.length > 1 ? 's' : ''}
          </button>
          {open && previous.map((t, i) => <ToolRow key={i} tool={t} />)}
        </>
      )}
    </div>
  )
}

// Render an assistant turn as an ordered sequence of text + tool-call parts.
// Older threads (saved before tool parts existed) fall back to plain content.
function AssistantBody({ message, streaming }: { message: any; streaming?: boolean }) {
  const parts = message.parts
  if (!parts || !parts.length) {
    return message.content
      ? <Markdown text={message.content} className={streaming ? 'cursor-blink' : ''} />
      : <span className="cursor-blink" />
  }
  const out = []
  const lastIdx = parts.length - 1
  let i = 0
  while (i < parts.length) {
    if (parts[i].type === 'tool') {
      const group = []
      while (i < parts.length && parts[i].type === 'tool') group.push(parts[i++])
      out.push(<ToolGroup key={`g${i}`} tools={group} />)
    } else {
      const isLast = i === lastIdx
      out.push(<Markdown key={`t${i}`} text={parts[i].text} className={streaming && isLast ? 'cursor-blink' : ''} />)
      i++
    }
  }
  return (
    <div className="assistant-body">
      {out}
      {streaming && parts[lastIdx]?.type === 'tool' && <span className="cursor-blink" />}
    </div>
  )
}

interface ComposerProps {
  value: string
  setValue: (v: string) => void
  onSend: (textArg?: string) => void
  busy?: boolean
  onStop: () => void
  autoFocus?: boolean
  centered?: boolean
  belowSlot?: React.ReactNode
  commands?: boolean
  placeholder?: string
}

function Composer({
  value,
  setValue,
  onSend,
  busy,
  onStop,
  autoFocus,
  centered,
  belowSlot = null,
  commands = true,
  placeholder = 'Message Totem',
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState(0)
  // The "+" button force-opens the full command list even when the box is empty.
  const [menuForced, setMenuForced] = useState(false)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])
  // Once the field is cleared (e.g. after sending), drop the grown inline height
  // so the box snaps back to a single row instead of staying tall.
  useEffect(() => { if (!value && ref.current) ref.current.style.height = 'auto' }, [value])

  const query = commands ? commandQuery(value) : null
  // The catalog is whatever skills the bridge currently has, kept in a shared
  // store so all three Composers see the same list off one fetch.
  const catalog = useSyncExternalStore(subscribeChatCommands, getChatCommands, getChatCommands)
  const allCommands = commands ? catalog : []
  const matches = !commands ? [] :
    query !== null
      ? allCommands.filter((c) => c.cmd.startsWith(query.prefix) && (
        c.cmd.slice(1).startsWith(query.term) || c.title.toLowerCase().includes(query.term)
      ))
      : menuForced ? allCommands : []
  const menuOpen = matches.length > 0
  // Keep the highlighted row valid as the filtered list shrinks while typing.
  useEffect(() => { setSel(0) }, [query, menuForced])
  // Close the force-opened menu on an outside click.
  useEffect(() => {
    if (!menuForced) return
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuForced(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuForced])

  function choose(c: any) {
    setMenuForced(false)
    if (!c) return
    if (c.mode === 'fill') {
      setValue(c.text)
      const ta = ref.current
      if (ta) requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(c.text.length, c.text.length) })
    } else {
      onSend(c.text) // send clears the input itself
    }
  }

  function grow(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setMenuForced(false) // typing reverts to the live "/" filter
    setValue(e.target.value)
    const ta = e.target
    ta.style.height = 'auto'
    ta.style.height = Math.min(200, ta.scrollHeight) + 'px'
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[sel]); return }
      if (e.key === 'Escape') { e.preventDefault(); setMenuForced(false); setValue(''); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() }
  }
  return (
    <div className={`composer ${centered ? 'centered' : ''}`} ref={wrapRef}>
      {menuOpen && (
        <div className="slash-menu" role="listbox">
          <div className="slash-menu-head">
            Skills
          </div>
          {matches.map((c, i) => (
            <button
              key={c.cmd}
              role="option"
              aria-selected={i === sel}
              className={`slash-item ${c.kind || ''} ${i === sel ? 'active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); choose(c) }}
              onMouseEnter={() => setSel(i)}
            >
              <span className="slash-icon"><Hi icon={c.icon} size={16} /></span>
              <span className="slash-text">
                <span className="slash-cmd">{c.cmd}</span>
                <span className="slash-desc">{c.desc}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-box">
        {commands && (
          <button
            type="button"
            className={`composer-plus ${menuForced ? 'active' : ''}`}
            onClick={() => { setMenuForced((o) => !o); ref.current?.focus() }}
            title="Commands"
            aria-label="Commands"
          >
            <Hi icon={PlusIcon} size={18} />
          </button>
        )}
        <textarea
          ref={ref}
          rows={1}
          placeholder={placeholder}
          value={value}
          onChange={grow}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button className="send stop" onClick={onStop} title="Stop"><Hi icon={StopSolidIcon} size={14} /></button>
        ) : (
          <button className="send" onClick={() => onSend()} disabled={!value.trim()} title="Send"><Hi icon={ArrowUpSolidIcon} size={16} /></button>
        )}
      </div>
      {belowSlot && <div className="composer-below">{belowSlot}</div>}
    </div>
  )
}

function ThreadIcon({ thread, size = 16 }: { thread: any; size?: number }) {
  const icon = isTemporaryThread(thread) ? ChatBubbleLeftEllipsisIcon : ChatBubbleLeftRightIcon
  return <Hi icon={icon} size={size} />
}

function ProviderLogoMark({ id, name, driver }: { id?: string; name?: string; driver?: string }) {
  // Keyed by driver, not by id: `claude_work` is still drawn with Claude's mark.
  const src = DRIVER_LOGOS[driver || id || '']
  if (!src) return <span className="cp-logo cp-logo-fallback">{(name || id || '?').slice(0, 1).toUpperCase()}</span>
  return <img src={src} alt="" className="cp-logo" aria-hidden="true" />
}

// Provider picker that sits next to the model dropdown. Collapsed it shows only
// the current provider's logo; opening it reveals each provider's logo + name.
// The default provider is always listed first.
function ProviderPicker({ providers, currentProvider, onChange }: { providers: any[]; currentProvider: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const ordered = [...providers].sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0))
  const current = providers.find((p) => p.id === currentProvider) || ordered[0] || null
  return (
    <div className={`provider-picker ${open ? 'open' : ''}`} ref={ref}>
      <button
        type="button"
        className="provider-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        title={`Provider: ${current?.name || currentProvider}`}
        aria-label={`Provider: ${current?.name || currentProvider}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <ProviderLogoMark id={current?.id} name={current?.name} driver={current?.driver} />
        <Hi icon={ChevronDownIcon} size={13} className="provider-picker-caret" />
      </button>
      {open && (
        <div className="provider-picker-menu" role="listbox">
          {ordered.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={p.id === currentProvider}
              className={`provider-picker-item ${p.id === currentProvider ? 'active' : ''}`}
              onClick={() => { onChange(p.id); setOpen(false) }}
            >
              <ProviderLogoMark id={p.id} name={p.name} driver={p.driver} />
              <span className="provider-picker-name">{p.name}{p.default ? ' · default' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface ModelControlsProps {
  providers: any[]
  currentProvider: string
  onProviderChange: (id: string) => void
  models: any[]
  supportsModels: boolean
  supportsParams: boolean
  settings: ModelSettings
  settingsOpen: boolean
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setModelSetting: (patch: Partial<ModelSettings>) => void
}

// The composer's model bar for a regular chat: a provider picker (shown when
// more than one provider is enabled), a model dropdown for any provider with a
// model picker (Cursor, Codex, Claude), and - only for Cursor, whose models take
// thinking/speed/context params - a settings gear. The default provider is marked
// so it's obvious which one new/temporary chats fall back to.
function ModelControls({
  providers,
  currentProvider,
  onProviderChange,
  models,
  supportsModels,
  supportsParams,
  settings,
  settingsOpen,
  setSettingsOpen,
  setModelSetting,
}: ModelControlsProps) {
  const selectedModelSpec = buildModelSpec(settings)
  const selectedModelLabel = modelName(models, settings.modelId)
  // When the stored model isn't among the visible options (e.g. just switched
  // provider, or it was hidden), show the first option as selected.
  const effectiveModelId = models.some((m) => m.id === settings.modelId) ? settings.modelId : (models[0]?.id ?? settings.modelId)
  return (
    <div className="model-bar">
      {providers.length > 1 && (
        <ProviderPicker
          providers={providers}
          currentProvider={currentProvider}
          onChange={onProviderChange}
        />
      )}
      {supportsModels && (
        <select
          className="model-select"
          value={effectiveModelId}
          onChange={(e) => setModelSetting({ modelId: e.target.value })}
          title={`Model: ${selectedModelSpec}`}
        >
          {settings.modelId && !models.some((m) => m.id === settings.modelId) && (
            <option value={settings.modelId}>{selectedModelLabel}</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}{m.recommended ? ' (recommended)' : ''}
            </option>
          ))}
        </select>
      )}
      {supportsParams && (
        // The gear and its popover share a positioned wrapper so the panel always
        // floats directly above the button - in the hero state and the docked
        // composer alike - instead of at a fixed spot in the chat. Cursor only:
        // its thinking/speed/context params don't apply to Codex or Claude.
        <div className="model-settings-wrap">
          <button
            className={`icon-btn model-settings-btn ${settingsOpen ? 'active' : ''}`}
            onClick={() => setSettingsOpen((v) => !v)}
            title="Model settings"
          >
            <Hi icon={AdjustmentsHorizontalIcon} size={18} />
          </button>
          {settingsOpen && (
            <ModelSettingsPopover
              settings={settings}
              setModelSetting={setModelSetting}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}

// The model-tuning panel (thinking/speed/context). Anchored above the gear button
// via `.model-settings-wrap`, so it tracks the button wherever the composer sits.
function ModelSettingsPopover({ settings, setModelSetting, onClose }: { settings: ModelSettings; setModelSetting: (patch: Partial<ModelSettings>) => void; onClose: () => void }) {
  return (
    <div className="model-popover">
      <div className="model-popover-head">
        <div>
          <div className="model-popover-title">Model Settings</div>
          <div className="model-spec">{buildModelSpec(settings)}</div>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close"><Hi icon={XMarkIcon} size={20} /></button>
      </div>
      <label>
        Thinking
        <select value={settings.effort} onChange={(e) => setModelSetting({ effort: e.target.value })}>
          {EFFORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>
        Speed
        <select value={settings.speed} onChange={(e) => setModelSetting({ speed: e.target.value })}>
          {SPEED_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>
        Context
        <select value={settings.context} onChange={(e) => setModelSetting({ context: e.target.value })}>
          {CONTEXT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <button className="btn" onClick={() => setModelSetting(DEFAULT_MODEL_SETTINGS)}>
        Reset to Composer 2.5 Fast
      </button>
    </div>
  )
}

interface ChatViewProps {
  onAuthError: () => void
  visible?: boolean
}

interface ProviderInfo {
  defaultProvider: string
  defaultModel: string | null
  providers: any[]
}

export default function ChatView({ onAuthError, visible = true }: ChatViewProps) {
  const [threads, setThreads] = useState<any[]>(() => pruneExpiredThreads(loadThreads()))
  const ownerName = useOwnerName()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [quickInput, setQuickInput] = useState('')
  const [quickId, setQuickId] = useState<string | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [draftKind, setDraftKind] = useState('regular')
  const [draftModelSettings, setDraftModelSettings] = useState<ModelSettings>(DEFAULT_MODEL_SETTINGS)
  const [draftProvider, setDraftProvider] = useState('cursor')
  // Streaming state is keyed by thread id so several threads can run at once and
  // each thread only ever shows its own progress - switching threads never bleeds
  // one stream's cursor/activity into another.
  const [streaming, setStreaming] = useState<Record<string, boolean>>({}) // { [id]: true }
  const [activityById, setActivityById] = useState<Record<string, string>>({}) // { [id]: 'reading file…' }
  const [drawer, setDrawer] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Enabled providers + the default provider/model, fetched from the bridge. Model
  // catalogs are loaded lazily per provider (only Cursor exposes a picker today).
  const [providerInfo, setProviderInfo] = useState<ProviderInfo>({ defaultProvider: 'cursor', defaultModel: 'composer-2.5[fast=true]', providers: [] })
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, any[]>>({}) // { [providerId]: models[] }
  const ctrls = useRef<Record<string, AbortController>>({}) // { [id]: AbortController }
  const logRef = useRef<HTMLDivElement>(null)
  const linkedThreadId = useRef<string | null>(new URLSearchParams(window.location.search).get('thread'))

  const active = threads.find((t) => t.id === activeId) || null
  const quick = threads.find((t) => t.id === quickId) || null
  const messages = active?.messages || []
  const empty = !active || messages.length === 0
  const busy = activeId ? !!streaming[activeId] : false
  const activity = activeId ? activityById[activeId] || '' : ''
  const activeKind = active?.kind || draftKind
  const activeTemporary = activeKind === 'temporary'
  const currentModelSettings = normalizeModelSettings(active?.modelSettings || draftModelSettings)

  // The provider a chat uses: temporary chats always ride the default provider;
  // regular chats use their stored provider (older threads fall back to default);
  // a brand-new chat uses the draft provider.
  const providerDef = useCallback((id: string) => providerInfo.providers.find((p) => p.id === id) || null, [providerInfo])
  const providerSupportsModels = useCallback(
    (id: string) => { const d = providerInfo.providers.find((p) => p.id === id); return d ? !!d.supportsModelPicker : id === 'cursor' },
    [providerInfo],
  )
  // Model settings a fresh chat starts with: the default model when the default
  // provider has a picker, otherwise the plain fallback.
  const defaultModelSettings = useCallback((): ModelSettings => (
    providerSupportsModels(providerInfo.defaultProvider)
      ? normalizeModelSettings(providerModelSettings(providerInfo.defaultProvider, providerInfo.defaultProvider, providerInfo.defaultModel, providerDef(providerInfo.defaultProvider)?.driver))
      : { ...DEFAULT_MODEL_SETTINGS }
  ), [providerInfo, providerSupportsModels, providerDef])
  const currentProvider = activeTemporary
    ? providerInfo.defaultProvider
    : active
      ? (active.provider || providerInfo.defaultProvider)
      : (draftProvider || providerInfo.defaultProvider)

  // Update one thread. With { sync: true } the new state is also pushed to the
  // bridge; streaming deltas pass sync:false and only hit the localStorage cache,
  // so we persist on meaningful boundaries (user turn, stream done) not per token.
  const patchThread = useCallback((id: string, patch: (t: any) => any, { sync = false }: { sync?: boolean } = {}) => {
    setThreads((ts) => {
      let updated: any = null
      const next = ts.map((t) => {
        if (t.id !== id) return t
        updated = { ...t, ...patch(t), updatedAt: Date.now() }
        return updated
      })
      saveThreads(next)
      if (sync && updated) pushThread(updated)
      return next
    })
  }, [])

  const setModelSetting = useCallback((patch: Partial<ModelSettings>) => {
    if (activeId && active?.kind !== 'temporary') {
      patchThread(activeId, (t) => ({ modelSettings: normalizeModelSettings({ ...t.modelSettings, ...patch }) }), { sync: true })
      return
    }
    setDraftModelSettings((s) => normalizeModelSettings({ ...s, ...patch }))
  }, [activeId, active?.kind, patchThread])

  // Fetch a provider's model catalog. `force` re-pulls even when cached, so the
  // per-provider model allowlist (the `selected` flags set in the Providers tab)
  // is picked up after it changes; the lazy path skips an already-loaded catalog.
  const fetchModels = useCallback((providerId: string, { force = false }: { force?: boolean } = {}) => {
    if (!providerId || !providerSupportsModels(providerId)) return
    if (!force && modelsByProvider[providerId]) return
    getChatModels(providerId)
      .then((info) => setModelsByProvider((c) => ({ ...c, [providerId]: info.models || [] })))
      .catch((e) => { if (e instanceof AuthError) onAuthError() })
  }, [providerSupportsModels, modelsByProvider, onAuthError])
  const ensureModels = useCallback((providerId: string) => fetchModels(providerId), [fetchModels])

  // Switch the active (or draft) chat's provider, resetting its model settings to
  // that provider's sensible default. Temporary chats can't switch - they always
  // use the default provider.
  const setThreadProvider = useCallback((providerId: string) => {
    ensureModels(providerId)
    const settings = providerSupportsModels(providerId)
      ? normalizeModelSettings(providerModelSettings(providerId, providerInfo.defaultProvider, providerInfo.defaultModel, providerDef(providerId)?.driver))
      : { ...DEFAULT_MODEL_SETTINGS }
    if (activeId && active?.kind !== 'temporary') {
      patchThread(activeId, () => ({ provider: providerId, modelSettings: settings }), { sync: true })
    } else {
      setDraftProvider(providerId)
      setDraftModelSettings(settings)
    }
  }, [activeId, active?.kind, patchThread, ensureModels, providerSupportsModels, providerInfo])

  const applySyncedThreads = useCallback((serverThreads: any[]) => {
    setThreads(serverThreads)
    const requested = linkedThreadId.current
    if (requested && serverThreads.some((t) => t.id === requested)) {
      setActiveId(requested)
      setDraftKind('regular')
      linkedThreadId.current = null
    }
  }, [])

  const refreshThreads = useCallback(() => {
    if (Object.keys(ctrls.current).length) return
    syncThreads()
      .then(applySyncedThreads)
      .catch((e) => { if (e instanceof AuthError) onAuthError() })
  }, [applySyncedThreads, onAuthError])

  // Pull cross-device history on mount; stay on the cached threads if offline.
  // Server-created Shortcut handoff threads are picked up when the app is focused
  // or on a light polling interval while no chat stream is running.
  useEffect(() => {
    let cancelled = false
    syncThreads()
      .then((server) => { if (!cancelled) applySyncedThreads(server) })
      .catch((e) => { if (e instanceof AuthError) onAuthError() })
    const onFocus = () => { if (!cancelled) refreshThreads() }
    const onVisibility = () => { if (!cancelled && document.visibilityState === 'visible') refreshThreads() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    const timer = setInterval(() => {
      setThreads((ts) => {
        const next = pruneExpiredThreads(ts)
        if (next.length !== ts.length) saveThreads(next)
        return next
      })
    }, 60 * 1000)
    const syncTimer = setInterval(() => { if (!cancelled) refreshThreads() }, 30 * 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
      clearInterval(syncTimer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [applySyncedThreads, onAuthError, refreshThreads])

  // Load the "/" command menu from the skills on the bridge. Refetched when the
  // tab regains focus, so a skill you just renamed in Studio is offered here
  // without a reload — the two used to be separate lists that drifted apart.
  useEffect(() => {
    let cancelled = false
    const load = () => getSkills()
      .then((p) => { if (!cancelled) setChatCommands(p.skills || []) })
      .catch((e) => { if (e instanceof AuthError) onAuthError() })
    load()
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => { cancelled = true; window.removeEventListener('focus', onFocus) }
  }, [onAuthError])

  // Fetch the enabled-provider roster + default provider/model. `seedDraft` seeds
  // the new-chat draft with the defaults - done once on mount, but skipped on later
  // refreshes so a refresh never clobbers a draft the user is mid-composing.
  const loadProviderInfo = useCallback(({ seedDraft = false }: { seedDraft?: boolean } = {}) => {
    return getChatModels()
      .then((info) => {
        const defaultProvider = info.defaultProvider || info.provider || 'cursor'
        setProviderInfo({ defaultProvider, defaultModel: info.defaultModel || null, providers: info.providers || [] })
        if (info.provider) setModelsByProvider((c) => ({ ...c, [info.provider]: info.models || [] }))
        if (seedDraft) {
          setDraftProvider(defaultProvider)
          const defaultRow = (info.providers || []).find((p: any) => p.id === defaultProvider)
          const supportsModels = defaultRow?.supportsModelPicker ?? (defaultProvider === 'cursor')
          setDraftModelSettings(supportsModels
            ? normalizeModelSettings(providerModelSettings(defaultProvider, defaultProvider, info.defaultModel, defaultRow?.driver))
            : { ...DEFAULT_MODEL_SETTINGS })
        }
      })
      .catch((e) => { if (e instanceof AuthError) onAuthError() })
  }, [onAuthError])

  useEffect(() => { loadProviderInfo({ seedDraft: true }) }, [loadProviderInfo])

  // The enabled-provider set can change in the Providers tab while this view stays
  // mounted, so re-pull it whenever the Chat tab becomes visible again.
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (visible && !wasVisible.current) {
      loadProviderInfo()
      // Re-pull the open chat's catalog so an allowlist edit in the Providers tab
      // is reflected in the model picker without a full reload.
      fetchModels(currentProvider, { force: true })
    }
    wasVisible.current = visible
  }, [visible, loadProviderInfo, fetchModels, currentProvider])

  // Make sure the model catalog for whatever provider the open chat uses is loaded.
  useEffect(() => { ensureModels(currentProvider) }, [currentProvider, ensureModels])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [messages, activity, busy])

  function startNew(kind = 'regular') {
    setNewMenuOpen(false)
    setActiveId(null)
    setDrawer(false)
    setInput('')
    setDraftKind(kind)
    // A new chat always starts on the configured default provider + model.
    setDraftProvider(providerInfo.defaultProvider)
    setDraftModelSettings(defaultModelSettings())
    if (kind === 'temporary') {
      const thread = createThread('temporary', defaultModelSettings(), providerInfo.defaultProvider)
      setThreads((ts) => { const next = [thread, ...ts]; saveThreads(next); return next })
      pushThread(thread)
      setActiveId(thread.id)
    }
  }

  // `g c c` — the `g c` prefix brings this tab forward, then this starts a
  // fresh regular chat. Temporary chats stay on the + menu: they're a
  // deliberate choice, not something to trip into with two keystrokes.
  useCommand(COMMANDS.chatNew, () => startNew('regular'))

  function openThread(id: string) {
    setActiveId(id)
    setDrawer(false)
    setNewMenuOpen(false)
  }

  function deleteThread(id: string, e?: React.MouseEvent) {
    e?.stopPropagation()
    ctrls.current[id]?.abort()
    delete ctrls.current[id]
    setStreaming((s) => { const n = { ...s }; delete n[id]; return n })
    setActivityById((m) => { const n = { ...m }; delete n[id]; return n })
    setThreads((ts) => {
      const next = ts.filter((t) => t.id !== id)
      saveThreads(next)
      return next
    })
    removeThread(id)
    if (id === activeId) setActiveId(null)
    if (id === quickId) { setQuickId(null); setQuickOpen(false) }
  }

  function convertThread(id: string, e?: React.MouseEvent) {
    e?.stopPropagation()
    setThreads((ts) => {
      let updated: any = null
      const next = ts.map((t) => {
        if (t.id !== id) return t
        updated = {
          ...t,
          kind: 'regular',
          modelSettings: normalizeModelSettings(t.modelSettings),
          updatedAt: Date.now(),
        }
        delete updated.expiresAt
        return updated
      })
      saveThreads(next)
      if (updated) pushThread(updated)
      return next
    })
  }

  function ensureQuickThread() {
    const existing = quick && !isTemporaryThread(quick) ? null : quick
    if (existing) {
      setQuickOpen(true)
      return existing.id
    }
    const thread = createThread('temporary', defaultModelSettings(), providerInfo.defaultProvider)
    setThreads((ts) => { const next = [thread, ...ts]; saveThreads(next); return next })
    pushThread(thread)
    setQuickId(thread.id)
    setQuickOpen(true)
    return thread.id
  }

  function sendToThread({ textArg, id: forcedId = null, clearInput, defaultKind = draftKind }: { textArg?: string; id?: string | null; clearInput?: () => void; defaultKind?: string }) {
    const text = (typeof textArg === 'string' ? textArg : input).trim()
    const targetBusy = forcedId ? !!streaming[forcedId] : busy
    if (!text || targetBusy) return
    clearInput?.()

    let id = forcedId || activeId
    let priorMessages: any[] = []
    let threadKind = defaultKind
    // Temporary chats always run on the default provider/model; the server
    // applies the default model when none is sent, so we pass model=null there.
    let threadProvider = defaultKind === 'temporary' ? providerInfo.defaultProvider : draftProvider
    let modelSettings = defaultKind === 'temporary' ? defaultModelSettings() : draftModelSettings
    if (!id) {
      const thread = createThread(defaultKind, modelSettings, threadProvider)
      id = thread.id
      setThreads((ts) => { const next = [thread, ...ts]; saveThreads(next); return next })
      setActiveId(id)
      pushThread(thread)
    } else {
      const thread = threads.find((t) => t.id === id)
      priorMessages = (thread?.messages || []).slice()
      threadKind = thread?.kind || defaultKind || 'regular'
      if (threadKind === 'temporary') {
        threadProvider = providerInfo.defaultProvider
        modelSettings = defaultModelSettings()
      } else {
        threadProvider = thread?.provider || providerInfo.defaultProvider
        modelSettings = normalizeModelSettings(thread?.modelSettings)
      }
    }
    // Resolve an unset model id (e.g. a chat just switched to Codex/Claude) to the
    // first visible model so what we send matches what the dropdown shows.
    if (threadKind !== 'temporary' && providerSupportsModels(threadProvider) && !modelSettings.modelId) {
      const first = visibleModels(modelsByProvider[threadProvider])[0]?.id
      if (first) modelSettings = { ...modelSettings, modelId: first }
    }
    const modelSpec = threadKind === 'temporary' ? null : buildModelSpec(modelSettings)

    patchThread(id, (t) => ({
      messages: [...t.messages, { role: 'user', content: text }, { role: 'assistant', content: '', parts: [] }],
    }), { sync: true })
    setStreaming((s) => ({ ...s, [id as string]: true }))
    setActivityById((a) => ({ ...a, [id as string]: '' }))

    const setActivity = (a: string) => setActivityById((m) => ({ ...m, [id as string]: a }))
    const finish = () => {
      setStreaming((s) => { const n = { ...s }; delete n[id as string]; return n })
      setActivityById((m) => { const n = { ...m }; delete n[id as string]; return n })
      delete ctrls.current[id as string]
    }

    let streamed = false
    // Text deltas and tool calls land in the assistant turn's ordered `parts`
    // array (text appends to the trailing text part; tools push a new part), so
    // tool-call rows render inline between text exactly where they happened.
    // `content` is kept as the flattened text for back-compat (titles, old views).
    const appendText = (delta: string) =>
      patchThread(id as string, (t) => {
        const msgs = t.messages.slice()
        const last = msgs[msgs.length - 1] || { role: 'assistant', content: '', parts: [] }
        const parts = (last.parts || []).slice()
        const tail = parts[parts.length - 1]
        if (tail && tail.type === 'text') parts[parts.length - 1] = { ...tail, text: tail.text + delta }
        else parts.push({ type: 'text', text: delta })
        msgs[msgs.length - 1] = { ...last, role: 'assistant', content: (last.content || '') + delta, parts }
        return { messages: msgs }
      })

    const appendTool = (tool: any) =>
      patchThread(id as string, (t) => {
        const msgs = t.messages.slice()
        const last = msgs[msgs.length - 1] || { role: 'assistant', content: '', parts: [] }
        const parts = (last.parts || []).slice()
        parts.push({ type: 'tool', kind: tool.kind, title: tool.title, detail: tool.detail })
        msgs[msgs.length - 1] = { ...last, role: 'assistant', parts }
        return { messages: msgs }
      })

    ctrls.current[id] = chatStream(
      { text, history: priorMessages, model: modelSpec, provider: threadProvider },
      {
        onDelta: (d: string) => { streamed = true; setActivity(''); appendText(d) },
        onActivity: (a: string) => setActivity(a),
        onTool: (tool: any) => appendTool(tool),
        onDone: (finalText: string) => {
          if (!streamed && finalText) appendText(finalText)
          finish()
          patchThread(id as string, () => ({}), { sync: true }) // persist the settled reply
        },
        onError: (e: any) => {
          if (e instanceof AuthError) { finish(); return onAuthError() }
          appendText(`\n\n_⚠ ${e.message}_`)
          pushError(e.message)
          finish()
          patchThread(id as string, () => ({}), { sync: true })
        },
      },
    )
  }

  function send(textArg?: string) {
    sendToThread({ textArg, clearInput: () => setInput('') })
  }

  function sendQuick(textArg?: string) {
    const id = quickId || ensureQuickThread()
    sendToThread({
      textArg: typeof textArg === 'string' ? textArg : quickInput,
      id,
      clearInput: () => setQuickInput(''),
      defaultKind: 'temporary',
    })
  }

  function stopThread(id: string | null) {
    if (!id) return
    ctrls.current[id]?.abort()
    setStreaming((s) => { const n = { ...s }; delete n[id]; return n })
    setActivityById((m) => { const n = { ...m }; delete n[id]; return n })
    delete ctrls.current[id]
    patchThread(id, () => ({}), { sync: true })
  }

  function stop() {
    stopThread(activeId)
  }

  const ordered = [...threads].sort((a, b) => b.updatedAt - a.updatedAt)
  const supportsModels = providerSupportsModels(currentProvider)
  // Cursor's models take thinking/speed/context params (the gear); Codex/Claude
  // are bare model ids, so they get the dropdown but no gear.
  const supportsParams = providerDef(currentProvider)?.driver === 'cursor'
  // Honor the per-provider model list curated in the Providers tab: hidden models
  // are dropped and favorites pinned to the top.
  const providerModels = visibleModels(modelsByProvider[currentProvider])
  const multiProvider = providerInfo.providers.length > 1
  let modelSlot: React.ReactNode = null
  if (!activeTemporary) {
    if (supportsModels || multiProvider) {
      modelSlot = (
        <ModelControls
          providers={providerInfo.providers}
          currentProvider={currentProvider}
          onProviderChange={setThreadProvider}
          models={providerModels}
          supportsModels={supportsModels}
          supportsParams={supportsParams}
          settings={currentModelSettings}
          settingsOpen={settingsOpen}
          setSettingsOpen={setSettingsOpen}
          setModelSetting={setModelSetting}
        />
      )
    } else {
      modelSlot = (
        <div className="model-provider-pill" title="Provider selected in Providers">
          Provider: {providerDef(currentProvider)?.name || currentProvider || 'default'}
        </div>
      )
    }
  }
  const quickBusy = quickId ? !!streaming[quickId] : false
  const quickActivity = quickId ? activityById[quickId] || '' : ''

  const quickLayer = (
    <>
      <button className="quick-launch" onClick={ensureQuickThread} title="New temporary chat">
        <Hi icon={ChatBubbleLeftEllipsisIcon} size={18} />
        <span>Quick chat</span>
      </button>
      {quickOpen && quick && (
        <section className="quick-panel" aria-label="Quick temporary chat">
          <div className="quick-head">
            <div className="quick-title">
              <ThreadIcon thread={quick} />
              <span>{threadTitle(quick)}</span>
            </div>
            <div className="quick-actions">
              {isTemporaryThread(quick) && (
                <button className="btn compact" onClick={() => convertThread(quick.id)} title="Keep this as a regular chat">Keep</button>
              )}
              <button className="icon-btn" onClick={() => setQuickOpen(false)} title="Minimize"><Hi icon={MinusIcon} size={18} /></button>
              <button className="icon-btn" onClick={(e) => deleteThread(quick.id, e)} title="Delete"><Hi icon={TrashIcon} size={18} /></button>
            </div>
          </div>
          <div className="quick-log">
            {(quick.messages || []).map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="msg user">{m.content}</div>
              ) : (
                <div key={i} className="msg assistant">
                  <AssistantBody message={m} streaming={quickBusy && i === quick.messages.length - 1} />
                </div>
              ),
            )}
            {quickBusy && quickActivity && <div className="activity">{quickActivity}</div>}
          </div>
          <Composer
            value={quickInput}
            setValue={setQuickInput}
            onSend={sendQuick}
            busy={quickBusy}
            onStop={() => stopThread(quick.id)}
            commands={false}
            placeholder="Quick temporary chat..."
          />
        </section>
      )}
    </>
  )

  if (!visible) return quickLayer

  return (
    <div className="chat">
      <header className="chat-top">
        <button className="icon-btn" onClick={() => setDrawer(true)} title="Threads"><Hi icon={Bars3Icon} size={20} /></button>
        <div className="chat-title">
          {active && <ThreadIcon thread={active} />}
          <span>{active ? threadTitle(active) : draftKind === 'temporary' ? 'Temporary chat' : 'New chat'}</span>
        </div>
        {activeTemporary && active && (
          <button className="btn compact" onClick={() => convertThread(active.id)} title="Keep this as a regular chat">Keep</button>
        )}
        <div className="new-chat-wrap">
          <button className="icon-btn" onClick={() => setNewMenuOpen((v) => !v)} title="New chat"><Hi icon={PlusIcon} size={20} /></button>
          {newMenuOpen && (
            <div className="new-chat-menu">
              <button onClick={() => startNew('regular')}>
                <Hi icon={ChatBubbleLeftRightIcon} size={16} />
                <span>Regular chat</span>
              </button>
              <button onClick={() => startNew('temporary')}>
                <Hi icon={ChatBubbleLeftEllipsisIcon} size={16} />
                <span>Temporary chat</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {empty ? (
        <div className="hero">
          <div className="hero-inner">
            <h1 className="hero-greet">{greeting(ownerName)}</h1>
            <Composer
              value={input}
              setValue={setInput}
              onSend={send}
              busy={busy}
              onStop={stop}
              autoFocus
              centered
              belowSlot={modelSlot}
              commands={!activeTemporary}
              placeholder={activeTemporary ? 'Temporary chat...' : 'Message Totem'}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="chat-log" ref={logRef}>
            <div className="chat-log-inner">
              {messages.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} className="msg user">{m.content}</div>
                ) : (
                  <div key={i} className="msg assistant">
                    <AssistantBody message={m} streaming={busy && i === messages.length - 1} />
                  </div>
                ),
              )}
              {busy && activity && <div className="activity">{activity}</div>}
            </div>
          </div>
          <Composer
            value={input}
            setValue={setInput}
            onSend={send}
            busy={busy}
            onStop={stop}
            belowSlot={modelSlot}
            commands={!activeTemporary}
            placeholder={activeTemporary ? 'Temporary chat...' : 'Message Totem'}
          />
        </>
      )}

      {/* Threads drawer */}
      <div className={`scrim ${drawer ? 'show' : ''}`} onClick={() => setDrawer(false)} />
      <aside className={`drawer ${drawer ? 'open' : ''}`}>
        <div className="drawer-head">
          <span>Threads</span>
          <div className="drawer-new">
            <button className="btn drawer-new-btn" onClick={() => startNew('regular')}><Hi icon={PlusIcon} size={14} /> Regular</button>
            <button className="btn" onClick={() => startNew('temporary')}>Temp</button>
          </div>
        </div>
        <div className="drawer-list">
          {!ordered.length && <div className="empty" style={{ padding: 24 }}>No threads yet.</div>}
          {ordered.map((t) => (
            <button
              key={t.id}
              className={`thread-item ${t.id === activeId ? 'active' : ''}`}
              onClick={() => openThread(t.id)}
            >
              <div className="thread-title">
                {streaming[t.id] && <span className="thread-live" title="Running" />}
                <span className="thread-icon"><ThreadIcon thread={t} /></span>
                {threadTitle(t)}
              </div>
              <div className="thread-meta">
                {isTemporaryThread(t) ? 'Temporary · ' : ''}{relTime(t.updatedAt)}
              </div>
              <span className="thread-del" onClick={(e) => deleteThread(t.id, e)} title="Delete"><Hi icon={TrashIcon} size={14} /></span>
            </button>
          ))}
        </div>
      </aside>
      {quickLayer}
    </div>
  )
}
