import React, { useCallback, useEffect, useRef, useState } from 'react'
import type RFB from '@novnc/novnc'
import { getSecret } from '../api'
import { bearerProtocol } from '../terminal/client'
import {
  Hi, ArrowPathIcon, ArrowsPointingInIcon, ArrowsPointingOutIcon, ClipboardDocumentIcon, ComputerDesktopIcon,
  EyeIcon, EyeSlashIcon, KeyIcon, LockClosedIcon, PowerIcon,
} from '../icons'
import {
  forgetLogin, openLogin, rememberChoice, saveLogin, savedLogin, screenEnabled, sealLogin, setRememberChoice,
  type MacLogin, type ScreenStatus,
} from './api'
import './screen.css'

// The desktop of the machine Totem runs on, through noVNC. The bridge only
// relays bytes to Screen Sharing (screen/relay.mjs); the Mac's own login is
// asked for here and kept in memory for reconnects until the page reloads, or,
// if the owner picks "remember for", sealed by the bridge for that long (the
// browser stores only the sealed token; screen/credentials.mjs).
//
// Desktop only: a phone has no use for driving a 5K screen with a thumb.

type Phase = 'connecting' | 'login' | 'connected' | 'disconnected'

// Never written to storage. Lives as long as the page does.
let rememberedCredentials: MacLogin | null = null

const DEFAULT_REMEMBER = [30, 60, 120, 300]
const durationLabel = (m: number) => m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

interface Props {
  status: ScreenStatus | null
  onRefreshStatus: () => Promise<void> | void
  narrow: boolean
}

export default function ScreenView({ status, onRefreshStatus, narrow }: Props) {
  if (narrow) {
    return (
      <StatePanel icon={ComputerDesktopIcon} title="Screen is for a computer">
        <p>Open Totem on a laptop or desktop to see and control this machine's screen.</p>
      </StatePanel>
    )
  }
  if (!status) return <div className="scr-state"><p className="muted">Checking the screen…</p></div>
  if (!screenEnabled(status)) {
    return (
      <StatePanel icon={ComputerDesktopIcon} title="Screen is off">
        <p>Totem shows its machine's screen only with <code>SCREEN_ENABLED=true</code> set.</p>
        {status.detail && <p className="muted">{status.detail}</p>}
      </StatePanel>
    )
  }
  if (status.viewer?.state !== 'ready') {
    return (
      <StatePanel icon={ComputerDesktopIcon} title="Screen Sharing isn't on">
        {status.viewer?.detail && <p className="scr-state-fix">{status.viewer.detail}</p>}
        <RetryButton onRetry={onRefreshStatus} />
      </StatePanel>
    )
  }
  return <Viewer wsPath={status.wsPath || '/api/screen/ws'} screenshots={status.screenshots} rememberMinutes={status.rememberMinutes || DEFAULT_REMEMBER} />
}

