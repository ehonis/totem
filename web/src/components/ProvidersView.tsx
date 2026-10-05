import React, { useEffect, useMemo, useState, useCallback } from 'react'
import {
  getConnections,
  setProviderConfig,
  addProviderInstance,
  removeProviderInstance,
  getChatModels,
  AuthError,
} from '../api'
import { useErrorToast } from '../toast'
import {
  Hi,
  ArrowPathIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  CheckIcon,
  ClipboardIcon,
  EyeIcon,
  EyeSlashIcon,
  StarIcon,
  StarSolidIcon,
  PlusIcon,
  TrashIcon,
  LockClosedIcon,
} from '../icons'
import UsageView from './UsageView'
import { driverLogo, driverAccent, providerInitial } from '../providers'

// The free platform default. Paid providers fall back to it on usage limits
// (mirrors FALLBACK_PROVIDER in bridge.mjs).
const FALLBACK_PROVIDER = 'opencode'

// Loosely-shaped bridge JSON.
type Model = any
type Provider = any
type Connection = any

interface ModelHandlers {
  favorite: (provider: Provider, id: string) => void
  hide: (provider: Provider, id: string) => void
  remove: (provider: Provider, id: string) => void
  add: (provider: Provider, rawId: string) => void
  move: (provider: Provider, id: string, dir: number) => void
}

function ProviderLogo({ provider, size = 16 }: { provider: Provider; size?: number }) {
  const src = driverLogo(provider)
  if (!src) return <span className="provider-logo-fallback">{providerInitial(provider)}</span>
  return <img src={src} alt="" className="provider-logo-mark" style={{ width: size, height: size }} aria-hidden="true" />
}

/**
 * The one line that tells two accounts of the same CLI apart: who is signed in,
 * and on what plan. Falls back to why it can't run when nobody is.
 */
function accountLine(p: Provider): string {
  if (!p.installed) return `${p.cli} is not on PATH`
  if (p.authenticated === false) return 'Not signed in'
  const parts = []
  if (p.account?.email) parts.push(`Authenticated as ${p.account.email}`)
  else if (p.authenticated) parts.push('Authenticated')
  else parts.push('Auth managed inside this CLI')
  if (p.account?.plan) parts.push(p.account.plan)
  else if (p.account?.organization) parts.push(p.account.organization)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// The account rail
// ---------------------------------------------------------------------------

function RailItem({ provider, active, busy, onSelect, onToggle }: {
  provider: Provider
  active: boolean
  busy: boolean
  onSelect: () => void
  onToggle: () => void
}) {
  return (
    <div
      className={`provider-rail-item ${active ? 'active' : ''} ${provider.enabled ? '' : 'off'}`}
      style={{ '--provider-accent': driverAccent(provider) } as React.CSSProperties}
    >
      <button className="provider-rail-main" onClick={onSelect} aria-current={active} title={`${provider.name} — ${accountLine(provider)}`}>
        <span className="provider-logo"><ProviderLogo provider={provider} /></span>
        <span className="provider-rail-text">
          <strong>
            {provider.name}
            {provider.default && <span className="tiny-badge default">Default</span>}
            {!provider.enabled && <span className="tiny-badge off">Off</span>}
          </strong>
          {/* Always the account, never just "Disabled": with two logins of one
              CLI in the list, the identity is the only thing that tells the
              rows apart, and a disabled account is exactly the one you're about
              to go looking for. */}
          <span>{accountLine(provider)}</span>
        </span>
      </button>
      {/* The default account is always enabled — it's what an unqualified
          request runs on, so there would be nothing left to answer with. */}
      <button
        className={`provider-switch ${provider.enabled ? 'on' : ''}`}
        disabled={provider.default || !provider.installed || busy}
        onClick={onToggle}
        title={provider.default ? 'The default account is always enabled' : provider.enabled ? 'Disable this account' : 'Enable this account'}
        aria-label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
      >
        <span />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editable fields
// ---------------------------------------------------------------------------

/**
 * A label/description on the left, a control on the right. Text edits are local
 * until blur (or Enter) so a save isn't fired per keystroke against a file the
 * bridge re-reads on every request.
 */
function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="provider-setting-row">
      <div className="provider-setting-label">
        <strong>{label}</strong>
        {hint && <span>{hint}</span>}
      </div>
      <div className="provider-setting-control">{children}</div>
    </div>
  )
}

function DraftInput({ value, placeholder, disabled, onCommit, mono = true }: {
  value: string
  placeholder?: string
  disabled?: boolean
  onCommit: (next: string) => void
  mono?: boolean
}) {
  const [draft, setDraft] = useState(value)
  // A save elsewhere (or switching account) replaces what's being shown.
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => { if (draft !== value) onCommit(draft) }
  return (
    <input
      className={`provider-input ${mono ? 'mono' : ''}`}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}

/** Copy-to-clipboard button that says so for a moment after it works. */
function CopyButton({ text, title = 'Copy' }: { text: string; title?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="model-icon-btn"
      title={title}
      aria-label={title}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        } catch { /* clipboard blocked — the text is on screen anyway */ }
      }}
    >
      <Hi icon={done ? CheckIcon : ClipboardIcon} size={15} />
    </button>
  )
}

