import React, { useEffect, useState, useCallback } from 'react'
import {
  getMcpSettings, getMcpCatalog, addMcpConnection, toggleMcpConnection,
  removeMcpConnection, relayMcpCallback,
  setMcpMode, getGatewayStatus, startGatewayOAuth, resetGatewayOAuth, AuthError,
  getCalendarAccounts, renameCalendarAccount, removeCalendarAccount, startCalendarAccountAuth,
} from '../api'
import { Hi, ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon, TrashIcon, WrenchScrewdriverIcon, ChevronDownIcon, BoltIcon } from '../icons'
import DataConnectionsPanel from './DataConnectionsPanel'
import { WhoopConnectionPanel } from './WhoopConnection'
import { useErrorToast } from '../toast'
import {
  siLinear, siNotion, siAsana, siAtlassian, siGithub, siSentry, siVercel,
  siIntercom, siStripe, siPaypal, siAirtable, siHuggingface, siActualbudget,
} from 'simple-icons'
import googleCalendarIcon from '../assets/connection-icons/google-calendar.svg'
import plaudIcon from '../assets/connection-icons/plaud.png'
import slackIcon from '../assets/connection-icons/slack.svg'
import canvaIcon from '../assets/connection-icons/canva.svg'

const PROVIDER_ORDER = ['cursor', 'codex', 'claude', 'opencode']

// Connections with a full-colour bundled logo (multi-tone marks simple-icons
// doesn't carry, or brands it has dropped on trademark request).
const CONNECTION_ICONS: Record<string, string> = {
  'google-calendar': googleCalendarIcon,
  plaud: plaudIcon,
  slack: slackIcon,
  canva: canvaIcon,
}

// Single-colour brand glyphs from simple-icons, drawn in the brand's own hue on
// the white icon chip. Keyed by catalog id; everything else falls back to a
// letter avatar.
const CONNECTION_GLYPHS: Record<string, any> = {
  linear: siLinear,
  notion: siNotion,
  asana: siAsana,
  atlassian: siAtlassian,
  github: siGithub,
  sentry: siSentry,
  vercel: siVercel,
  intercom: siIntercom,
  stripe: siStripe,
  paypal: siPaypal,
  airtable: siAirtable,
  huggingface: siHuggingface,
  actual: siActualbudget,
}

// Deterministic accent per id so letter-avatar fallbacks read as distinct
// brands without bundling a logo for every catalog entry.
function accentFor(id = '') {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return `hsl(${h} 55% 45%)`
}

function authBadge(auth: string) {
  if (auth === 'oauth') return 'OAuth'
  if (auth === 'apikey') return 'API key'
  if (auth === 'open') return 'No auth'
  if (auth === 'advanced') return 'Setup'
  return ''
}

function isRemote(app: any) {
  return app.transport === 'remote' || app.transport === 'http'
}

// A bundled logo wins; otherwise draw the simple-icons glyph in the brand hue.
// Very light brand colours (e.g. Intercom cyan, Hugging Face yellow) wash out on
// the white chip, so clamp those to a readable dark ink.
function glyphColor(hex: string) {
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.7 ? '#1c1d22' : `#${hex}`
}

interface ConnectionIconProps {
  id: string
  name?: string
  size?: number
}

function ConnectionIcon({ id, name, size = 34 }: ConnectionIconProps) {
  const src = CONNECTION_ICONS[id]
  const glyph = !src ? CONNECTION_GLYPHS[id] : null
  const fallback = !src && !glyph
  return (
    <span
      className={`connection-icon ${fallback ? 'fallback' : ''}`}
      style={{ width: size, height: size, ...(fallback ? { background: accentFor(id) } : {}) }}
    >
      {src ? (
        <img src={src} alt="" aria-hidden="true" />
      ) : glyph ? (
        <svg viewBox="0 0 24 24" role="img" aria-hidden="true" fill={glyphColor(glyph.hex)} width={Math.round(size * 0.68)} height={Math.round(size * 0.68)}>
          <path d={glyph.path} />
        </svg>
      ) : (
        (name || id || '?').slice(0, 1).toUpperCase()
      )}
    </span>
  )
}

// Gateway mode shows a single status per connection - its health *at the gateway*,
// which is what every provider now sees. ok → live with a tool count; needsAuth →
// the gateway still needs to sign in; otherwise pending/not yet probed.
function gatewayHealthClass(health: any) {
  if (!health) return 'checking'
  if (health.ok) return 'active'
  if (health.needsAuth) return 'warn'
  return 'missing'
}

interface GatewayConnStatusProps {
  health: any
  loading?: boolean
}

function GatewayConnStatus({ health, loading }: GatewayConnStatusProps) {
  const cls = gatewayHealthClass(health)
  let label = loading ? 'Checking…' : 'Pending'
  if (health?.ok) label = `Live · ${health.toolCount} tool${health.toolCount === 1 ? '' : 's'}`
  else if (health?.needsAuth) label = 'Needs auth at gateway'
  else if (health && !health.ok) label = health.error ? `Error: ${health.error}` : 'Not connected'
  return (
    <div className={`gateway-conn-status ${cls}`}>
      <span className="gateway-conn-dot" />
      <span className="gateway-conn-text">
        <strong>Totem Gateway</strong>
        <em>{label}</em>
      </span>
      <span className="gateway-conn-note">All providers route through here</span>
    </div>
  )
}