function Viewer({ wsPath, screenshots, rememberMinutes }: { wsPath: string; screenshots?: ScreenStatus['screenshots']; rememberMinutes: number[] }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const [phase, setPhase] = useState<Phase>('connecting')
  const [needs, setNeeds] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [desktop, setDesktop] = useState('')
  const [viewOnly, setViewOnly] = useState(false)
  const [fit, setFit] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [saved, setSaved] = useState(savedLogin)
  // A login typed with "remember for" is sealed only once the Mac accepts it.
  const pendingSeal = useRef<{ login: MacLogin; minutes: number } | null>(null)
  // The saved login is tried once per connection; if the Mac refuses it, ask.
  const triedSaved = useRef(false)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let rfb: RFB | null = null
    let cancelled = false
    setPhase('connecting')
    setMessage('')
    triedSaved.current = false
    import('@novnc/novnc').then(({ default: RFBClass }) => {
      if (cancelled) return
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const secret = getSecret()
      rfb = new RFBClass(stage, `${scheme}//${window.location.host}${wsPath}`, {
        wsProtocols: secret ? ['binary', bearerProtocol(secret)] : ['binary'],
        ...(rememberedCredentials ? { credentials: rememberedCredentials } : {}),
      })
      rfb.scaleViewport = fit
      rfb.viewOnly = viewOnly
      rfb.background = 'transparent'
      rfb.qualityLevel = 6
      rfbRef.current = rfb
      rfb.addEventListener('connect', () => {
        setPhase('connected')
        setMessage('')
        rfb?.focus()
        const pending = pendingSeal.current
        pendingSeal.current = null
        if (pending) {
          sealLogin(pending.login, pending.minutes)
            .then((sealed) => { saveLogin(sealed); setSaved(sealed) })
            .catch(() => setMessage('Connected, but Totem could not save the login.'))
        }
      })
      rfb.addEventListener('credentialsrequired', (e: any) => {
        setNeeds(e.detail?.types || ['password'])
        const stored = savedLogin()
        if (stored && !triedSaved.current) {
          triedSaved.current = true
          openLogin(stored.token)
            .then(({ username, password }) => {
              rememberedCredentials = username ? { username, password } : { password }
              rfb?.sendCredentials(rememberedCredentials)
            })
            .catch(() => {
              forgetLogin()
              setSaved(null)
              setMessage('The saved login has expired.')
              setPhase('login')
            })
          return
        }
        setPhase('login')
      })
      rfb.addEventListener('securityfailure', (e: any) => {
        rememberedCredentials = null
        pendingSeal.current = null
        forgetLogin()
        setSaved(null)
        setMessage(e.detail?.reason || 'The Mac turned down that login.')
      })
      rfb.addEventListener('desktopname', (e: any) => setDesktop(e.detail?.name || ''))
      rfb.addEventListener('disconnect', (e: any) => {
        rfbRef.current = null
        setPhase('disconnected')
        if (!e.detail?.clean) setMessage((m) => m || 'Lost the connection to the screen.')
      })
    }).catch((e) => {
      setPhase('disconnected')
      setMessage(`The viewer did not load: ${e?.message || e}`)
    })
    return () => {
      cancelled = true
      rfbRef.current = null
      try { rfb?.disconnect() } catch {}
    }
    // Reconnect only on purpose; fit and view-only are applied live below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsPath, attempt])

  useEffect(() => { if (rfbRef.current) rfbRef.current.scaleViewport = fit }, [fit])
  useEffect(() => { if (rfbRef.current) rfbRef.current.viewOnly = viewOnly }, [viewOnly])

  const login = (credentials: MacLogin, minutes: number) => {
    rememberedCredentials = credentials
    setRememberChoice(minutes)
    pendingSeal.current = minutes > 0 ? { login: credentials, minutes } : null
    setMessage('')
    setPhase('connecting')
    rfbRef.current?.sendCredentials(credentials)
  }

  const sendClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return setMessage('Your clipboard is empty.')
      rfbRef.current?.clipboardPasteFrom(text)
      setMessage('Clipboard sent. Press ⌘V on the Mac to paste it.')
    } catch {
      setMessage('The browser would not share your clipboard.')
    }
  }

  const fullScreen = () => {
    const el = stageRef.current?.parentElement
    if (!el) return
    if (document.fullscreenElement) document.exitFullscreen()
    else el.requestFullscreen?.().catch(() => {})
  }

  const forget = () => {
    forgetLogin()
    setSaved(null)
    rememberedCredentials = null
    setMessage('Forgot the saved login.')
  }

  const reconnect = useCallback(() => setAttempt((n) => n + 1), [])
  const savedUntil = saved && Date.parse(saved.expiresAt) > Date.now() ? saved.expiresAt : null
  const connected = phase === 'connected'

  return (
    <div className="scr">
      <div className="scr-bar">
        <span className={`scr-dot ${phase}`} aria-hidden="true" />
        <span className="scr-title">{connected ? (desktop || 'Connected') : phase === 'login' ? 'Sign in to the Mac' : phase === 'connecting' ? 'Connecting…' : 'Disconnected'}</span>
        {message && <span className="scr-msg">{message}</span>}
        <span className="scr-spacer" />
        {savedUntil && <span className="scr-saved" title="Totem signs in to the Mac for you until then">Login saved until {clock(savedUntil)}</span>}
        {savedUntil && <ToolButton label="Forget the saved login" icon={KeyIcon} onClick={forget} />}
        {screenshots && screenshots.state !== 'ready' && (
          <span className="scr-warn" title={screenshots.detail}>Agents can't take screenshots yet</span>
        )}
        <ToolButton label={viewOnly ? 'View only (click to control)' : 'Controlling (click for view only)'} icon={viewOnly ? EyeIcon : EyeSlashIcon} onClick={() => setViewOnly((v) => !v)} on={viewOnly} disabled={!connected} />
        <ToolButton label={fit ? 'Fit to window (click for actual size)' : 'Actual size (click to fit)'} icon={fit ? ArrowsPointingInIcon : ArrowsPointingOutIcon} onClick={() => setFit((f) => !f)} disabled={!connected} />
        <ToolButton label="Send your clipboard to the Mac" icon={ClipboardDocumentIcon} onClick={sendClipboard} disabled={!connected || viewOnly} />
        <ToolButton label="Full screen" icon={ComputerDesktopIcon} onClick={fullScreen} disabled={!connected} />
        {connected
          ? <ToolButton label="Disconnect" icon={PowerIcon} onClick={() => rfbRef.current?.disconnect()} />
          : phase === 'disconnected' && <ToolButton label="Reconnect" icon={ArrowPathIcon} onClick={reconnect} />}
      </div>
      <div className={`scr-stage${fit ? ' fit' : ''}`}>
        {/* Keys typed into the Mac belong to the Mac, not to Totem's leader-key shortcuts. */}
        <div ref={stageRef} className="scr-canvas" data-shortcuts-off />
        {phase === 'login' && <LoginCard needs={needs} message={message} durations={rememberMinutes} onSubmit={login} />}
      </div>
    </div>
  )
}

