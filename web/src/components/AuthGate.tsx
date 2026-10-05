import React, { useEffect, useState } from 'react'
import { ApiError, checkSetupToken, getAuthStatus, getSecret, login, setSecret, setupOwner } from '../api'
import type { AuthStatus } from '../api'

interface AuthGateProps {
  onUnlock: () => void
}

const card = 'bg-bg-2 border border-solid border-line rounded-2xl p-7 w-[min(420px,100%)]'
const input = 'w-full bg-bg border border-solid border-line text-text rounded-[10px] px-3.5 py-[11px] font-[inherit] mb-3 outline-none focus:border-accent'

function message(e: unknown) {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

// The setup token from the one-time link (/setup?token=…), read once when the
// module loads. It has to be taken this early: App normalises the address bar on
// boot (/setup isn't a tab, and only ?thread= survives), and that runs before
// the setup form mounts, so reading the URL from the form found no token.
const SETUP_TOKEN = new URLSearchParams(window.location.search).get('token') || ''

/** The setup token from the one-time link, if this page was opened from it. */
function setupTokenFromUrl() {
  return SETUP_TOKEN
}

/**
 * Everything before the dashboard: first-run owner setup, password sign-in, and
 * the older "paste BRIDGE_SECRET" path for installs that use it.
 */
export default function AuthGate({ onUnlock }: AuthGateProps) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [loadError, setLoadError] = useState('')
  const [useSecret, setUseSecret] = useState(false)

  useEffect(() => {
    let cancelled = false
    getAuthStatus()
      .then((s) => {
        if (cancelled) return
        if (s.authenticated) return onUnlock()
        setStatus(s)
      })
      .catch((e) => {
        if (cancelled) return
        // A bridge from before sign-in existed answers 401/404 here. A saved
        // secret is then the only way in, so fall back to asking for it.
        if (getSecret() && e instanceof ApiError && e.status === 401) setUseSecret(true)
        else setLoadError(message(e))
      })
    return () => { cancelled = true }
  }, [onUnlock])

  if (useSecret) return <SecretForm onUnlock={onUnlock} onBack={status ? () => setUseSecret(false) : undefined} />
  if (loadError) {
    return (
      <Shell title="Totem">
        <p className="text-muted mt-0">Could not reach the Totem server: {loadError}</p>
        <button className="btn primary w-full" onClick={() => window.location.reload()}>Retry</button>
      </Shell>
    )
  }
  if (!status) return <div className="grid place-items-center h-full p-5 text-muted">Loading…</div>
  if (status.setupRequired) return <SetupForm onUnlock={onUnlock} />
  return <LoginForm onUnlock={onUnlock} onUseSecret={() => setUseSecret(true)} />
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid place-items-center h-full p-5">
      <div className={card}>
        <h2 className="mt-0 mb-1.5">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function SetupForm({ onUnlock }: { onUnlock: () => void }) {
  const token = setupTokenFromUrl()
  const [valid, setValid] = useState<boolean | null>(token ? null : false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) return
    checkSetupToken(token).then((r) => setValid(r.valid)).catch(() => setValid(false))
  }, [token])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) return setError('The two passwords do not match.')
    setBusy(true)
    setError('')
    try {
      await setupOwner(token, password)
      window.history.replaceState(null, '', '/')
      onUnlock()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  if (valid === null) return <Shell title="Set up Totem"><p className="text-muted m-0">Checking the setup link…</p></Shell>
  if (!valid) {
    return (
      <Shell title="Set up Totem">
        <p className="text-muted mt-0">
          This install has no owner account yet. Open the one-time setup link the server printed when it started
          (in its terminal output, <code>journalctl --user -u assistant-bridge</code>, or <code>docker compose logs</code>).
        </p>
        <p className="text-muted mb-0">Restarting the server prints a fresh link.</p>
      </Shell>
    )
  }
  return (
    <Shell title="Set up Totem">
      <form onSubmit={submit}>
        <p className="text-muted mt-0 mb-[18px]">Choose the owner password. You will use it to sign in to this dashboard.</p>
        <input type="password" autoFocus autoComplete="new-password" placeholder="Password (8+ characters)"
          value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
        <input type="password" autoComplete="new-password" placeholder="Confirm password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
        {error && <p className="text-[var(--danger,#e5484d)] mt-0">{error}</p>}
        <button className="btn primary w-full" type="submit" disabled={busy || !password}>Create owner account</button>
      </form>
    </Shell>
  )
}

function LoginForm({ onUnlock, onUseSecret }: { onUnlock: () => void; onUseSecret: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await login(password)
      onUnlock()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell title="Sign in to Totem">
      <form onSubmit={submit}>
        <input type="password" autoFocus autoComplete="current-password" placeholder="Password"
          value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
        {error && <p className="text-[var(--danger,#e5484d)] mt-0">{error}</p>}
        <button className="btn primary w-full" type="submit" disabled={busy || !password}>Sign in</button>
        <button type="button" className="btn ghost w-full mt-2" onClick={onUseSecret}>Use the bridge secret instead</button>
      </form>
    </Shell>
  )
}

function SecretForm({ onUnlock, onBack }: { onUnlock: () => void; onBack?: () => void }) {
  const [value, setValue] = useState('')
  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!value.trim()) return
    setSecret(value.trim())
    onUnlock()
  }
  return (
    <Shell title="Connect with the bridge secret">
      <form onSubmit={submit}>
        <p className="text-muted mt-0 mb-[18px]">
          Paste BRIDGE_SECRET from the server's <code>.env</code>. It is stored only in this browser.
        </p>
        <input type="password" autoFocus placeholder="BRIDGE_SECRET" value={value}
          onChange={(e) => setValue(e.target.value)} className={input} />
        <button className="btn primary w-full" type="submit">Connect</button>
        {onBack && <button type="button" className="btn ghost w-full mt-2" onClick={onBack}>Back to password sign-in</button>}
      </form>
    </Shell>
  )
}