const ACCENT_SWATCHES = ['', '#d97757', '#5b8cff', '#40c463', '#e3b341', '#f0506e', '#7c5cff', '#2dd4bf']

function AccentPicker({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (hex: string) => void }) {
  return (
    <div className="provider-accents">
      {ACCENT_SWATCHES.map((hex) => (
        <button
          key={hex || 'none'}
          className={`provider-accent ${(value || '') === hex ? 'on' : ''} ${hex ? '' : 'none'}`}
          style={hex ? { background: hex } : undefined}
          disabled={disabled}
          onClick={() => onChange(hex)}
          title={hex ? `Accent ${hex}` : 'Use the provider colour'}
          aria-label={hex ? `Accent ${hex}` : 'Default accent'}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

/**
 * Per-account environment. A variable marked sensitive is stored in the clear
 * like every other secret on this box, but the bridge stops sending its value
 * back — so an empty value here means "unchanged", not "cleared".
 */
function EnvironmentEditor({ env, saving, onChange }: {
  env: any[]
  saving: boolean
  onChange: (next: any[]) => void
}) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')

  function add(e: React.FormEvent) {
    e.preventDefault()
    const key = name.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return
    onChange([...env.filter((v) => v.name !== key), { name: key, value, sensitive: false }])
    setName('')
    setValue('')
  }

  return (
    <div className="provider-env">
      {env.length === 0 && <div className="muted provider-models-empty">No variables — the CLI inherits Totem's own environment.</div>}
      {env.map((variable) => (
        <div className="provider-env-row" key={variable.name}>
          <code className="provider-env-name">{variable.name}</code>
          <DraftInput
            value={variable.valueRedacted ? '' : variable.value}
            placeholder={variable.valueRedacted ? 'hidden — type to replace' : 'value'}
            disabled={saving}
            onCommit={(next) => onChange(env.map((v) => v.name === variable.name ? { ...v, value: next, valueRedacted: false } : v))}
          />
          <button
            className={`model-icon-btn ${variable.sensitive ? 'on' : ''}`}
            disabled={saving}
            title={variable.sensitive ? 'Sensitive: value hidden from this page' : 'Mark sensitive'}
            aria-label={variable.sensitive ? 'Unmark sensitive' : 'Mark sensitive'}
            onClick={() => onChange(env.map((v) => v.name === variable.name ? { ...v, sensitive: !v.sensitive } : v))}
          >
            <Hi icon={LockClosedIcon} size={14} />
          </button>
          <button
            className="model-icon-btn danger"
            disabled={saving}
            title="Remove variable"
            aria-label={`Remove ${variable.name}`}
            onClick={() => onChange(env.filter((v) => v.name !== variable.name))}
          >
            <Hi icon={TrashIcon} size={15} />
          </button>
        </div>
      ))}
      <form className="provider-env-add" onSubmit={add}>
        <input
          className="provider-input mono"
          placeholder="VARIABLE_NAME"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          disabled={saving}
        />
        <input
          className="provider-input mono"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={saving}
        />
        <button type="submit" className="btn compact" disabled={saving || !name.trim()}>
          <Hi icon={PlusIcon} size={15} /> Add
        </button>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

interface ModelRowProps {
  model: Model
  index: number
  count: number
  saving: boolean
  onFavorite: (id: string) => void
  onMove: (id: string, dir: number) => void
  onHide: (id: string) => void
  onRemove: (id: string) => void
}

// A single manageable model row: star (favorite/pin), reorder, and hide controls,
// mirroring the Cursor model-settings layout. Hidden models read dimmed; favorites
// show a filled star and sort to the top of the chat picker.
function ModelRow({ model, index, count, saving, onFavorite, onMove, onHide, onRemove }: ModelRowProps) {
  return (
    <div className={`model-row ${model.hidden ? 'is-hidden' : ''}`}>
      <span className="model-row-name" title={`Model id: ${model.id}`}>
        {model.name}
        {model.recommended && <span className="model-row-tag">recommended</span>}
        {model.current && <span className="model-row-tag">current</span>}
        {model.custom && <span className="model-row-tag custom">custom</span>}
      </span>
      <div className="model-row-actions">
        <button
          className={`model-icon-btn ${model.favorite ? 'on' : ''}`}
          disabled={saving}
          onClick={() => onFavorite(model.id)}
          title={model.favorite ? 'Unfavorite' : 'Favorite (pin to top)'}
          aria-label={model.favorite ? 'Unfavorite' : 'Favorite'}
        >
          <Hi icon={model.favorite ? StarSolidIcon : StarIcon} size={16} />
        </button>
        <button
          className="model-icon-btn"
          disabled={saving || index === 0}
          onClick={() => onMove(model.id, -1)}
          title="Move up"
          aria-label="Move up"
        >
          <Hi icon={ArrowUpIcon} size={16} />
        </button>
        <button
          className="model-icon-btn"
          disabled={saving || index === count - 1}
          onClick={() => onMove(model.id, 1)}
          title="Move down"
          aria-label="Move down"
        >
          <Hi icon={ArrowDownIcon} size={16} />
        </button>
        <button
          className={`model-icon-btn ${model.hidden ? 'off' : ''}`}
          disabled={saving}
          onClick={() => onHide(model.id)}
          title={model.hidden ? 'Show in chat picker' : 'Hide from chat picker'}
          aria-label={model.hidden ? 'Show model' : 'Hide model'}
        >
          <Hi icon={model.hidden ? EyeSlashIcon : EyeIcon} size={16} />
        </button>
        {model.custom && (
          <button
            className="model-icon-btn danger"
            disabled={saving}
            onClick={() => onRemove(model.id)}
            title="Remove custom model"
            aria-label="Remove model"
          >
            <Hi icon={TrashIcon} size={15} />
          </button>
        )}
      </div>
    </div>
  )
}

// Codex and Claude Code both publish a closed catalog, and the bridge drops any
// saved model outside it (see resolveModelChoice in bridge.mjs). Offering an
// "add a model id" box for them would accept a value that silently disappears on
// the next read, so say what the rule is instead.
const CLOSED_CATALOG: Record<string, string> = {
  codex: 'Codex publishes its own catalog, so this list is whatever ChatGPT serves this account — nothing else can be added or run.',
  claude: 'Claude Code has no model list command, so these are its aliases; each always resolves to the latest version of that model.',
}

interface ProviderModelsProps {
  driver: string
  models?: Model[]
  saving: boolean
  onFavorite: (id: string) => void
  onMove: (id: string, dir: number) => void
  onHide: (id: string) => void
  onRemove: (id: string) => void
  onAdd: (id: string) => void
}

// Per-account model manager: reorder, favorite, hide/show, and add custom models.
// `models` is undefined until the catalog loads. Every edit hands the full,
// reordered list back up so it can be persisted in one shot.
function ProviderModels({ driver, models, saving, onFavorite, onMove, onHide, onRemove, onAdd }: ProviderModelsProps) {
  const [draft, setDraft] = useState('')
  const count = models?.length || 0
  const visible = (models || []).filter((m) => !m.hidden).length
  const closed = CLOSED_CATALOG[driver]

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const id = draft.trim()
    if (!id) return
    onAdd(id)
    setDraft('')
  }

  return (
    <div className="provider-models">
      <div className="provider-models-head">
        <span className="provider-models-hint">
          {models === undefined ? 'Loading…' : `${count} model${count === 1 ? '' : 's'} — ${visible} shown in the chat picker.`}
        </span>
      </div>
      {models === undefined ? (
        <div className="muted provider-models-empty">Loading models…</div>
      ) : (
        <>
          <div className="model-list">
            {models.map((m, i) => (
              <ModelRow
                key={m.id}
                model={m}
                index={i}
                count={count}
                saving={saving}
                onFavorite={onFavorite}
                onMove={onMove}
                onHide={onHide}
                onRemove={onRemove}
              />
            ))}
            {!count && (
              <div className="muted provider-models-empty">
                {closed ? 'No models available — check this account is signed in.' : 'No models yet — add one below.'}
              </div>
            )}
          </div>
          {closed ? (
            <div className="muted provider-models-empty">{closed}</div>
          ) : (
            <form className="model-add" onSubmit={submit}>
              <input
                type="text"
                placeholder="Add a model id (e.g. composer-2.5)"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={saving}
              />
              <button type="submit" className="btn compact" disabled={saving || !draft.trim()}>
                <Hi icon={PlusIcon} size={15} /> Add
              </button>
            </form>
          )}
        </>
      )}
    </div>
  )
}

// The default-model picker for the default account. defaultModel may carry param
// brackets (e.g. composer-2.5[fast=true]) so the dropdown matches on the bare id.
function DefaultModelPicker({ defaultModel, models, saving, onChange }: {
  defaultModel?: string
  models: Model[]
  saving: string | null
  onChange: (model: string) => void
}) {
  const baseId = (defaultModel || '').split('[')[0]
  return (
    <select
      className="model-select"
      value={baseId}
      disabled={saving === 'defaultModel'}
      onChange={(e) => onChange(e.target.value)}
    >
      {!models.some((m) => m.id === baseId) && baseId && <option value={baseId}>{baseId}</option>}
      {!baseId && <option value="">Provider default</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>{m.name}{m.recommended ? ' (recommended)' : ''}</option>
      ))}
    </select>
  )
}

// ---------------------------------------------------------------------------
// One account's detail pane
// ---------------------------------------------------------------------------

interface DetailProps {
  provider: Provider
  saving: string | null
  models?: Model[]
  modelHandlers: ModelHandlers
  defaultModel?: string
  onChangeDefaultModel: (model: string) => void
  onPatchInstance: (patch: any) => void
  onMakeDefault: () => void
  onToggleStreaming: () => void
  onRemove: () => void
}

function ProviderDetail({
  provider, saving, models, modelHandlers, defaultModel,
  onChangeDefaultModel, onPatchInstance, onMakeDefault, onToggleStreaming, onRemove,
}: DetailProps) {
  const busy = saving === provider.id
  const isCodex = provider.driver === 'codex'
  const homeLabel = isCodex ? 'CODEX_HOME path' : 'CLAUDE_CONFIG_DIR path'
  const homeHint = isCodex
    ? 'Shared Codex home. Sessions, skills and MCP servers live here and are shared by every Codex account.'
    : 'This account\'s own config directory. What makes it a separate login — leave empty to use the CLI default.'

  // Binary path, config dirs, launch args and environment decide what runs on the
  // box; the server only accepts changes to them with TOTEM_ALLOW_UI_EXEC_CONFIG.
  const locked = provider.execConfigEditable === false

  function patchConfig(key: string, value: string) {
    onPatchInstance({ config: { ...provider.config, [key]: value } })
  }

  return (
    <div className="provider-detail-pane">
      <header className="provider-detail-head" style={{ '--provider-accent': driverAccent(provider) } as React.CSSProperties}>
        <span className="provider-logo lg"><ProviderLogo provider={provider} size={20} /></span>
        <div className="provider-detail-title">
          <strong>{provider.name}</strong>
          <span>{accountLine(provider)}</span>
        </div>
        <div className="provider-detail-badges">
          {provider.default && <span className="tiny-badge default">Default</span>}
          {provider.streaming && <span className="tiny-badge">Streaming</span>}
          <span className={`provider-led ${provider.ready ? 'ok' : ''}`} />
        </div>
      </header>

      <section className="provider-card">
        <SettingRow label="Display name" hint="What this account is called in chats, jobs and the Usage tab.">
          <DraftInput
            value={provider.name}
            placeholder={provider.cli}
            disabled={busy}
            mono={false}
            onCommit={(next) => onPatchInstance({ displayName: next })}
          />
        </SettingRow>
        <SettingRow label="Accent" hint="Colours this account's row, so two logins of one CLI are told apart at a glance.">
          <AccentPicker value={provider.accentColor} disabled={busy} onChange={(hex) => onPatchInstance({ accentColor: hex })} />
        </SettingRow>
        {/* Signing in has to happen in a terminal on this box — the CLI opens a
            browser and writes its own credentials. The command carries the home
            override; without it you would sign the *default* account in twice. */}
        <SettingRow label="Sign-in command" hint={provider.authenticated === false ? 'Run this on this machine, then re-check.' : 'Run this to sign this account in again.'}>
          <div className="provider-command">
            <code>{provider.authCommand}</code>
            <CopyButton text={provider.authCommand} title="Copy sign-in command" />
          </div>
        </SettingRow>
      </section>

      <div className="settings-section-title"><span /><strong>Runtime</strong></div>
      {locked && (
        <p className="muted provider-locked-note">
          Runtime and environment settings are read-only here. Edit data/provider-config.json on the box, or set
          TOTEM_ALLOW_UI_EXEC_CONFIG=true and restart Totem.
        </p>
      )}
      <section className="provider-card">
        <SettingRow label="Binary path" hint={`Path to the ${provider.cli} binary used by this account.`}>
          <DraftInput
            value={provider.config.binaryPath}
            placeholder={provider.binaryPath || provider.cli}
            disabled={busy || locked}
            onCommit={(next) => patchConfig('binaryPath', next)}
          />
        </SettingRow>
        {/* Only Claude and Codex read a config directory Totem can point
            somewhere else; offering the field to Cursor or OpenCode would be a
            box that silently does nothing. */}
        {provider.multiAccount && (
          <SettingRow label={homeLabel} hint={homeHint}>
            <DraftInput
              value={provider.config.homePath}
              placeholder={provider.homes.sharedHome || provider.homes.configDir || '~'}
              disabled={busy || locked}
              onCommit={(next) => patchConfig('homePath', next)}
            />
          </SettingRow>
        )}
        {isCodex && (
          <SettingRow
            label="Shadow home path"
            hint={provider.isDefaultInstance
              ? 'Optional. Leave empty and this account signs in to the shared home directly.'
              : 'This account\'s own Codex home. Keeps auth.json separate while everything else links back to the shared home.'}
          >
            <DraftInput
              value={provider.config.shadowHomePath}
              placeholder={provider.isDefaultInstance ? 'none — uses the shared home' : '~/.codex-totem/work'}
              disabled={busy || locked}
              onCommit={(next) => patchConfig('shadowHomePath', next)}
            />
          </SettingRow>
        )}
        <SettingRow label="Launch arguments" hint="Extra CLI arguments passed on every run of this account.">
          <DraftInput
            value={provider.config.launchArgs}
            placeholder="e.g. --chrome"
            disabled={busy || locked}
            onCommit={(next) => patchConfig('launchArgs', next)}
          />
        </SettingRow>
        {provider.auth?.length > 0 && (
          <SettingRow label="Credentials" hint="Where this account's login is read from.">
            <code className="provider-paths">
              {provider.auth.map((a: any) => `${a.exists ? '✓' : '—'} ${a.path.replace(/^\/home\/[^/]+/, '~')}`).join('\n')}
            </code>
          </SettingRow>
        )}
      </section>

      <div className="settings-section-title"><span /><strong>Behaviour</strong></div>
      <section className="provider-card">
        <SettingRow
          label="Default provider"
          hint={provider.default
            ? (provider.id === FALLBACK_PROVIDER
              ? 'Used by the iOS shortcut and new web chats.'
              : `Used by the iOS shortcut and new web chats. Falls back to ${FALLBACK_PROVIDER} on usage limits.`)
            : 'Make this the account unqualified requests run on.'}
        >
          <button className="btn compact" disabled={provider.default || !provider.installed || busy} onClick={onMakeDefault}>
            {provider.default ? 'Default account' : 'Make default'}
          </button>
        </SettingRow>
        {provider.supportsStreaming && (
          <SettingRow
            label="Streaming"
            hint={provider.streaming
              ? 'Tokens and tool activity appear live in web chat.'
              : 'Replies arrive in one block when finished.'}
          >
            <button
              className={`provider-switch ${provider.streaming ? 'on' : ''}`}
              disabled={!provider.installed || busy}
              onClick={onToggleStreaming}
              aria-label={`${provider.streaming ? 'Disable' : 'Enable'} streaming for ${provider.name}`}
            >
              <span />
            </button>
          </SettingRow>
        )}
        {provider.default && provider.supportsModelPicker && (
          <SettingRow label="Default model" hint="What runs when a request names no model.">
            <DefaultModelPicker defaultModel={defaultModel} models={models || []} saving={saving} onChange={onChangeDefaultModel} />
          </SettingRow>
        )}
        {!provider.isDefaultInstance && (
          <SettingRow
            label="Remove account"
            hint={provider.default
              ? 'This is the default provider — make another account the default first.'
              : 'Forgets this account here. Its config directory and login are left on disk.'}
          >
            <button className="btn compact danger" disabled={busy || provider.default} onClick={onRemove}>
              <Hi icon={TrashIcon} size={15} /> Remove
            </button>
          </SettingRow>
        )}
      </section>

      <div className="settings-section-title"><span /><strong>Environment</strong></div>
      <section className="provider-card">
        <EnvironmentEditor
          env={provider.env || []}
          saving={busy || locked}
          onChange={(next) => onPatchInstance({ env: next })}
        />
      </section>

      {provider.supportsModelPicker && (
        <>
          <div className="settings-section-title"><span /><strong>Models</strong></div>
          <section className="provider-card">
            <ProviderModels
              driver={provider.driver}
              models={models}
              saving={saving === `models:${provider.id}`}
              onFavorite={(id) => modelHandlers.favorite(provider, id)}
              onMove={(id, dir) => modelHandlers.move(provider, id, dir)}
              onHide={(id) => modelHandlers.hide(provider, id)}
              onRemove={(id) => modelHandlers.remove(provider, id)}
              onAdd={(id) => modelHandlers.add(provider, id)}
            />
          </section>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface ProvidersViewProps {
  onAuthError: () => void
  /** URL hash section to scroll to once loaded — 'usage' today. */
  scrollTo?: string
}

export default function ProvidersView({ onAuthError, scrollTo }: ProvidersViewProps) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useErrorToast(error)
  const [saving, setSaving] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // Model catalogs are fetched lazily per account (on first view) and cached here
  // so the model list and the default-model picker share one source.
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, Model[]>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await getConnections()
      setData(next)
      setSelected((current) => {
        if (current && next.providers?.some((p: Provider) => p.id === current)) return current
        return next.providers?.find((p: Provider) => p.default)?.id || next.providers?.[0]?.id || null
      })
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [onAuthError])

  useEffect(() => { load() }, [load])

  const providers: Provider[] = data?.providers || []
  const drivers = data?.drivers || []
  const current = providers.find((p) => p.id === selected) || providers[0] || null

  // Lazily fetch an account's model catalog the first time it's needed (its pane
  // is open, or it's the default account so the default-model picker has options).
  const ensureModels = useCallback((providerId: string) => {
    if (!providerId || modelCatalogs[providerId]) return
    getChatModels(providerId)
      .then((info) => setModelCatalogs((c) => ({ ...c, [providerId]: info.models || [] })))
      .catch(() => setModelCatalogs((c) => ({ ...c, [providerId]: [] })))
  }, [modelCatalogs])

  useEffect(() => {
    if (current?.supportsModelPicker) ensureModels(current.id)
  }, [current?.id, current?.supportsModelPicker, ensureModels])

  const apply = useCallback(async (key: string, patch: any) => {
    setSaving(key)
    setError(null)
    try {
      const next = await setProviderConfig(patch)
      setData(next)
      return next
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      setError(e.message)
    } finally {
      setSaving(null)
    }
  }, [onAuthError])

  function makeDefault(provider: Provider) {
    if (provider.default || !provider.installed) return
    // opencode is the free platform default. Setting a paid account (cursor /
    // codex / claude) as default means it can hit usage limits — warn that we
    // automatically fall back to opencode when that happens.
    if (provider.id !== FALLBACK_PROVIDER) {
      const ok = window.confirm(
        `${provider.name} has usage limits. When it hits a limit, requests will automatically fall back to ${FALLBACK_PROVIDER} (the free platform default).\n\nMake ${provider.name} the default provider?`,
      )
      if (!ok) return
    }
    apply(provider.id, { defaultProvider: provider.id })
  }

  function toggleEnabled(provider: Provider) {
    if (provider.default || !provider.installed) return
    const currentEnabled = providers.filter((p) => p.enabled).map((p) => p.id)
    const nextEnabled = provider.enabled
      ? currentEnabled.filter((id) => id !== provider.id)
      : [...currentEnabled, provider.id]
    apply(provider.id, { enabledProviders: nextEnabled })
  }

  function toggleStreaming(provider: Provider) {
    if (!provider.supportsStreaming || !provider.installed) return
    apply(provider.id, { streaming: { [provider.id]: !provider.streaming } })
  }

  function patchInstance(provider: Provider, patch: any) {
    apply(provider.id, { instances: { [provider.id]: patch } })
  }

  function changeDefaultModel(model: string) {
    apply('defaultModel', { defaultModel: model })
  }

  // Adding an account only needs a name: the bridge fills in a config directory
  // (and, for Codex, a shadow home) that can't collide with an existing login.
  async function addAccount(driver: any) {
    const name = window.prompt(`Name this ${driver.name} account (e.g. Work)`, 'Work')
    if (name === null) return
    setSaving(`add:${driver.driver}`)
    setError(null)
    try {
      const next = await addProviderInstance({ driver: driver.driver, displayName: name.trim() || 'Work' })
      setData(next)
      if (next.created) setSelected(next.created)
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      setError(e.message)
    } finally {
      setSaving(null)
    }
  }

  async function removeAccount(provider: Provider) {
    const ok = window.confirm(
      `Remove ${provider.name}?\n\nTotem forgets the account. Its config directory and its login stay on disk, so adding it back is just a matter of pointing at the same path.`,
    )
    if (!ok) return
    setSaving(provider.id)
    setError(null)
    try {
      const next = await removeProviderInstance(provider.id)
      setData(next)
      setSelected(next.providers?.find((p: Provider) => p.default)?.id || null)
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      setError(e.message)
    } finally {
      setSaving(null)
    }
  }

  // Persist an account's full curated model list, then refresh that account's
  // merged catalog so the UI reflects the saved order/flags. We always send the
  // entire list (not a diff) so order is authoritative.
  const saveModels = useCallback(async (provider: Provider, nextModels: Model[]) => {
    const entries = nextModels.map((m) => {
      const e: any = { id: m.id }
      if (m.hidden) e.hidden = true
      if (m.favorite) e.favorite = true
      return e
    })
    setSaving(`models:${provider.id}`)
    setError(null)
    try {
      const next = await setProviderConfig({ models: { [provider.id]: entries } })
      setData(next)
      const info = await getChatModels(provider.id)
      setModelCatalogs((c) => ({ ...c, [provider.id]: info.models || [] }))
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      setError(e.message)
    } finally {
      setSaving(null)
    }
  }, [onAuthError])

  // Each handler derives the next list from the currently-displayed catalog and
  // hands it to saveModels. `move` swaps within the array; `favorite`/`hide` flip
  // a flag; `add` appends a custom id; `remove` drops a custom entry.
  const modelHandlers: ModelHandlers = useMemo(() => ({
    favorite(provider, id) {
      const list = (modelCatalogs[provider.id] || []).map((m) => m.id === id ? { ...m, favorite: !m.favorite } : m)
      saveModels(provider, list)
    },
    hide(provider, id) {
      const list = (modelCatalogs[provider.id] || []).map((m) => m.id === id ? { ...m, hidden: !m.hidden } : m)
      saveModels(provider, list)
    },
    remove(provider, id) {
      const list = (modelCatalogs[provider.id] || []).filter((m) => m.id !== id)
      saveModels(provider, list)
    },
    add(provider, rawId) {
      const id = rawId.trim()
      const list = modelCatalogs[provider.id] || []
      if (!id || list.some((m) => m.id === id)) return
      saveModels(provider, [...list, { id, name: id, custom: true }])
    },
    move(provider, id, dir) {
      const list = (modelCatalogs[provider.id] || []).slice()
      const i = list.findIndex((m) => m.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= list.length) return
      ;[list[i], list[j]] = [list[j], list[i]]
      saveModels(provider, list)
    },
  }), [modelCatalogs, saveModels])

  return (
    <div className="view connections-view">
      <div className="settings-shell">
        <header className="settings-top">
          <div>
            <h1>Providers</h1>
            <p>The accounts Totem runs agents on. Claude and Codex can hold several logins, each with its own config directory, models and quota.</p>
          </div>
          <div className="settings-actions">
            {data?.generatedAt && <span>Checked {new Date(data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
            <button className="icon-btn small" onClick={load} title="Refresh"><Hi icon={ArrowPathIcon} size={16} /></button>
          </div>
        </header>

        {loading && !data ? (
          <div className="spinner">Loading...</div>
        ) : (
          <>
            <div className="provider-workbench">
              <aside className="provider-rail">
                {providers.map((p) => (
                  <RailItem
                    key={p.id}
                    provider={p}
                    active={current?.id === p.id}
                    busy={saving === p.id}
                    onSelect={() => setSelected(p.id)}
                    onToggle={() => toggleEnabled(p)}
                  />
                ))}
                <div className="provider-rail-add">
                  {drivers.filter((d: any) => d.multiAccount).map((d: any) => (
                    <button
                      key={d.driver}
                      className="btn compact"
                      disabled={saving === `add:${d.driver}`}
                      onClick={() => addAccount(d)}
                      title={`Add another ${d.name} account`}
                    >
                      <Hi icon={PlusIcon} size={14} /> {d.name}
                    </button>
                  ))}
                </div>
              </aside>

              {current ? (
                <ProviderDetail
                  provider={current}
                  saving={saving}
                  models={modelCatalogs[current.id]}
                  modelHandlers={modelHandlers}
                  defaultModel={data?.defaultModel}
                  onChangeDefaultModel={changeDefaultModel}
                  onPatchInstance={(patch) => patchInstance(current, patch)}
                  onMakeDefault={() => makeDefault(current)}
                  onToggleStreaming={() => toggleStreaming(current)}
                  onRemove={() => removeAccount(current)}
                />
              ) : (
                <div className="provider-detail-pane muted">No providers found on this box.</div>
              )}
            </div>

            <UsageView embedded onAuthError={onAuthError} scrollIntoView={scrollTo === 'usage'} />
          </>
        )}
      </div>
    </div>
  )
}
