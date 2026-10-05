import React, { useCallback, useEffect, useState } from 'react'
import { Hi, ChevronDownIcon, HeartIcon, ArrowPathIcon, ExclamationTriangleIcon, CheckCircleIcon } from '../icons'
import { getWhoopStatus, connectWhoop, AuthError } from '../api'
import { pushToast, pushError } from '../toast'
import { StravaConnectionRow } from './StravaConnection'

// The WHOOP connection, in one place so every surface tells the same story.
//
// The bug this exists to prevent: "connected" used to mean nothing more than "a
// refresh token is on disk". WHOOP rotates that token on every exchange and kills
// the old pair immediately, so when a rotation response is lost — a gateway 502 in
// front of WHOOP is the observed case — the stored token is dead but `connected`
// stays `true` forever. The Habits tab therefore hid its Connect button and
// offered a Sync that could only fail, with no way to reconnect from the UI.
//
// So: reconnect is always available, never conditional on a health check that
// can be wrong. The server's `state` drives the wording, not the button's
// existence.

export interface WhoopStatus {
  configured: boolean
  connected: boolean
  needsReauth?: boolean
  state?: 'unconfigured' | 'disconnected' | 'needs-reauth' | 'missing-scopes' | 'ready'
  detail?: string
  lastError?: string | null
  lastErrorAt?: string | null
  scopes?: string[]
  missingScopes?: string[]
  connectedAt?: string | null
  redirectUri?: string
  valueField?: string
}

/** Poll-free WHOOP status with a manual `reload`. Shared by Habits and Connections. */
export function useWhoopStatus(enabled = true) {
  const [status, setStatus] = useState<WhoopStatus | null>(null)

  const reload = useCallback(async () => {
    if (!enabled) return
    try { setStatus(await getWhoopStatus()) }
    catch (e) { if (!(e instanceof AuthError)) setStatus(null) }
  }, [enabled])

  useEffect(() => { reload() }, [reload])
  // A reconnect finishes in another tab, so re-check when this one is focused
  // again rather than making the user reload to see it worked.
  useEffect(() => {
    if (!enabled) return
    const onFocus = () => reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, reload])

  return { status, reload }
}

const TONE: Record<string, 'ok' | 'warn' | 'bad'> = {
  ready: 'ok',
  'missing-scopes': 'warn',
  'needs-reauth': 'bad',
  disconnected: 'warn',
  unconfigured: 'bad',
}

const LABEL: Record<string, string> = {
  ready: 'Connected',
  'missing-scopes': 'Needs more access',
  'needs-reauth': 'Reconnect needed',
  disconnected: 'Not connected',
  unconfigured: 'Not set up',
}

function stateOf(status: WhoopStatus | null): string {
  if (!status) return 'disconnected'
  if (status.state) return status.state
  // Older bridge without the `state` field — derive the same thing.
  if (!status.configured) return 'unconfigured'
  if (!status.connected) return 'disconnected'
  if (status.needsReauth) return 'needs-reauth'
  if (status.missingScopes?.length) return 'missing-scopes'
  return 'ready'
}

/**
 * Start the OAuth flow in a new tab.
 *
 * Always enabled when WHOOP is configured, including when the status says
 * everything is fine — a token can be dead while the server still believes it
 * isn't, and that is precisely when you need this button.
 */
