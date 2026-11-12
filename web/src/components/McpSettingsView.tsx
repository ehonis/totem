import React, { useEffect, useState, useCallback } from 'react'
import {
  getMcpSettings, getMcpCatalog, addMcpConnection, toggleMcpConnection,
  removeMcpConnection, relayMcpCallback,
  setMcpMode, getGatewayStatus, startGatewayOAuth, resetGatewayOAuth, AuthError,
  getCalendarAccounts, renameCalendarAccount, removeCalendarAccount, startCalendarAccountAuth,
  getGmailAccounts, renameGmailAccount, removeGmailAccount, startGmailAccountAuth,
  getDriveAccounts, renameDriveAccount, removeDriveAccount, startDriveAccountAuth,
} from '../api'
import { Hi, ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon, TrashIcon, WrenchScrewdriverIcon, ChevronDownIcon, BoltIcon, CubeIcon, SquaresPlusIcon } from '../icons'
import DataConnectionsPanel from './DataConnectionsPanel'
import SourceHealthPanel, { SourceRuns } from '../sources/SourceHealthPanel'
import { isMcpSource, since, type SourceHealthPayload } from '../sources/health'
import { SERVER_STATES, attentionItems, isRemote, serverState, sortServers, type AttentionItem, type ServerState } from '../connections/state'
import ClaudeToolsPanel from './ClaudeToolsPanel'
import { WhoopConnectionRow } from './WhoopConnection'
import { StravaConnectionRow } from './StravaConnection'
import { pushError, pushSuccess, useErrorToast } from '../toast'
import { copyText } from '../clipboard'
import { CONNECTION_ICON_CHOICES, loadConnectionIcons, resetConnectionIcon, setConnectionFavicon, setConnectionIcon, useConnectionIcon } from '../connections/icons'
import { THREAD_ICONS } from '../chat/threadIcons.gen'
import { uploadFile } from '../chat/api'
import { TI } from '../chat/ui'
import { IconUpload, IconWorld } from '../chat/icons'
import {
  siLinear, siNotion, siAsana, siAtlassian, siGithub, siSentry, siVercel,
  siIntercom, siStripe, siPaypal, siAirtable, siHuggingface, siActualbudget, siGmail, siGoogledrive,
} from 'simple-icons'
import googleCalendarIcon from '../assets/connection-icons/google-calendar.svg'
import plaudIcon from '../assets/connection-icons/plaud.png'
import slackIcon from '../assets/connection-icons/slack.svg'
import canvaIcon from '../assets/connection-icons/canva.svg'

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
  gmail: siGmail,
  'google-drive': siGoogledrive,
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
  /** Its own logo, ignoring the owner's pick (the picker's first choice). */
  own?: boolean
}

