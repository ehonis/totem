import React, { useCallback, useEffect, useState } from 'react'
import { Hi, ChevronDownIcon, MapIcon, ArrowPathIcon, ExclamationTriangleIcon, CheckCircleIcon } from '../icons'
import { getStravaStatus, connectStrava, disconnectStrava, syncStrava, getStravaStats, getStravaGear, AuthError } from '../api'
import { pushToast, pushError, pushSuccess } from '../toast'

// The Strava connection, alongside WHOOP under "Wearables & fitness".
//
// Same rules as the WHOOP card, learned there the hard way: `connected` means a
// refresh token is on disk and nothing more, so Reconnect is always offered; the
// server's `state` drives the wording, never the button's existence. Strava is
// gentler than WHOOP — its refresh token usually does not rotate — but a grant
// revoked from strava.com looks identical from here until a call fails.
//
// The card also shows the one thing worth glancing at without opening an agent:
// Strava's own totals (four weeks / year / all-time, rides and runs) and each
// bike's odometer — the number the coming mileage goal will read.

export interface StravaStatus {
  configured: boolean
  connected: boolean
  needsReauth?: boolean
  state?: 'unconfigured' | 'disconnected' | 'needs-reauth' | 'missing-scopes' | 'ready'
  detail?: string
  athlete?: { id: number | string; name: string | null; username?: string | null; profile?: string | null; url?: string | null } | null
  scopes?: string[]
  requestedScopes?: string[]
  missingScopes?: string[]
  connectedAt?: string | null
  lastError?: string | null
  redirectUri?: string
  rateLimit?: { at: string; overall?: { limit15: number; usage15: number; limitDay: number; usageDay: number } | null; read?: { limit15: number; usage15: number; limitDay: number; usageDay: number } | null } | null
  cache?: { count: number; updatedAt: string | null; oldestStart: string | null; newestStart: string | null; complete: boolean; ageMinutes: number | null }
}

const TONE: Record<string, 'ok' | 'warn' | 'bad'> = {
  ready: 'ok', 'missing-scopes': 'warn', 'needs-reauth': 'bad', disconnected: 'warn', unconfigured: 'bad',
}
const LABEL: Record<string, string> = {
  ready: 'Connected', 'missing-scopes': 'Needs more access', 'needs-reauth': 'Reconnect needed', disconnected: 'Not connected', unconfigured: 'Not set up',
}

const stateOf = (s: StravaStatus | null) => (s ? (s.state || (!s.configured ? 'unconfigured' : !s.connected ? 'disconnected' : s.needsReauth ? 'needs-reauth' : 'ready')) : 'disconnected')

export function useStravaStatus(enabled = true) {
  const [status, setStatus] = useState<StravaStatus | null>(null)
  const reload = useCallback(async () => {
    if (!enabled) return
    try { setStatus(await getStravaStatus()) }
    catch (e) { if (!(e instanceof AuthError)) setStatus(null) }
  }, [enabled])
  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    if (!enabled) return
    const onFocus = () => reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, reload])
  return { status, reload }
}