export function WhoopConnectButton({
  status,
  onDone,
  className = 'btn compact',
}: {
  status: WhoopStatus | null
  onDone?: () => void
  className?: string
}) {
  const [busy, setBusy] = useState(false)
  const state = stateOf(status)
  const fresh = state === 'disconnected' || state === 'unconfigured'

  async function go() {
    setBusy(true)
    try {
      const { authUrl } = await connectWhoop()
      window.open(authUrl, '_blank', 'noopener')
      pushToast('Finish authorizing in the new tab, then come back — this will update itself.', 'info', { duration: 7000 })
      onDone?.()
    } catch (e: any) {
      pushError(e?.message || 'Could not start the WHOOP sign-in.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className={`${className} ${state === 'needs-reauth' ? 'primary' : ''}`}
      onClick={go}
      disabled={busy || status?.configured === false}
      title={status?.configured === false
        ? 'Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in .env first'
        : fresh
          ? 'Authorize this dashboard to read your WHOOP data'
          : 'Authorize again — use this whenever the sync starts failing'}
    >
      {busy ? 'Opening…' : fresh ? 'Connect WHOOP' : 'Reconnect WHOOP'}
    </button>
  )
}

/** The one-line health note. Rendered wherever the sync can be triggered. */
export function WhoopStatusNote({ status }: { status: WhoopStatus | null }) {
  const state = stateOf(status)
  if (state === 'ready') return null
  const tone = TONE[state]
  return (
    <div className={`whoop-note ${tone}`}>
      <Hi icon={ExclamationTriangleIcon} size={13} />
      <span>
        {status?.detail || LABEL[state]}
        {status?.lastError && state === 'needs-reauth' ? <> <span className="muted">({status.lastError})</span></> : null}
      </span>
    </div>
  )
}

/**
 * The Connections-tab row. WHOOP is neither an MCP app nor a keyless data source,
 * so it gets its own tier — but it was previously in neither, which meant the only
 * place to manage it was a button buried in one habit's chart header.
 */
export function WhoopConnectionPanel({ onAuthError }: { onAuthError?: () => void }) {
  const { status, reload } = useWhoopStatus(true)
  const [expanded, setExpanded] = useState(false)
  const state = stateOf(status)
  const tone = TONE[state]

  // Strava has its own row and its own status; this panel only owns the section
  // and the WHOOP row. Rendered even before WHOOP's status arrives so the Strava
  // row is never held hostage to it.
  return (
    <div className="app-group">
      <div className="settings-section-title"><span /><strong>Wearables &amp; fitness</strong></div>
      <p className="app-row-hint">
        OAuth integrations Totem holds a token for directly. Reconnecting is always safe — it replaces the
        saved grant with a fresh one.
      </p>
      <div className="app-list">
        {status && <section className={`app-row ${expanded ? 'open' : ''} ${state === 'ready' ? '' : 'disabled'}`}>
          <button className="app-row-head" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            <span className="connection-icon fallback" style={{ width: 30, height: 30, background: '#d4204c' }}>
              <Hi icon={HeartIcon} size={17} />
            </span>
            <span className="app-row-title">
              <strong>WHOOP</strong>
              <span>whoop.com · sleep, workouts, recovery</span>
            </span>
            <span className="app-row-status">
              <span className={`app-row-chip ${tone === 'ok' ? 'on' : tone}`}>{LABEL[state]}</span>
            </span>
            <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${expanded ? 'up' : ''}`} />
          </button>

          {expanded && (
            <div className="app-row-body">
              <p className="app-row-desc">
                Fills the sleep habit each morning and gives Bushido per-session heart rate, recovery and max
                heart rate. See <code>docs/whoop-sleep-ingest.md</code>.
              </p>

              <WhoopStatusNote status={status} />

              {status.connectedAt && (
                <p className="app-row-desc muted">
                  Grant last written {new Date(status.connectedAt).toLocaleString()}.
                </p>
              )}

              {status.scopes?.length ? (
                <div className="whoop-scopes">
                  {status.scopes.map((s) => (
                    <span key={s} className="skill-var-chip used" title="Granted">
                      <Hi icon={CheckCircleIcon} size={11} /> {s}
                    </span>
                  ))}
                  {status.missingScopes?.map((s) => (
                    <span key={s} className="skill-var-chip" title="Not granted — reconnect to add it">{s}</span>
                  ))}
                </div>
              ) : null}

              <div className="app-row-controls">
                <WhoopConnectButton status={status} onDone={reload} />
                <button className="btn compact ghost" onClick={reload} title="Re-read the saved grant">
                  <Hi icon={ArrowPathIcon} size={13} /> Refresh status
                </button>
              </div>

              {status.redirectUri && (
                <p className="app-row-desc muted">
                  Redirect URI (must match the WHOOP developer dashboard byte for byte):{' '}
                  <code>{status.redirectUri}</code>
                </p>
              )}
            </div>
          )}
        </section>}
        <StravaConnectionRow />
      </div>
    </div>
  )
}