const EMPTY_CUSTOM = { id: '', name: '', transport: 'http', url: '', command: '', args: '', env: '', headers: '' }

// Parse "KEY=value" lines into a {key,value}[] list for env/header inputs.
function parsePairs(text = '') {
  return text.split('\n').map((line) => {
    const i = line.indexOf('=')
    if (i < 0) return null
    return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() }
  }).filter((p) => p && p.key)
}

interface ConnectFormProps {
  app: any
  busy?: boolean
  onAdd: (app: any, values: any) => void
}

// Inline form to enable a catalog app (endpoint URL + any required secret fields).
function ConnectForm({ app, busy, onAdd }: ConnectFormProps) {
  const [values, setValues] = useState<any>(() => ({ url: app.url || '' }))
  function submit(e: React.FormEvent) {
    e.preventDefault()
    onAdd(app, values)
  }
  return (
    <form className="catalog-form" onSubmit={submit}>
      {isRemote(app) && (
        <label className="catalog-field">
          <span>Endpoint URL</span>
          <input value={values.url || ''} onChange={(e) => setValues((v: any) => ({ ...v, url: e.target.value }))} />
        </label>
      )}
      {(app.fields || []).map((f: any) => (
        <label className="catalog-field" key={f.key}>
          <span>{f.label}</span>
          <input
            type={f.secret ? 'password' : 'text'}
            autoComplete="off"
            placeholder={f.placeholder || ''}
            value={values[f.key] || ''}
            onChange={(e) => setValues((v: any) => ({ ...v, [f.key]: e.target.value }))}
          />
          {f.help && <em>{f.help}</em>}
        </label>
      ))}
      <button type="submit" className="btn compact primary" disabled={busy}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  )
}

interface GoogleAccountsPanelProps {
  onAuthError: () => void
}