const ago = (iso: string | null | undefined) => {
  if (!iso) return null
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

const mi = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v).toLocaleString()} mi`)

function Totals({ stats }: { stats: any }) {
  if (!stats || stats.error) return stats?.error ? <p className="app-row-desc muted">Totals unavailable: {stats.error}</p> : null
  const row = (label: string, s: any) => (
    <div className="strava-total" key={label}>
      <span className="strava-total-label">{label}</span>
      <span><strong>{mi(s?.recent?.distanceMi)}</strong><em>4 wk</em></span>
      <span><strong>{mi(s?.ytd?.distanceMi)}</strong><em>this year</em></span>
      <span><strong>{mi(s?.all?.distanceMi)}</strong><em>all time</em></span>
    </div>
  )
  return (
    <div className="strava-totals">
      {row('Rides', stats.ride)}
      {row('Runs', stats.run)}
      {stats.swim?.all?.count ? row('Swims', stats.swim) : null}
    </div>
  )
}

function Gear({ gear }: { gear: any }) {
  const bikes = gear?.bikes || []
  if (!bikes.length) return null
  return (
    <div className="strava-gear">
      {bikes.map((b: any) => (
        <span key={b.id} className={`skill-var-chip ${b.retired ? '' : 'used'}`} title={[b.brand, b.model].filter(Boolean).join(' ') || b.id}>
          {b.name || b.id} · {mi(b.distanceMi)}{b.primary ? ' · primary' : ''}{b.retired ? ' · retired' : ''}
        </span>
      ))}
    </div>
  )
}

/** The Connections-tab row for Strava. Renders inside the WHOOP panel's list. */
export function StravaConnectionRow() {
  const { status, reload } = useStravaStatus(true)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [stats, setStats] = useState<any>(null)
  const [gear, setGear] = useState<any>(null)
  const state = stateOf(status)
  const tone = TONE[state]

  // Totals and gear are two live API reads, so they are fetched only when the
  // row is open and the grant is healthy — not on every Connections load.
  useEffect(() => {
    if (!expanded || state !== 'ready') return
    let cancelled = false
    getStravaStats().then((s) => { if (!cancelled) setStats(s) }).catch((e) => { if (!cancelled) setStats({ error: e.message }) })
    getStravaGear().then((g) => { if (!cancelled) setGear(g) }).catch(() => { if (!cancelled) setGear(null) })
    return () => { cancelled = true }
  }, [expanded, state, status?.connectedAt])

  if (!status) return null

  async function run(label: string, fn: () => Promise<any>, after?: (r: any) => void) {
    setBusy(label)
    try { after?.(await fn()) }
    catch (e: any) { pushError(e?.message || `${label} failed`) }
    finally { setBusy(null); reload() }
  }

  const connect = () => run('connect', connectStrava, ({ authUrl }) => {
    window.open(authUrl, '_blank', 'noopener')
    pushToast('Finish authorizing on Strava in the new tab, then come back — this updates itself. On a phone, swap localhost for the box\'s Tailscale IP if the callback fails to load.', 'info', { duration: 9000 })
  })
  const sync = (full: boolean) => run(full ? 'full' : 'sync', () => syncStrava({ full }), (r) => {
    pushSuccess(`${r.added} new, ${r.updated} refreshed — ${r.count} activities cached${r.complete ? '' : ' (more history remains; run again)'}`)
  })
  const disconnect = () => {
    if (!window.confirm('Disconnect Strava? Totem forgets the grant and asks Strava to revoke it. Cached activities stay on disk.')) return
    run('disconnect', disconnectStrava, () => pushSuccess('Strava disconnected.'))
  }

  const fresh = state === 'disconnected' || state === 'unconfigured'
  const rl = status.rateLimit?.read || status.rateLimit?.overall

  return (
    <section className={`app-row ${expanded ? 'open' : ''} ${state === 'ready' ? '' : 'disabled'}`}>
      <button className="app-row-head" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <span className="connection-icon fallback" style={{ width: 30, height: 30, background: '#fc4c02' }}>
          <Hi icon={MapIcon} size={17} />
        </span>
        <span className="app-row-title">
          <strong>Strava</strong>
          <span>strava.com · rides, runs, mileage, gear{status.athlete?.name ? ` · ${status.athlete.name}` : ''}</span>
        </span>
        <span className="app-row-status">
          <span className={`app-row-chip ${tone === 'ok' ? 'on' : tone}`}>{LABEL[state]}</span>
        </span>
        <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${expanded ? 'up' : ''}`} />
      </button>

      {expanded && (
        <div className="app-row-body">
          <p className="app-row-desc">
            Every ride, run and walk with distance, speed, elevation, heart rate and power, plus each bike's odometer.
            Agents read it through <code>strava/cli.mjs</code> and the gateway's <code>strava__*</code> tools; ChatGPT and
            Claude through the <code>totem_strava_*</code> MCP tools; Bushido attaches rides to its sessions from it.
            See <code>docs/strava.md</code>.
          </p>

          {state !== 'ready' && (
            <div className={`whoop-note ${tone}`}>
              <Hi icon={ExclamationTriangleIcon} size={13} />
              <span>
                {status.detail || LABEL[state]}
                {status.lastError && state === 'needs-reauth' ? <> <span className="muted">({status.lastError})</span></> : null}
              </span>
            </div>
          )}

          {state === 'ready' && <Totals stats={stats} />}
          {state === 'ready' && <Gear gear={gear} />}

          {status.connectedAt && (
            <p className="app-row-desc muted">
              Grant last written {new Date(status.connectedAt).toLocaleString()}
              {status.cache?.count ? <> · {status.cache.count.toLocaleString()} activities cached{status.cache.updatedAt ? `, updated ${ago(status.cache.updatedAt)}` : ''}{status.cache.complete ? '' : ' (history incomplete)'}</> : ' · nothing cached yet'}
              {rl ? <> · API budget {rl.usage15}/{rl.limit15} this quarter-hour, {rl.usageDay}/{rl.limitDay} today</> : null}
            </p>
          )}

          {status.scopes?.length ? (
            <div className="whoop-scopes">
              {status.scopes.map((s) => (
                <span key={s} className="skill-var-chip used" title="Granted"><Hi icon={CheckCircleIcon} size={11} /> {s}</span>
              ))}
              {status.missingScopes?.map((s) => (
                <span key={s} className="skill-var-chip" title="Not granted — reconnect to add it">{s}</span>
              ))}
            </div>
          ) : null}

          <div className="app-row-controls">
            <button
              className={`btn compact ${state === 'needs-reauth' ? 'primary' : ''}`}
              onClick={connect}
              disabled={busy !== null || status.configured === false}
              title={status.configured === false ? 'Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env first' : fresh ? 'Authorize this dashboard to read your Strava data' : 'Authorize again — use this whenever calls start failing or a scope is missing'}
            >
              {busy === 'connect' ? 'Opening…' : fresh ? 'Connect Strava' : 'Reconnect Strava'}
            </button>
            {state === 'ready' && (
              <>
                <button className="btn compact ghost" onClick={() => sync(false)} disabled={busy !== null} title="Fetch new and recently edited activities into the local cache">
                  <Hi icon={ArrowPathIcon} size={13} /> {busy === 'sync' ? 'Syncing…' : 'Sync now'}
                </button>
                <button className="btn compact ghost" onClick={() => sync(true)} disabled={busy !== null} title="Walk back through your whole history, a few hundred activities per run">
                  {busy === 'full' ? 'Syncing…' : status.cache?.complete ? 'Re-read history' : 'Sync history'}
                </button>
              </>
            )}
            {status.connected && (
              <button className="btn compact ghost" onClick={disconnect} disabled={busy !== null}>Disconnect</button>
            )}
            <button className="btn compact ghost" onClick={reload} title="Re-read the saved grant">Refresh status</button>
          </div>

          {status.redirectUri && (
            <p className="app-row-desc muted">
              Redirect URI: <code>{status.redirectUri}</code> — the app's "Authorization Callback Domain" at strava.com/settings/api must be its host
              (<code>localhost</code> is whitelisted by Strava).
            </p>
          )}
        </div>
      )}
    </section>
  )
}