function ConnectionIcon({ id, name, size = 34, own = false }: ConnectionIconProps) {
  // The owner's pick (Icon, in the row) wins over the brand logo.
  const pick = useConnectionIcon(id)
  const picked = own ? undefined : pick
  const pickedIcon = !picked?.imageUrl && picked?.icon ? THREAD_ICONS[picked.icon] : null
  const src = picked?.imageUrl || (!pickedIcon ? CONNECTION_ICONS[id] : undefined)
  const glyph = !src && !pickedIcon ? CONNECTION_GLYPHS[id] : null
  const fallback = !src && !glyph
  return (
    <span
      className={`connection-icon ${fallback ? 'fallback' : ''}`}
      style={{ width: size, height: size, ...(fallback ? { background: accentFor(id), color: '#fff' } : {}) }}
    >
      {pickedIcon ? (
        <TI icon={pickedIcon} size={Math.round(size * 0.6)} />
      ) : src ? (
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

const ICON_CHOICES = CONNECTION_ICON_CHOICES.filter((name) => THREAD_ICONS[name])

// A connection's icon, as a chat folder's: its own logo, one of the chat icons, an
// uploaded picture, or a website's icon.
function IconField({ id, name }: { id: string; name: string }) {
  const picked = useConnectionIcon(id)
  const [site, setSite] = useState('')
  const [busy, setBusy] = useState(false)
  const input = React.useRef<HTMLInputElement>(null)
  async function run(what: string, fn: () => Promise<void>) {
    setBusy(true)
    try { await fn() } catch (e: any) { pushError(`${what}: ${e.message}`) } finally { setBusy(false) }
  }
  const upload = (file?: File) => file && run("Couldn't use that picture", async () => {
    const up = await uploadFile(file, file.name)
    if (up.kind !== 'image' && !/icon$/.test(up.mime)) throw new Error('that is not a PNG, JPEG, GIF, WebP or ICO image')
    await setConnectionIcon(id, { image: up.id })
  })
  function fetchIcon(e: React.FormEvent) {
    e.preventDefault()
    if (!site.trim()) return
    void run("Couldn't get that site's icon", async () => { await setConnectionFavicon(id, site.trim()); setSite('') })
  }
  const own = !picked
  return (
    <div className="conn-icon-field">
      <span className="server-checks-label">Icon</span>
      <div className="conn-icon-grid" role="radiogroup" aria-label={`Icon for ${name}`}>
        <button type="button" role="radio" aria-checked={own} className={own ? 'on' : ''} disabled={busy} onClick={() => !own && run("Couldn't reset the icon", () => resetConnectionIcon(id))} title={`${name}'s own logo`}>
          <ConnectionIcon id={id} name={name} size={24} own />
        </button>
        {ICON_CHOICES.map((icon) => {
          const on = !picked?.image && picked?.icon === icon
          return (
            <button key={icon} type="button" role="radio" aria-checked={on} className={on ? 'on' : ''} disabled={busy} onClick={() => !on && run("Couldn't set the icon", () => setConnectionIcon(id, { icon }))} title={icon}>
              <TI icon={THREAD_ICONS[icon]} size={18} />
            </button>
          )
        })}
      </div>
      <div className="conn-icon-picture">
        {picked?.imageUrl && <span className="conn-icon-now"><ConnectionIcon id={id} name={name} size={26} />Picture in use</span>}
        <button type="button" className="btn compact" disabled={busy} onClick={() => input.current?.click()}><TI icon={IconUpload} size={15} />Upload image</button>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,.ico" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = '' }} />
        <form className="gcal-add-form conn-icon-site" onSubmit={fetchIcon}>
          <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="example.com" aria-label={`Website to take ${name}'s icon from`} disabled={busy} />
          <button type="submit" className="btn compact" disabled={busy || !site.trim()}><TI icon={IconWorld} size={15} />Use site icon</button>
        </form>
      </div>
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

// The four calls behind a set of Google accounts. Calendar, Gmail and Drive each keep
// their own token store, so each passes its own.
interface GoogleAccountsApi {
  list: () => Promise<any>
  rename: (from: string, to: string) => Promise<any>
  remove: (label: string) => Promise<any>
  start: (label: string) => Promise<any>
  /** What stops working when an account is disconnected, for the confirm. */
  removes: string
}

const CALENDAR_ACCOUNTS: GoogleAccountsApi = {
  list: getCalendarAccounts, rename: renameCalendarAccount, remove: removeCalendarAccount, start: startCalendarAccountAuth,
  removes: 'Its calendar stops syncing here.',
}

const GMAIL_ACCOUNTS: GoogleAccountsApi = {
  list: getGmailAccounts, rename: renameGmailAccount, remove: removeGmailAccount, start: startGmailAccountAuth,
  removes: 'Agents lose access to its mail, and Totem asks Google to revoke the grant.',
}

const DRIVE_ACCOUNTS: GoogleAccountsApi = {
  list: getDriveAccounts, rename: renameDriveAccount, remove: removeDriveAccount, start: startDriveAccountAuth,
  removes: 'Agents lose access to its files, and Totem asks Google to revoke the grant.',
}

interface GoogleAccountsPanelProps {
  onAuthError: () => void
  accountsApi?: GoogleAccountsApi
}

// Manage a set of saved Google accounts (Calendar's, Gmail's or Drive's): see each login's
// real email, rename its label, disconnect it, or add another via Google sign-in.
// Loads the account list when first shown.
function GoogleAccountsPanel({ onAuthError, accountsApi = CALENDAR_ACCOUNTS }: GoogleAccountsPanelProps) {
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
    try { apply((await accountsApi.list()).accounts) }
    catch (e: any) { if (e instanceof AuthError) return onAuthError?.(); setErr(e.message || 'Failed to load accounts') }
    finally { setLoading(false) }
  }, [apply, onAuthError, accountsApi])

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
    return run(label, () => accountsApi.rename(label, to))
  }

  function doRemove(label: string) {
    if (!window.confirm(`Disconnect Google account "${label}"? ${accountsApi.removes}`)) return
    return run(label, () => accountsApi.remove(label))
  }

  async function doAdd(e: React.FormEvent) {
    e.preventDefault()
    const label = newLabel.trim()
    if (!label) return
    setBusy('__add__'); setErr('')
    try {
      const res = await accountsApi.start(label)
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


interface GoogleServiceRowProps {
  onAuthError: () => void
  /** Told whether the row needs the owner (a grant to reconnect, an error). */
  onProblem: (name: string, problem: boolean) => void
  /** Changing it reads the accounts again (the page's refresh). */
  reloadKey?: number
  id: string
  name: string
  summary: string
  accountsApi: GoogleAccountsApi
  children: React.ReactNode
}

// A Google service the bridge serves itself (Gmail, Drive). Not a manifest server:
// the bridge holds the grant and serves the tools (gmail__*, drive__* through the
// gateway), so the row only manages accounts.
function GoogleServiceRow({ onAuthError, onProblem, reloadKey, id, name, summary, accountsApi, children }: GoogleServiceRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [info, setInfo] = useState<any>(null)
  useEffect(() => {
    accountsApi.list().then(setInfo).catch((e) => { if (e instanceof AuthError) onAuthError(); else setInfo({ error: e.message }) })
  }, [onAuthError, expanded, accountsApi, reloadKey])
  const count = info?.accounts?.length || 0
  const broken = info?.accounts?.some((a: any) => a.status === 'error')
  const chip = !info ? '' : info.error ? 'Error' : !info.configured ? 'Not set up' : !count ? 'Not signed in' : broken ? 'Reconnect needed' : `${count} account${count === 1 ? '' : 's'}`
  const tone = info?.configured && count && !broken ? 'on' : broken || info?.error ? 'bad' : ''
  useEffect(() => { if (info) onProblem(name, tone === 'bad') }, [info, tone, name, onProblem])
  return (
    <section className={`app-row ${expanded ? 'open' : ''} ${info && !info.configured ? 'disabled' : ''}`}>
      <button className="app-row-head" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <ConnectionIcon id={id} name={name} size={30} />
        <span className="app-row-title">
          <strong>{name}</strong>
          <span>{summary}</span>
        </span>
        <span className="app-row-status">{chip && <span className={`app-row-chip ${tone}`}>{chip}</span>}</span>
        <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${expanded ? 'up' : ''}`} />
      </button>
      {expanded && (
        <div className="app-row-body">
          <p className="app-row-desc">{children}</p>
          {info && !info.configured ? (
            <p className="app-row-hint">No Google OAuth client yet. Set one up as for Calendar, then come back.</p>
          ) : (
            <GoogleAccountsPanel onAuthError={onAuthError} accountsApi={accountsApi} />
          )}
          <IconField id={id} name={name} />
        </div>
      )}
    </section>
  )
}

// Gmail: sending is never a tool; see docs/gmail.md.
function GmailConnectionRow({ onAuthError, onProblem, reloadKey }: { onAuthError: () => void; onProblem: (name: string, problem: boolean) => void; reloadKey?: number }) {
  return (
    <GoogleServiceRow
      onAuthError={onAuthError} onProblem={onProblem} reloadKey={reloadKey} id="gmail" name="Gmail" accountsApi={GMAIL_ACCOUNTS}
      summary="Search, read, label and draft. Never sends."
    >
      Agents get <code>gmail__*</code> tools for every account here. An email they write waits in your Inbox for
      you to send. The same sign-in adds the account's calendar. Uses Calendar's Google OAuth client with the Gmail
      API enabled (<code>docs/gmail.md</code>).
    </GoogleServiceRow>
  )
}

// Google Drive: no sharing, no permanent delete; see docs/drive.md.
function DriveConnectionRow({ onAuthError, onProblem, reloadKey }: { onAuthError: () => void; onProblem: (name: string, problem: boolean) => void; reloadKey?: number }) {
  return (
    <GoogleServiceRow
      onAuthError={onAuthError} onProblem={onProblem} reloadKey={reloadKey} id="google-drive" name="Google Drive" accountsApi={DRIVE_ACCOUNTS}
      summary="Find, read and organise files. Edit Sheets and Docs."
    >
      Agents get <code>drive__*</code> tools for every account here, shared drives included. They cannot share a
      file or delete one for good. Uses Calendar's Google OAuth client with the Drive, Sheets and Docs APIs enabled
      and the <code>drive</code> scope (<code>docs/drive.md</code>).
    </GoogleServiceRow>
  )
}

function hostOf(app: any) {
  if (app.url) {
    try { return new URL(app.url).host } catch { return app.url }
  }
  return [app.command, app.package].filter(Boolean).join(' ') || 'Local command'
}

interface ServerRowProps {
  app: any
  state: ServerState
  health?: any
  /** "failing since 3h ago" from the run log, for a server that keeps failing. */
  failingFor?: string | null
  mcpOn?: boolean
  gatewayLoading?: boolean
  busy?: boolean
  expanded?: boolean
  busyAuth?: boolean
  onToggleExpand: () => void
  onToggle: (app: any, enabled: boolean) => void
  onRemove: (app: any) => void
  onAuthenticate: (id: string) => void
  onDeauth: (id: string) => void
  onAuthError: () => void
}

// One installed MCP server. Its health is the gateway's (every provider reaches it
// there), so a sign-in happens once, here, and the button sits on the row itself.
function ServerRow({ app, state, health, failingFor, mcpOn = true, gatewayLoading, busy, expanded, busyAuth, onToggleExpand, onToggle, onRemove, onAuthenticate, onDeauth, onAuthError }: ServerRowProps) {
  const remote = isRemote(app)
  const chip = {
    signin: 'Needs sign-in',
    error: 'Not working',
    checking: gatewayLoading ? 'Checking…' : 'Not checked',
    live: mcpOn ? 'Live' : 'Ready',
    off: 'Off',
  }[state]
  const chipTone = state === 'live' && !mcpOn ? '' : SERVER_STATES[state].chip
  const sub = state === 'error' && health?.error && !expanded
    ? [health.error, failingFor].filter(Boolean).join(' · ')
    : state === 'live' ? `${health.toolCount} tool${health.toolCount === 1 ? '' : 's'} · ${hostOf(app)}` : hostOf(app)
  return (
    <section className={`app-row server-row ${expanded ? 'open' : ''} ${state === 'off' ? 'disabled' : ''}`}>
      <div className="app-row-line">
        <button className="app-row-head" onClick={onToggleExpand} aria-expanded={expanded}>
          <ConnectionIcon id={app.id} name={app.name} size={30} />
          <span className="app-row-title">
            <strong>{app.name}</strong>
            <span className={state === 'error' && !expanded ? 'bad' : ''}>{sub}</span>
          </span>
          {state === 'signin' && remote ? null : (
            <span className="app-row-status"><span className={`app-row-chip ${chipTone}`}>{chip}</span></span>
          )}
          {state === 'signin' && remote ? null : <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${expanded ? 'up' : ''}`} />}
        </button>
        {state === 'signin' && remote && (
          <>
            <button className="btn compact primary row-action" disabled={busyAuth} onClick={() => onAuthenticate(app.id)} aria-label={`Sign in to ${app.name}`}>
              {busyAuth ? 'Starting…' : 'Sign in'}
            </button>
            {/* A larger target for the mouse; the row's head is the toggle for everyone else. */}
            <span className="row-caret" onClick={onToggleExpand} aria-hidden="true">
              <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${expanded ? 'up' : ''}`} />
            </span>
          </>
        )}
      </div>

      {expanded && (
        <div className="app-row-body">
          {state === 'error' && health?.error && <p className="source-error in-body">{health.error}</p>}
          <div className="connection-meta">
            <code>{app.url || `${app.command || ''}${app.package ? ` ${app.package}` : ''}`}</code>
            {app.envKeys?.length ? <code>Env: {app.envKeys.join(', ')}</code> : null}
            {app.headerKeys?.length ? <code>Headers: {app.headerKeys.join(', ')}</code> : null}
          </div>
          {app.id === 'google-calendar' && <GoogleAccountsPanel onAuthError={onAuthError} />}
          {state !== 'off' && (
            <div className="server-checks">
              <span className="server-checks-label">Recent checks</span>
              <SourceRuns source={`mcp:${app.id}`} onAuthError={onAuthError} />
            </div>
          )}
          <IconField id={app.id} name={app.name} />
          <div className="app-row-controls">
            {remote && state !== 'off' && (state === 'live' ? (
              <>
                <button className="btn compact" disabled={busyAuth} onClick={() => onAuthenticate(app.id)} aria-label={`Sign in to ${app.name} again`}>Sign in again</button>
                <button className="btn compact danger" disabled={busyAuth} onClick={() => onDeauth(app.id)}>Sign out</button>
              </>
            ) : state !== 'signin' ? (
              <button className="btn compact" disabled={busyAuth} onClick={() => onAuthenticate(app.id)} aria-label={`Sign in to ${app.name}`}>
                {busyAuth ? 'Starting…' : state === 'error' ? 'Sign in again' : 'Sign in'}
              </button>
            ) : null)}
            <span className="server-switch-label">{state === 'off' ? 'Off' : 'On'}</span>
            <button
              className={`provider-switch ${app.enabled ? 'on' : ''}`}
              disabled={busy}
              onClick={() => onToggle(app, !app.enabled)}
              title={app.enabled ? 'Switch off for every agent' : 'Switch on for every agent'}
              role="switch"
              aria-checked={Boolean(app.enabled)}
              aria-label={`${app.name} for every agent`}
            >
              <span />
            </button>
            <button className="icon-btn small danger" disabled={busy} onClick={() => onRemove(app)} title="Remove this server" aria-label={`Remove ${app.name}`}>
              <Hi icon={TrashIcon} size={14} />
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

interface CatalogRowProps {
  app: any
  busy?: boolean
  expanded?: boolean
  onToggleExpand: () => void
  onAdd: (app: any, values: any) => void
}

// A catalog app not added yet: its description, and the form that adds it.
function CatalogRow({ app, busy, expanded, onToggleExpand, onAdd }: CatalogRowProps) {
  return (
    <section className={`app-row catalog-row ${expanded ? 'open' : ''}`}>
      <button className="app-row-head" onClick={onToggleExpand} aria-expanded={expanded}>
        <ConnectionIcon id={app.id} name={app.name} size={30} />
        <span className="app-row-title">
          <strong>{app.name}</strong>
          {!expanded && <span>{app.description}</span>}
        </span>
        <span className="app-row-status"><span className="catalog-badge">{authBadge(app.auth) || 'Add'}</span></span>
        <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${expanded ? 'up' : ''}`} />
      </button>
      {expanded && (
        <div className="app-row-body">
          <p className="app-row-desc">{app.description}</p>
          <ConnectForm app={app} busy={busy} onAdd={onAdd} />
        </div>
      )}
    </section>
  )
}

interface CatalogFoldProps {
  apps: any[]
  busyAdd: string | null
  expanded: string | null
  onExpand: (id: string) => void
  onAdd: (app: any, values: any) => void
}

// Every catalog app not yet added, folded into one row until asked for.
function CatalogFold({ apps, busyAdd, expanded, onExpand, onAdd }: CatalogFoldProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const shown = apps.filter((a) => !needle || `${a.name} ${a.category} ${a.description}`.toLowerCase().includes(needle))
  const groups: Record<string, any[]> = {}
  for (const app of shown) (groups[app.category || 'Other'] ||= []).push(app)
  const categories = Object.keys(groups).sort()
  if (!apps.length) return null
  return (
    <section className={`app-row catalog-fold ${open ? 'open' : ''}`}>
      <button className="app-row-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="connection-icon fallback catalog-fold-icon" style={{ width: 30, height: 30 }}>
          <Hi icon={SquaresPlusIcon} size={16} />
        </span>
        <span className="app-row-title">
          <strong>Browse the catalog</strong>
          <span>{apps.length} apps ready to add: {apps.slice(0, 4).map((a) => a.name).join(', ')}{apps.length > 4 ? '…' : ''}</span>
        </span>
        <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${open ? 'up' : ''}`} />
      </button>
      {open && (
        <div className="catalog-fold-body">
          <input className="claude-tools-search" type="search" placeholder={`Filter ${apps.length} apps`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter the catalog" />
          {categories.map((cat) => (
            <div key={cat} className="catalog-fold-group">
              <div className="conn-list-label">{cat}</div>
              {groups[cat].map((app) => (
                <CatalogRow key={app.id} app={app} busy={busyAdd === app.id} expanded={expanded === app.id} onToggleExpand={() => onExpand(app.id)} onAdd={onAdd} />
              ))}
            </div>
          ))}
          {!shown.length && <p className="app-row-hint">Nothing in the catalog matches. Add it as a custom server below.</p>}
        </div>
      )}
    </section>
  )
}

interface BuiltinFoldProps {
  servers: any[]
}

// Totem's own tool slices (tasks, goals, …). Always there, so one row, folded.
function BuiltinFold({ servers }: BuiltinFoldProps) {
  const [open, setOpen] = useState(false)
  if (!servers.length) return null
  const tools = servers.reduce((n, s) => n + (s.toolCount || 0), 0)
  const down = servers.filter((s) => !s.ok)
  return (
    <section className={`app-row ${open ? 'open' : ''}`}>
      <button className="app-row-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="connection-icon fallback builtin-icon" style={{ width: 30, height: 30 }}>
          <Hi icon={CubeIcon} size={16} />
        </span>
        <span className="app-row-title">
          <strong>Built into Totem</strong>
          <span>{servers.length} tool sets · {tools} tools: {servers.slice(0, 5).map((s) => s.id).join(', ')}{servers.length > 5 ? '…' : ''}</span>
        </span>
        <span className="app-row-status">
          <span className={`app-row-chip ${down.length ? 'bad' : 'on'}`}>{down.length ? `${down.length} not working` : 'Live'}</span>
        </span>
        <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${open ? 'up' : ''}`} />
      </button>
      {open && (
        <div className="app-row-body">
          <div className="gateway-grid">{servers.map((s) => <GatewayServerChip key={s.id} server={s} />)}</div>
        </div>
      )}
    </section>
  )
}

function GatewayServerChip({ server }: { server: any }) {
  const cls = server.ok ? 'ok' : (server.needsAuth ? 'warn' : 'bad')
  const label = server.ok ? `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}` : (server.needsAuth ? 'Needs sign-in' : 'Error')
  return (
    <div className={`gw-chip ${cls}`} title={server.error || label}>
      <span className="gw-chip-text">
        <strong>{server.id}</strong>
        <em>{label}</em>
      </span>
    </div>
  )
}

// The line at the top: what needs the owner, each a jump to its section. Says
// nothing is wrong only once the gateway and the source log have both answered.
// One live region stays mounted across states, so a change is announced.
function AttentionSummary({ items, quiet, checking }: { items: AttentionItem[]; quiet: string; checking: boolean }) {
  const jump = (id: string) => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    document.getElementById(id)?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' })
  }
  const state = items.length ? 'attention' : checking ? 'checking' : 'ok'
  const heading = items.length ? 'Needs you' : checking ? 'Checking your connections…' : 'Everything connected is working.'
  return (
    <div className={`conn-summary ${state}`}>
      <span className="sr-only" role="status">{items.length ? `Needs you: ${items.map((it) => it.text).join(', ')}.` : heading}</span>
      <Hi icon={items.length ? ExclamationTriangleIcon : checking ? ArrowPathIcon : CheckCircleIcon} size={16} className={!items.length && checking ? 'spin' : ''} />
      <span aria-hidden="true">{heading}</span>
      {items.length > 0 && (
        <div className="conn-summary-items">
          {items.map((it) => (
            <button key={it.text} className={`conn-summary-item ${it.tone}`} onClick={() => jump(it.target)}>{it.text}</button>
          ))}
        </div>
      )}
      {quiet && <em>{quiet}</em>}
    </div>
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
              <button className="btn compact" onClick={() => copyText(session.authUrl).then((ok) => (ok ? pushSuccess('Link copied') : pushError('Could not copy; select the link above')))}>Copy link</button>
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
  // undefined until Data sources first answers, null if it could not be read.
  const [sources, setSources] = useState<SourceHealthPayload | null | undefined>(undefined)
  const [sourcesKey, setSourcesKey] = useState(0)    // bumped to make Data sources check again
  const [expanded, setExpanded] = useState<string | null>(null)        // an installed server
  const [catalogOpen, setCatalogOpen] = useState<string | null>(null)  // a catalog app's add form
  const [accountIssues, setAccountIssues] = useState<Record<string, boolean>>({})  // Accounts rows that need the owner
  const reportAccount = useCallback((name: string, problem: boolean) => {
    setAccountIssues((m) => (m[name] === problem ? m : { ...m, [name]: problem }))
  }, [])
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
      .catch((e) => {
        if (e instanceof AuthError) onAuthError?.()
        else setGateway((g: any) => ({ servers: [], totalTools: 0, ...g, ok: false, error: e?.message || 'The gateway status check failed.' }))
      })
      .finally(() => setGatewayLoading(false))
  }, [onAuthError])

  // Fast load only - catalog (static) + manifest/providers (no CLI probes). The
  // gateway is probed up front so every server row can show its live health,
  // whether or not MCP is currently switched on.
  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    void loadConnectionIcons()
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

  const reloadAll = () => { load(); setSourcesKey((k) => k + 1) }

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
  const syncResults = data?.synced || []
  const gatewayServers: any[] = gateway?.servers || []
  const gatewayHealthById = Object.fromEntries(gatewayServers.map((s: any) => [s.id, s]))
  const builtins = gatewayServers.filter((s) => s.builtin)

  // Installed servers (the manifest, catalog entries merged in for their icon and
  // category) apart from the catalog apps not added yet.
  const installed: any[] = []
  const available: any[] = []
  for (const entry of (catalog?.catalog || [])) {
    const conn = connById[entry.id]
    if (conn) installed.push({ ...entry, ...conn, enabled: conn.enabled !== false, custom: false })
    else available.push(entry)
  }
  const catalogIds = new Set((catalog?.catalog || []).map((c: any) => c.id))
  for (const conn of connections) {
    if (catalogIds.has(conn.id)) continue
    installed.push({ ...conn, enabled: conn.enabled !== false, custom: true, category: conn.category || 'Custom' })
  }
  const rows = sortServers(installed.map((app) => ({ app, state: serverState(app, gatewayHealthById[app.id]) })))
  const count = (state: ServerState) => rows.filter((r) => r.state === state).length
  const live = count('live')
  const tools = gateway?.totalTools
  const failingFor = (id: string) => {
    const s = sources?.sources.find((x) => x.source === `mcp:${id}`)
    return s?.state === 'failing' && s.failingSince ? `failing since ${since(s.failingSince)}` : null
  }

  const attention = attentionItems({
    sources, mcpOn, gateway, states: rows.map((r) => r.state),
    accounts: Object.keys(accountIssues).filter((k) => accountIssues[k]),
  })
  const checking = !gateway || sources === undefined
  // The MCP section's head carries the server counts; this only says what it cannot.
  const quiet = !gateway ? 'Checking servers…' : mcpOn ? '' : 'MCP is off'

  // Each section of the list, in order, with a small label row above it.
  let lastGroup = ''
  const serverList = rows.map(({ app, state }) => {
    const group = SERVER_STATES[state].group
    const label = group !== lastGroup ? <div className="conn-list-label" key={`label-${group}`}>{group} · {count(state)}</div> : null
    lastGroup = group
    return (
      <React.Fragment key={app.id}>
        {label}
        <ServerRow
          app={app}
          state={state}
          health={gatewayHealthById[app.id]}
          failingFor={failingFor(app.id)}
          mcpOn={mcpOn}
          gatewayLoading={gatewayLoading}
          busy={busyAdd === app.id || busyConn === app.id}
          expanded={expanded === app.id}
          busyAuth={busyAuth && authSession?.id === app.id}
          onToggleExpand={() => setExpanded(expanded === app.id ? null : app.id)}
          onToggle={toggleConnection}
          onRemove={removeConnection}
          onAuthenticate={(id) => startAuth(id)}
          onDeauth={deauth}
          onAuthError={onAuthError}
        />
      </React.Fragment>
    )
  })

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
    if (!window.confirm(`Sign ${id} out of the gateway? Models lose access until you sign in again.`)) return
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
      setCatalogOpen(null)
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
      // The bridge dropped its icon with it.
      void loadConnectionIcons()
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
            <p>The apps and data your agents can reach. Anything that needs you comes first.</p>
          </div>
          <div className="settings-actions">
            <button className="icon-btn small" onClick={reloadAll} title="Check everything again" aria-label="Refresh connections">
              <Hi icon={ArrowPathIcon} size={16} className={loading ? 'spin' : ''} />
            </button>
          </div>
        </header>

        {loading && !data ? (
          <div className="spinner">Loading...</div>
        ) : (
          <>
            <AttentionSummary items={attention} quiet={quiet} checking={checking} />

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

            <SourceHealthPanel reloadKey={sourcesKey} onAuthError={onAuthError} exclude={isMcpSource} onLoad={setSources} />

            <section className="conn-section" id="conn-mcp">
              <div className="conn-section-head">
                <h2>MCP servers</h2>
                <span className="conn-section-meta">
                  {mcpOn ? `${live} live${tools != null ? ` · ${tools} tools` : ''}` : 'Off'}
                </span>
                <div className="conn-section-actions">
                  <button className="icon-btn small" disabled={gatewayLoading} onClick={() => loadGateway(true)} title="Check every server again" aria-label="Check servers again">
                    <Hi icon={ArrowPathIcon} size={14} className={gatewayLoading ? 'spin' : ''} />
                  </button>
                  <button className="btn compact" disabled={busy === 'sync' || !installed.length} onClick={runSync} title="Write the gateway into every agent's MCP config again">
                    {busy === 'sync' ? 'Syncing…' : 'Re-sync'}
                  </button>
                  <span className="server-switch-label" aria-hidden="true">{mcpOn ? 'On' : 'Off'}</span>
                  <button
                    className={`provider-switch ${mcpOn ? 'on' : ''}`}
                    disabled={busyMode}
                    onClick={() => switchMode(mcpOn ? 'off' : 'gateway')}
                    title={mcpOn ? 'Turn MCP off for every agent' : 'Turn MCP on for every agent'}
                    role="switch"
                    aria-label="MCP for every agent"
                    aria-checked={mcpOn}
                  >
                    <span />
                  </button>
                </div>
              </div>
              <p className="conn-section-note">
                {mcpOn
                  ? 'Every agent reaches these through one gateway, so each server is added and signed in to once, here.'
                  : 'MCP is off, so no agent can reach these servers. Switch it on to serve them all through one gateway.'}
              </p>
              {gateway && gateway.ok === false && <div className="error settings-error">{gateway.error || 'The gateway did not answer its status check.'}</div>}
              <div className={`conn-list ${mcpOn ? '' : 'muted'}`}>
                {serverList}
                {!installed.length && <p className="app-row-hint conn-list-empty">No servers yet. Add one from the catalog below.</p>}
                {mcpOn && builtins.length > 0 && <div className="conn-list-label">Built in</div>}
                {mcpOn && <BuiltinFold servers={builtins} />}
              </div>
            </section>

            <section className="conn-section" id="conn-accounts">
              <div className="conn-section-head">
                <h2>Accounts</h2>
                <span className="conn-section-meta">Served by Totem itself, not through MCP</span>
              </div>
              <div className="conn-list">
                <GmailConnectionRow onAuthError={onAuthError} onProblem={reportAccount} reloadKey={sourcesKey} />
                <DriveConnectionRow onAuthError={onAuthError} onProblem={reportAccount} reloadKey={sourcesKey} />
                <WhoopConnectionRow onProblem={reportAccount} reloadKey={sourcesKey} />
                <StravaConnectionRow onProblem={reportAccount} reloadKey={sourcesKey} />
              </div>
            </section>

            <DataConnectionsPanel onAuthError={onAuthError} />

            <ClaudeToolsPanel onAuthError={onAuthError} />

            <section className="conn-section" id="conn-add">
              <div className="conn-section-head">
                <h2>Add a connection</h2>
              </div>
              <div className="conn-list">
                <CatalogFold apps={available} busyAdd={busyAdd} expanded={catalogOpen} onExpand={(id) => setCatalogOpen(catalogOpen === id ? null : id)} onAdd={addConnection} />
                <CustomConnectionForm busy={busyAdd === 'custom'} onAdd={addCustom} />
              </div>
            </section>
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