// Manage the Google accounts saved for the Calendar connection: see each login's
// real email, rename its label, disconnect it, or add another via Google sign-in.
// Lives inside the Google Calendar row; loads the account list when first shown.
function GoogleAccountsPanel({ onAuthError }: GoogleAccountsPanelProps) {
  const [accounts, setAccounts] = useState<any[] | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})       // label -> draft label
  const [newLabel, setNewLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')          // label (or '__add__') being mutated
  const [err, setErr] = useState('')
  const [authMsg, setAuthMsg] = useState<any>(null)  // { label, authUrl } after starting OAuth

  const apply = useCallback((list: any[]) => {
    setAccounts(list)
    setEdits(Object.fromEntries(list.map((a) => [a.label, a.label])))
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try { apply((await getCalendarAccounts()).accounts) }
    catch (e: any) { if (e instanceof AuthError) return onAuthError?.(); setErr(e.message || 'Failed to load accounts') }
    finally { setLoading(false) }
  }, [apply, onAuthError])

  useEffect(() => { load() }, [load])

  async function run(label: string, fn: () => Promise<any>) {
    setBusy(label); setErr('')
    try { apply((await fn()).accounts) }
    catch (e: any) { if (e instanceof AuthError) return onAuthError?.(); setErr(e.message || 'Something went wrong') }
    finally { setBusy('') }
  }

  function doRename(label: string) {
    const to = (edits[label] || '').trim()
    if (!to || to === label) return
    return run(label, () => renameCalendarAccount(label, to))
  }

  function doRemove(label: string) {
    if (!window.confirm(`Disconnect Google account "${label}"? Its calendar stops syncing here.`)) return
    return run(label, () => removeCalendarAccount(label))
  }

  async function doAdd(e: React.FormEvent) {
    e.preventDefault()
    const label = newLabel.trim()
    if (!label) return
    setBusy('__add__'); setErr('')
    try {
      const res = await startCalendarAccountAuth(label)
      window.open(res.authUrl, '_blank', 'noopener')
      setAuthMsg({ label, authUrl: res.authUrl })
      setNewLabel('')
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError?.()
      setErr(e.message || 'Could not start sign-in')
    } finally { setBusy('') }
  }

  return (
    <div className="gcal-accounts">
      <div className="gcal-accounts-head">
        <strong>Signed-in Google accounts</strong>
        <button className="icon-btn small" disabled={loading || Boolean(busy)} onClick={load} title="Refresh accounts">
          <Hi icon={ArrowPathIcon} size={14} />
        </button>
      </div>

      {loading && !accounts ? (
        <div className="app-row-loading">Loading accounts…</div>
      ) : (
        <div className="gcal-account-list">
          {accounts?.length ? accounts.map((a, index) => (
            <div className="gcal-account-row" key={a.label}>
              <span className={`gcal-acct-dot acct-${index % 4} ${a.status === 'error' ? 'bad' : ''}`} />
              <div className="gcal-account-fields">
                <input
                  className="gcal-label-input"
                  value={edits[a.label] ?? a.label}
                  disabled={busy === a.label}
                  onChange={(e) => setEdits((m) => ({ ...m, [a.label]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') doRename(a.label) }}
                  aria-label={`Label for ${a.email || a.label}`}
                />
                <span className="gcal-acct-email" title={a.error || a.email}>
                  {a.status === 'error' ? (a.error || 'Token error - re-add this account') : (a.email || 'resolving…')}
                </span>
              </div>
              {(edits[a.label] ?? a.label).trim() !== a.label && (edits[a.label] ?? '').trim() && (
                <button className="btn compact" disabled={busy === a.label} onClick={() => doRename(a.label)}>Save</button>
              )}
              <button className="icon-btn small danger" disabled={busy === a.label} onClick={() => doRemove(a.label)} title="Disconnect this account">
                <Hi icon={TrashIcon} size={14} />
              </button>
            </div>
          )) : <p className="app-row-hint">No Google accounts connected yet. Add one below.</p>}
        </div>
      )}

      {authMsg && (
        <div className="gcal-auth-note">
          A Google sign-in tab opened for <strong>{authMsg.label}</strong>. Finish there, then hit refresh.
          <br />On your phone? Open <code>{authMsg.authUrl}</code> and swap <code>localhost</code> for this box's Tailscale host.
        </div>
      )}

      <form className="gcal-add-form" onSubmit={doAdd}>
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label for the new account (e.g. work)"
          aria-label="New account label"
        />
        <button type="submit" className="btn compact primary" disabled={busy === '__add__' || !newLabel.trim()}>
          {busy === '__add__' ? 'Opening…' : 'Add account'}
        </button>
      </form>

      {err && <div className="error settings-error">{err}</div>}
    </div>
  )
}

interface AppRowProps {
  app: any
  busy?: boolean
  expanded?: boolean
  gatewayHealth?: any
  gatewayLoading?: boolean
  busyAuth?: boolean
  onToggleExpand: () => void
  onAdd: (app: any, values: any) => void
  onToggle: (app: any, enabled: boolean) => void
  onRemove: (app: any) => void
  onAuthenticate: (id: string) => void
  onDeauth: (id: string) => void
  onAuthError: () => void
}

// One collapsible row per app. Connections are served through the gateway, so the
// single gateway probe covers every row's health — no per-provider work.
function AppRow({ app, busy, expanded, gatewayHealth, gatewayLoading, busyAuth, onToggleExpand, onAdd, onToggle, onRemove, onAuthenticate, onDeauth, onAuthError }: AppRowProps) {
  const installed = app.installed
  const enabled = installed && app.enabled !== false

  return (
    <section className={`app-row ${expanded ? 'open' : ''} ${installed && !enabled ? 'disabled' : ''}`}>
      <button className="app-row-head" onClick={onToggleExpand} aria-expanded={expanded}>
        <ConnectionIcon id={app.id} name={app.name} size={30} />
        <span className="app-row-title">
          <strong>{app.name}</strong>
          <span>{app.category}{app.custom ? ' · custom' : ''}</span>
        </span>
        <span className="app-row-status">
          {installed
            ? <span className={`app-row-chip ${gatewayHealth?.ok ? 'on' : (gatewayHealth?.needsAuth ? 'warn' : '')}`}>
                {!enabled ? 'Disabled' : gatewayHealth?.ok ? `${gatewayHealth.toolCount} tools` : gatewayHealth?.needsAuth ? 'Needs auth' : 'Pending'}
              </span>
            : <span className="catalog-badge">{authBadge(app.auth) || 'Add'}</span>}
        </span>
        <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${expanded ? 'up' : ''}`} />
      </button>

      {expanded && (
        <div className="app-row-body">
          {installed ? (
            <>
              <div className="app-row-controls">
                <button
                  className={`provider-switch ${enabled ? 'on' : ''}`}
                  disabled={busy}
                  onClick={() => onToggle(app, !enabled)}
                  title={enabled ? 'Disable everywhere' : 'Enable everywhere'}
                  aria-label={`${enabled ? 'Disable' : 'Enable'} ${app.name}`}
                >
                  <span />
                </button>
                <span className="app-row-controls-label">
                  {enabled ? 'Enabled · served through MCP' : 'Disabled'}
                </span>
                <button className="icon-btn small danger" disabled={busy} onClick={() => onRemove(app)} title="Remove connection">
                  <Hi icon={TrashIcon} size={14} />
                </button>
              </div>
              <div className="connection-meta">
                <code>{app.url || `${app.command || ''}${app.package ? ` ${app.package}` : ''}`}</code>
                {app.envKeys?.length ? <code>Env: {app.envKeys.join(', ')}</code> : null}
                {app.headerKeys?.length ? <code>Headers: {app.headerKeys.join(', ')}</code> : null}
              </div>
              {app.id === 'google-calendar' && <GoogleAccountsPanel onAuthError={onAuthError} />}
              {isRemote(app) && (
                <p className="app-row-hint">Remote app - sign in once here and the gateway holds the token for every provider. The callback lands on this box, so you can finish from your phone over Tailscale.</p>
              )}
              <GatewayConnStatus health={enabled ? gatewayHealth : null} loading={gatewayLoading} />
              {isRemote(app) && enabled && (
                <div className="gateway-auth-row">
                  {gatewayHealth?.ok ? (
                    <>
                      <button className="btn compact" disabled={busyAuth} onClick={() => onAuthenticate(app.id)}>Re-authenticate</button>
                      <button className="btn compact danger" disabled={busyAuth} onClick={() => onDeauth(app.id)}>Sign out</button>
                    </>
                  ) : (
                    <button className="btn compact primary" disabled={busyAuth} onClick={() => onAuthenticate(app.id)}>
                      {busyAuth ? 'Starting…' : 'Authenticate'}
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <p className="app-row-desc">{app.description}</p>
              <ConnectForm app={app} busy={busy} onAdd={onAdd} />
            </>
          )}
        </div>
      )}
    </section>
  )
}

interface CustomConnectionFormProps {
  busy?: boolean
  onAdd: (custom: any, onDone: () => void) => void
}

function CustomConnectionForm({ busy, onAdd }: CustomConnectionFormProps) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_CUSTOM)
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const custom = {
      id: form.id.trim(),
      name: form.name.trim() || form.id.trim(),
      transport: form.transport,
      url: form.transport === 'http' ? form.url.trim() : '',
      command: form.transport === 'stdio' ? form.command.trim() : '',
      args: form.args.trim(),
      env: parsePairs(form.env),
      headers: parsePairs(form.headers),
    }
    onAdd(custom, () => { setForm(EMPTY_CUSTOM); setOpen(false) })
  }

  return (
    <section className={`app-row custom-row ${open ? 'open' : ''}`}>
      <button className="app-row-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="connection-icon fallback" style={{ width: 30, height: 30, background: '#5b8cff', color: '#fff' }}>
          <Hi icon={WrenchScrewdriverIcon} size={15} />
        </span>
        <span className="app-row-title">
          <strong>Custom MCP server</strong>
          <span>Any URL or local command</span>
        </span>
        <span className="app-row-status"><span className="catalog-badge">Custom</span></span>
        <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${open ? 'up' : ''}`} />
      </button>
      {open && (
        <div className="app-row-body">
          <form className="catalog-form" onSubmit={submit}>
            <label className="catalog-field">
              <span>ID</span>
              <input value={form.id} onChange={set('id')} placeholder="my-server" />
              <em>Letters, numbers, dash, underscore. Used as the MCP server name.</em>
            </label>
            <label className="catalog-field">
              <span>Display name</span>
              <input value={form.name} onChange={set('name')} placeholder="My Server" />
            </label>
            <label className="catalog-field">
              <span>Transport</span>
              <select className="model-select" value={form.transport} onChange={set('transport')}>
                <option value="http">Remote (HTTP / SSE)</option>
                <option value="stdio">Local (stdio command)</option>
              </select>
            </label>
            {form.transport === 'http' ? (
              <label className="catalog-field">
                <span>Endpoint URL</span>
                <input value={form.url} onChange={set('url')} placeholder="https://mcp.example.com/mcp" />
              </label>
            ) : (
              <>
                <label className="catalog-field">
                  <span>Command</span>
                  <input value={form.command} onChange={set('command')} placeholder="npx" />
                </label>
                <label className="catalog-field">
                  <span>Arguments</span>
                  <input value={form.args} onChange={set('args')} placeholder="-y @scope/mcp-server" />
                </label>
              </>
            )}
            <label className="catalog-field">
              <span>{form.transport === 'http' ? 'Headers' : 'Environment'} (KEY=value per line)</span>
              <textarea
                rows={3}
                value={form.transport === 'http' ? form.headers : form.env}
                onChange={set(form.transport === 'http' ? 'headers' : 'env')}
                placeholder={form.transport === 'http' ? 'Authorization=Bearer …' : 'API_KEY=…'}
              />
            </label>
            <button type="submit" className="btn compact primary" disabled={busy || !form.id.trim()}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </form>
        </div>
      )}
    </section>
  )
}

interface GatewayServerChipProps {
  server: any
}

// The hub card: the master MCP switch, and (when on) live gateway health - which
// downstream apps connected and how many tools each contributes to the single
// aggregated toolset every provider now sees.
function GatewayServerChip({ server }: GatewayServerChipProps) {
  const cls = server.ok ? 'ok' : (server.needsAuth ? 'warn' : 'bad')
  const label = server.ok ? `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}` : (server.needsAuth ? 'Needs auth' : 'Error')
  return (
    <div className={`gw-chip ${cls}`} title={server.error || label}>
      <ConnectionIcon id={server.id} name={server.id} size={22} />
      <span className="gw-chip-text">
        <strong>{server.id}</strong>
        <em>{label}</em>
      </span>
    </div>
  )
}

interface GatewayPanelProps {
  mode?: string
  status?: any
  loading?: boolean
  busy?: boolean
  onToggle: (mode: string) => void
  onRefresh: () => void
}

function GatewayPanel({ mode, status, loading, busy, onToggle, onRefresh }: GatewayPanelProps) {
  const on = mode === 'gateway'
  const servers = status?.servers || []
  const connected = servers.filter((s: any) => s.ok).length
  return (
    <section className={`gateway-panel ${on ? 'on' : 'off'}`}>
      <div className="gateway-head">
        <span className="gateway-badge"><Hi icon={BoltIcon} size={20} /></span>
        <div className="gateway-headtext">
          <strong>MCP</strong>
          <span>
            {on
              ? 'Every provider connects to one aggregator server. Enable an app once and all your models can use it - no per-provider wiring or per-provider sign-in.'
              : 'MCP is off - no models can reach your connected apps. Turn it on to route every provider through a single connection you manage in one place.'}
          </span>
        </div>
        <button
          className={`provider-switch big ${on ? 'on' : ''}`}
          disabled={busy}
          onClick={() => onToggle(on ? 'off' : 'gateway')}
          title={on ? 'Turn MCP off everywhere' : 'Turn MCP on for every provider'}
          aria-label="Toggle MCP"
        >
          <span />
        </button>
      </div>
      {on && (
        <div className="gateway-body">
          <div className="gateway-stats">
            <div><strong>{status ? connected : '-'}</strong><span>apps live</span></div>
            <div><strong>{status?.totalTools ?? '-'}</strong><span>tools exposed</span></div>
            <div className="gateway-stats-spacer" />
            <button className="icon-btn small" disabled={loading} onClick={onRefresh} title="Re-probe the gateway">
              <Hi icon={ArrowPathIcon} size={14} />
            </button>
          </div>
          {loading && !status ? (
            <div className="app-row-loading">Probing the gateway…</div>
          ) : (
            <div className="gateway-grid">
              {servers.map((s: any) => <GatewayServerChip key={s.id} server={s} />)}
              {!servers.length && <span className="gw-empty">No connections yet - add one below and it appears here.</span>}
            </div>
          )}
          {status && status.ok === false && <div className="error settings-error">{status.error || 'Gateway probe failed'}</div>}
        </div>
      )}
    </section>
  )
}

interface ActionPanelProps {
  result: any
  onDismiss: () => void
  onRefresh: () => void
  onRelay: (callbackUrl: string) => void
  relaying?: boolean
}

function ActionPanel({ result, onDismiss, onRefresh, onRelay, relaying }: ActionPanelProps) {
  const [callbackUrl, setCallbackUrl] = useState('')
  if (!result) return null
  const canOpen = Boolean(result.authUrl)
  const needsRelay = Boolean(result.callback?.local)
  return (
    <div className={`mcp-action-panel ${result.ok ? 'ok' : 'bad'}`}>
      <Hi icon={result.ok ? CheckCircleIcon : ExclamationTriangleIcon} size={17} />
      <div>
        <strong>{result.provider} / {result.id}</strong>
        <span>{result.message}</span>
        {canOpen && <code>{result.authUrl}</code>}
        {needsRelay && (
          <div className="mcp-callback-helper">
            <strong>Phone callback helper</strong>
            <span>
              If the auth page lands on a failed localhost, 127.0.0.1, or Tailscale callback, paste that full browser URL here.
              Totem will replay it from this Linux box.
            </span>
            <div className="mcp-callback-row">
              <input value={callbackUrl} onChange={(e) => setCallbackUrl(e.target.value)} placeholder="http://127.0.0.1:PORT/callback/..." />
              <button className="btn compact" disabled={relaying || !callbackUrl.trim()} onClick={() => onRelay(callbackUrl)}>
                {relaying ? 'Completing...' : 'Complete auth'}
              </button>
            </div>
          </div>
        )}
        {result.output && <details><summary>Command output</summary><pre>{result.output}</pre></details>}
      </div>
      <div className="mcp-action-buttons">
        {canOpen && (
          <button className="btn compact primary" onClick={() => window.open(result.authUrl, '_blank', 'noopener,noreferrer')}>
            Open auth page
          </button>
        )}
        <button className="btn compact" onClick={onRefresh}>Refresh</button>
        <button className="icon-btn small" onClick={onDismiss} title="Dismiss">×</button>
      </div>
    </div>
  )
}

interface GatewayAuthPanelProps {
  session: any
  busy?: boolean
  onCreds: (id: string, clientId: string, clientSecret: string) => void
  onCancel: () => void
}

// Walks you through signing a remote app into the gateway from anywhere. Three
// states: collect manually-registered client creds (only when a service can't
// self-register), show the auth link + Tailscale host-swap instructions, and the
// done confirmation once the polling sees the token land.
function GatewayAuthPanel({ session, busy, onCreds, onCancel }: GatewayAuthPanelProps) {
  const [cid, setCid] = useState('')
  const [csec, setCsec] = useState('')
  useEffect(() => { setCid(''); setCsec('') }, [session?.id, session?.needsCreds])
  // Escape closes the dialog; lock background scroll while it's open.
  useEffect(() => {
    if (!session) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [session, onCancel])
  if (!session) return null
  const dashHost = typeof window !== 'undefined' ? window.location.host : ''
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="gateway-auth-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="gw-modal-title">
            <span className={`gateway-badge ${session.done ? 'done' : ''}`}>
              <Hi icon={session.done ? CheckCircleIcon : BoltIcon} size={18} />
            </span>
            <div>
              <div className="modal-kicker">Gateway sign-in</div>
              <h2>Authenticate {session.id}</h2>
            </div>
          </div>
          <button className="icon-btn small" onClick={onCancel} title="Close" aria-label="Close">×</button>
        </div>

        {session.done ? (
          <p className="gw-modal-done">Signed in. The gateway holds the token now, so every provider can use {session.id} - no per-provider login.</p>
        ) : session.needsCreds ? (
          <div className="mcp-callback-helper">
            <span>{session.message}</span>
            <strong>Paste the OAuth app credentials</strong>
            <span>Create an app in the service's developer console with redirect URI <code>{session.redirectUri}</code>, then paste:</span>
            <label className="catalog-field"><span>Client ID</span><input value={cid} autoComplete="off" onChange={(e) => setCid(e.target.value)} /></label>
            <label className="catalog-field"><span>Client secret (leave blank if none)</span><input type="password" autoComplete="off" value={csec} onChange={(e) => setCsec(e.target.value)} /></label>
            <button className="btn compact primary" disabled={busy || !cid.trim()} onClick={() => onCreds(session.id, cid.trim(), csec.trim())}>
              {busy ? 'Starting…' : 'Start sign-in'}
            </button>
          </div>
        ) : (
          <div className="mcp-callback-helper">
            <strong>Finish from your phone</strong>
            <span>
              Open the link below and approve. Your browser will then try to load{' '}
              <code>http://{session.redirectHost}:{session.redirectPort}/…</code> and fail - that's expected.
              In the address bar, swap <code>{session.redirectHost}:{session.redirectPort}</code> for{' '}
              <code>{dashHost || 'your Tailscale IP:port'}</code> (this dashboard's address) and load it. The gateway finishes the sign-in and this flips to Live on its own.
            </span>
            <code className="auth-url">{session.authUrl}</code>
            <div className="mcp-callback-row">
              <button className="btn compact primary" onClick={() => window.open(session.authUrl, '_blank', 'noopener,noreferrer')}>Open auth page</button>
              <button className="btn compact" onClick={() => navigator.clipboard?.writeText(session.authUrl)}>Copy link</button>
            </div>
            <span className="auth-waiting">Waiting for you to finish - this updates automatically.</span>
          </div>
        )}
      </div>
    </div>
  )
}

interface McpSettingsViewProps {
  onAuthError: () => void
}

export default function McpSettingsView({ onAuthError }: McpSettingsViewProps) {
  const [data, setData] = useState<any>(null)        // settings payload (verify:false - fast)
  const [catalog, setCatalog] = useState<any>(null)
  const [gateway, setGateway] = useState<any>(null)  // live gateway --status report
  const [gatewayLoading, setGatewayLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [busyMode, setBusyMode] = useState(false)
  const [busyAdd, setBusyAdd] = useState<string | null>(null)
  const [busyConn, setBusyConn] = useState<string | null>(null)
  const [relaying, setRelaying] = useState(false)
  const [authSession, setAuthSession] = useState<any>(null) // active gateway OAuth walkthrough
  const [busyAuth, setBusyAuth] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useErrorToast(error)

  const mcpOn = data?.mcpMode === 'gateway'

  const loadGateway = useCallback((force = false) => {
    setGatewayLoading(true)
    getGatewayStatus({ force })
      .then((g) => setGateway(g))
      .catch((e) => { if (e instanceof AuthError) onAuthError?.() })
      .finally(() => setGatewayLoading(false))
  }, [onAuthError])

  // Fast load only - catalog (static) + manifest/providers (no CLI probes). The
  // gateway is probed up front so every connection row can show its live health,
  // whether or not MCP is currently switched on.
  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    Promise.all([getMcpCatalog(), getMcpSettings({ verify: false })])
      .then(([cat, settings]) => {
        setCatalog(cat)
        setData(settings)
        loadGateway(false)
      })
      .catch((e) => e instanceof AuthError ? onAuthError?.() : setError(e.message || String(e)))
      .finally(() => setLoading(false))
  }, [onAuthError, loadGateway])

  useEffect(() => { load() }, [load])

  // While an auth walkthrough is open, re-probe the gateway until the target app
  // reports a live token (the callback completes on the box, out-of-band), then
  // mark the panel done. Capped at ~3 min so it can't poll forever.
  useEffect(() => {
    if (!authSession?.id || authSession.needsCreds || authSession.done) return
    const target = authSession.id
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const g = await getGatewayStatus({ force: true })
        if (!alive) return
        setGateway(g)
        if ((g.servers || []).find((s: any) => s.id === target)?.ok) {
          setAuthSession((s: any) => (s && s.id === target ? { ...s, done: true } : s))
          return
        }
      } catch {}
      if (alive) timer = setTimeout(tick, 5000)
    }
    timer = setTimeout(tick, 4000)
    const stop = setTimeout(() => { alive = false; if (timer) clearTimeout(timer) }, 180000)
    return () => { alive = false; if (timer) clearTimeout(timer); clearTimeout(stop) }
  }, [authSession])

  const connections = data?.connections || []
  const connById = Object.fromEntries(connections.map((c: any) => [c.id, c]))
  const providers = (data?.providers || []).slice().sort((a: any, b: any) => PROVIDER_ORDER.indexOf(a.id) - PROVIDER_ORDER.indexOf(b.id))
  const enabledProviderCount = providers.filter((p: any) => p.enabled).length
  const syncResults = data?.synced || []
  const gatewayHealthById = Object.fromEntries((gateway?.servers || []).map((s: any) => [s.id, s]))

  // Merge the static catalog with the manifest so every app shows as one row.
  const apps: any[] = []
  const seen = new Set()
  for (const entry of (catalog?.catalog || [])) {
    const conn = connById[entry.id]
    apps.push({ ...entry, ...(conn || {}), installed: Boolean(conn), enabled: conn ? conn.enabled !== false : false, custom: false })
    seen.add(entry.id)
  }
  for (const conn of connections) {
    if (seen.has(conn.id)) continue
    apps.push({ ...conn, installed: true, enabled: conn.enabled !== false, custom: true, category: conn.category || 'Custom', auth: conn.transport === 'remote' ? 'oauth' : 'apikey' })
  }
  const installedCount = apps.filter((a) => a.installed).length

  // Group by category; installed apps float to the top of each group.
  const groups: Record<string, any[]> = {}
  for (const app of apps) (groups[app.category || 'Other'] ||= []).push(app)
  const categories = Object.keys(groups).sort()
  for (const c of categories) groups[c].sort((a, b) => (Number(b.installed) - Number(a.installed)) || a.name.localeCompare(b.name))

  function toggleExpand(app: any) {
    setExpanded(expanded === app.id ? null : app.id)
  }

  async function switchMode(mode: string) {
    setBusyMode(true)
    setError(null)
    try {
      const next = await setMcpMode(mode)
      setData(next)
      loadGateway(true)
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError?.()
      else setError(e.message || String(e))
    } finally {
      setBusyMode(false)
    }
  }

  // Kick off (or restart) a gateway OAuth flow. With no creds we try automatic
  // registration; a 'needs-client-credentials' reply opens the manual form.
  async function startAuth(id: string, clientId?: string, clientSecret?: string) {
    setBusyAuth(true)
    setError(null)
    try {
      const r = await startGatewayOAuth(id, clientId ? { clientId, clientSecret } : {})
      if (r.ok) {
        setAuthSession({ id, authUrl: r.authUrl, redirectHost: r.redirectHost, redirectPort: r.redirectPort })
        window.open(r.authUrl, '_blank', 'noopener,noreferrer')
      } else if (r.code === 'needs-client-credentials') {
        setAuthSession({ id, needsCreds: true, message: r.message, redirectUri: r.redirectUri })
      } else {
        setError(r.message || 'Could not start sign-in')
      }
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError?.()
      else setError(e.message || String(e))
    } finally {
      setBusyAuth(false)
    }
  }

  async function deauth(id: string) {
    if (!window.confirm(`Sign ${id} out of the gateway? Models lose access until you re-authenticate.`)) return
    setBusyAuth(true)
    setError(null)
    try {
      setData(await resetGatewayOAuth(id))
      if (authSession?.id === id) setAuthSession(null)
      loadGateway(true)
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError?.()
      else setError(e.message || String(e))
    } finally {
      setBusyAuth(false)
    }
  }

  async function addConnection(app: any, values: any) {
    setBusyAdd(app.id)
    setError(null)
    try {
      const next = await addMcpConnection({ id: app.id, values })
      setData(next)
      setCatalog(await getMcpCatalog())
      setExpanded(app.id)
      loadGateway(true)
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError?.()
      else setError(e.message || String(e))
    } finally {
      setBusyAdd(null)
    }
  }

  async function addCustom(custom: any, onDone?: () => void) {
    setBusyAdd('custom')
    setError(null)
    try {
      const next = await addMcpConnection({ custom })
      setData(next)
      setCatalog(await getMcpCatalog())
      onDone?.()
      setExpanded(custom.id)
      loadGateway(true)
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError?.()
      else setError(e.message || String(e))
    } finally {
      setBusyAdd(null)
    }
  }

  async function toggleConnection(app: any, enabled: boolean) {
    setBusyConn(app.id)
    setError(null)
    try {
      const next = await toggleMcpConnection(app.id, enabled)
      setData(next)
      loadGateway(true)
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError?.()
      else setError(e.message || String(e))
    } finally {
      setBusyConn(null)
    }
  }

  async function removeConnection(app: any) {
    if (!window.confirm(`Remove ${app.name} from MCP?`)) return
    setBusyConn(app.id)
    setError(null)
    try {
      const next = await removeMcpConnection(app.id)
      setData(next)
      setCatalog(await getMcpCatalog())
      setExpanded(null)
      loadGateway(true)
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError?.()
      else setError(e.message || String(e))
    } finally {
      setBusyConn(null)
    }
  }

  async function runRelay(callbackUrl: string) {
    setRelaying(true)
    setError(null)
    try { setData(await relayMcpCallback(callbackUrl)) }
    catch (e: any) { if (e instanceof AuthError) onAuthError?.(); else setError(e.message || String(e)) }
    finally { setRelaying(false) }
  }

  // Re-push the current MCP config to every provider (re-applies the gateway entry
  // when on, re-strips it when off).
  async function runSync() {
    setBusy('sync')
    setError(null)
    try {
      setData(await setMcpMode(mcpOn ? 'gateway' : 'off'))
      loadGateway(true)
    }
    catch (e: any) { if (e instanceof AuthError) onAuthError?.(); else setError(e.message || String(e)) }
    finally { setBusy(null) }
  }

  return (
    <div className="view connections-view">
      <div className="settings-shell connections-shell">
        <header className="settings-top connections-top">
          <div>
            <h1>Connections</h1>
            <p>Enable productivity apps once and every model can use them. With MCP on, all providers share a single connection - no app-by-app setup per provider.</p>
          </div>
          <div className="settings-actions">
            <button className="icon-btn small" onClick={load} title="Refresh"><Hi icon={ArrowPathIcon} size={16} /></button>
            <button className="btn compact primary" disabled={busy === 'sync' || !installedCount} onClick={runSync}>
              {busy === 'sync' ? 'Syncing...' : 'Re-sync'}
            </button>
          </div>
        </header>

        {loading && !data ? (
          <div className="spinner">Loading...</div>
        ) : (
          <>
            <GatewayPanel
              mode={data?.mcpMode}
              status={gateway}
              loading={gatewayLoading}
              busy={busyMode}
              onToggle={switchMode}
              onRefresh={() => loadGateway(true)}
            />

            <div className="connections-overview">
              <div><strong>{installedCount}</strong><span>connected</span></div>
              <div><strong>{mcpOn ? (gateway?.totalTools ?? '-') : 'Off'}</strong><span>tools exposed</span></div>
              <div><strong>{enabledProviderCount}</strong><span>providers enabled</span></div>
            </div>

            {syncResults.length ? (
              <div className="mcp-sync-strip">{syncResults.map((r: any, i: number) => <SyncResult key={`${r.provider}-${i}`} result={r} />)}</div>
            ) : null}

            <ActionPanel
              result={data?.actionResult}
              onDismiss={() => setData((c: any) => c ? { ...c, actionResult: null } : c)}
              onRefresh={load}
              onRelay={runRelay}
              relaying={relaying}
            />

            <GatewayAuthPanel
              session={authSession}
              busy={busyAuth}
              onCreds={startAuth}
              onCancel={() => setAuthSession(null)}
            />

            <WhoopConnectionPanel onAuthError={onAuthError} />

            <DataConnectionsPanel onAuthError={onAuthError} />

            {categories.map((cat) => (
              <div className="app-group" key={cat}>
                <div className="settings-section-title"><span /><strong>{cat}</strong></div>
                <div className="app-list">
                  {groups[cat].map((app) => (
                    <AppRow
                      key={app.id}
                      app={app}
                      busy={busyAdd === app.id || busyConn === app.id}
                      expanded={expanded === app.id}
                      gatewayHealth={gatewayHealthById[app.id]}
                      gatewayLoading={gatewayLoading}
                      busyAuth={busyAuth && authSession?.id === app.id}
                      onToggleExpand={() => toggleExpand(app)}
                      onAdd={addConnection}
                      onToggle={toggleConnection}
                      onRemove={removeConnection}
                      onAuthenticate={(id) => startAuth(id)}
                      onDeauth={deauth}
                      onAuthError={onAuthError}
                    />
                  ))}
                </div>
              </div>
            ))}

            <div className="app-group">
              <div className="settings-section-title"><span /><strong>Custom</strong></div>
              <div className="app-list">
                <CustomConnectionForm busy={busyAdd === 'custom'} onAdd={addCustom} />
              </div>
            </div>

          </>
        )}
      </div>
    </div>
  )
}

interface SyncResultProps {
  result: any
}

function SyncResult({ result }: SyncResultProps) {
  if (!result) return null
  return (
    <div className={`mcp-sync-result ${result.ok ? 'ok' : 'bad'}`}>
      <Hi icon={result.ok ? CheckCircleIcon : ExclamationTriangleIcon} size={16} />
      <div>
        <strong>{result.provider}</strong>
        <span>{result.message || (result.ok ? 'Synced' : 'Failed')}</span>
        {result.details?.length ? <code>{result.details.join('\n')}</code> : null}
      </div>
    </div>
  )
}