function LoginCard({ needs, message, durations, onSubmit }: { needs: string[]; message: string; durations: number[]; onSubmit: (c: MacLogin, minutes: number) => void }) {
  const [username, setUsername] = useState(rememberedCredentials?.username || '')
  const [password, setPassword] = useState('')
  const [minutes, setMinutes] = useState(() => durations.includes(rememberChoice()) ? rememberChoice() : 0)
  const wantsUser = needs.includes('username')
  return (
    <form className="scr-login" onSubmit={(e) => { e.preventDefault(); onSubmit(wantsUser ? { username, password } : { password }, minutes) }}>
      <Hi icon={LockClosedIcon} size={22} className="scr-login-icon" />
      <h2>Sign in to the Mac</h2>
      <p>{wantsUser ? 'The Mac account you would use at its own login screen.' : 'The Screen Sharing password set on the Mac.'}</p>
      {message && <p className="scr-login-error">{message}</p>}
      {wantsUser && (
        <input autoComplete="username" placeholder="Account name" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
      )}
      <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!wantsUser} />
      <label className="scr-remember">
        <span>Remember</span>
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          <option value={0}>Until this page reloads</option>
          {durations.map((m) => <option key={m} value={m}>For {durationLabel(m)}</option>)}
        </select>
      </label>
      <p className="scr-login-note">{minutes > 0
        ? 'Totem seals the login on the server. This browser keeps only a key that stops working when the time is up.'
        : 'Kept in memory only, never stored.'}</p>
      <button type="submit" className="btn primary" disabled={!password || (wantsUser && !username)}>Connect</button>
    </form>
  )
}

function ToolButton({ label, icon, onClick, disabled, on }: { label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; onClick: () => void; disabled?: boolean; on?: boolean }) {
  return (
    <button type="button" className={`scr-tool${on ? ' on' : ''}`} onClick={onClick} disabled={disabled} title={label} aria-label={label}>
      <Hi icon={icon} size={17} />
    </button>
  )
}

function StatePanel({ icon, title, children }: { icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; title: string; children: React.ReactNode }) {
  return (
    <div className="scr-state">
      <div className="scr-state-card">
        <Hi icon={icon} size={26} className="scr-state-icon" />
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

function RetryButton({ onRetry }: { onRetry: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false)
  return (
    <button type="button" className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await onRetry() } finally { setBusy(false) } }}>
      <Hi icon={ArrowPathIcon} size={15} />{busy ? 'Checking…' : 'Check again'}
    </button>
  )
}
