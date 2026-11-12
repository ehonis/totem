import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthError } from '../api'
import type { NavTarget } from '../router'
import { useAiUsageLive } from '../useAiUsageLive'
import {
  Hi,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CubeIcon,
  EllipsisHorizontalIcon,
  KeyIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  WarnIcon,
  XMarkIcon,
} from '../icons'
import { ProviderLogo } from '../chat/ui'
import { QuotaGraphs } from './pool/QuotaGraphs'
import { Switch } from '../components/settings/ui'
import {
  accountTone,
  isScopedMeter,
  poolSentence,
  providerGroups,
  stateLabel,
  whenLabel,
  type ProviderGroup,
} from '../usagePools'
import {
  claimGrant,
  consumeCredit,
  deleteAccount,
  getAccountModels,
  getGrants,
  getLoginStatus,
  getProxy,
  patchAccount,
  refreshAccountLogin,
  refreshAllLogins,
  resetAccountCooldown,
  setAccountDisabled,
  startLogin,
  submitLoginCallback,
  cancelLogin,
  type GrantInfo,
  type ProxyAccount,
  type ProxyOverview,
} from './api'
import './cliproxy.css'

// The CLIProxy tab: every Claude and Codex login the proxy pools, with what it has
// left and what can be done to it. Quota rides the live usage stream (the same
// numbers as the pills); the rest is the proxy's own list, re-read every 30 s and
// after every change. docs/cliproxy.md.

const QUOTA_FIELDS = ['meters', 'state', 'headroomPct', 'limitedUntil', 'plan', 'planSize', 'fetchedAt', 'passive', 'stale', 'servingRecently', 'authProblem', 'displayName', 'resetCredits', 'activeError', 'hidden'] as const

function ago(ts?: number | string | null) {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts
  if (!t) return ''
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

function useMessage() {
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((text: string, bad = false) => {
    setMessage({ text, bad })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setMessage(null), bad ? 9000 : 5000)
  }, [])
  return { message, say }
}

type MenuItem = { label: string; icon?: any; glyph?: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }

function Menu({ items, buttonClass = 'icon-btn', label = 'More actions', trigger, className = '' }: { items: (MenuItem | null)[]; buttonClass?: string; label?: string; trigger?: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  // A disclosure of plain buttons: Tab reaches them, and closing hands focus back.
  const close = useCallback((refocus: boolean) => { setOpen(false); if (refocus) button.current?.focus() }, [])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(ref.current?.contains(document.activeElement) ?? false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, close])
  return (
    <div className={`cp-menu ${className}`} ref={ref}>
      <button ref={button} type="button" className={buttonClass} aria-label={trigger ? undefined : label} title={trigger ? undefined : label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {trigger ?? <Hi icon={EllipsisHorizontalIcon} size={18} />}
      </button>
      {open && (
        <div className="cp-menu-list">
          {items.filter(Boolean).map((item) => (
            <button key={item!.label} type="button" disabled={item!.disabled} className={item!.danger ? 'danger' : ''}
              onClick={() => { close(true); item!.onClick() }}>
              {item!.glyph ?? <Hi icon={item!.icon} size={15} />} {item!.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Bars({ recent }: { recent: { success: number; failed: number }[] }) {
  const max = Math.max(1, ...recent.map((b) => b.success + b.failed))
  return (
    <span className="cp-bars" aria-label="Requests over the last 200 minutes">
      {recent.map((b, i) => (
        <i key={i} title={`${b.success} ok, ${b.failed} failed`} style={{ height: `${Math.max(8, ((b.success + b.failed) / max) * 100)}%` }} className={b.failed > b.success ? 'bad' : b.success + b.failed === 0 ? 'none' : ''} />
      ))}
    </span>
  )
}

function MeterRow({ m }: { m: any }) {
  const left = Math.max(0, Math.min(100, Math.round(m.remainingPct)))
  const tone = left < 2 ? 'crit' : left < 25 ? 'low' : ''
  return (
    <div className={`cp-meter ${tone} ${isScopedMeter(m) ? 'scoped' : ''}`}>
      <span className="cp-meter-label">{m.label}</span>
      <span className="cp-meter-bar"><i style={{ width: `${left}%` }} /></span>
      <span className="cp-meter-left">{left}% left</span>
      <span className="cp-meter-reset">{m.refilled ? 'refilled' : m.resetsAt ? `resets ${whenLabel(m.resetsAt)}` : ''}</span>
    </div>
  )
}

function GrantBox({ account, onDone, say, outerBusy }: { account: ProxyAccount; onDone: () => void; say: (t: string, bad?: boolean) => void; outerBusy: boolean }) {
  const [info, setInfo] = useState<GrantInfo | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    getGrants(account.name).then((g) => { if (live) setInfo(g) }).catch(() => { if (live) setInfo(null) })
    return () => { live = false }
  }, [account.name, account.state])
  if (!info || !info.eligible || (!info.left && !info.pending)) return null
  const usable = Boolean(info.grantId) || Boolean(info.pending)
  const claim = async () => {
    if (!window.confirm(`Use a reset grant on ${account.email || account.name}? It clears its limit now and cannot be undone (${info.left} left).`)) return
    setBusy(true)
    try {
      const r = await claimGrant(account.name, info.pending?.grantId || info.grantId)
      if (r.result === 'reset') say(`Limit reset on ${account.email || account.name}.`)
      else if (r.result === 'unknown') say('No answer from Anthropic. It may have gone through: check the usage, then try again (it will not be spent twice).', true)
      else say(`Not reset: ${r.result.replace(/_/g, ' ')}.`, true)
      onDone()
    } catch (e: any) {
      say(e.message, true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cp-callout">
      <span>Reset grant: {info.left} left{info.pending ? ' · last try had no answer' : ''}{!usable && info.blocker ? ` · ${info.blocker.replace(/_/g, ' ')}` : ''}</span>
      <button type="button" className="btn compact" disabled={busy || !usable || outerBusy} onClick={claim}>{info.pending ? 'Try again' : 'Use one'}</button>
    </div>
  )
}

function AccountCard({ account, act, busy, onEdit, onModels, onSignIn, say, reload }: {
  account: ProxyAccount
  busy: boolean
  act: (label: string, fn: () => Promise<unknown>, done?: string) => Promise<void>
  onEdit: () => void
  onModels: () => void
  onSignIn: () => void
  say: (t: string, bad?: boolean) => void
  reload: () => void
}) {
  const who = account.email || account.name
  const state = stateLabel(account) || (account.state === 'low' ? 'Low' : 'Ready')
  const meters = (account.meters || []).filter((m: any) => typeof m.remainingPct === 'number')
  const cooldowns = account.cooldowns || []
  const cooldown = cooldowns.filter((c) => c.scope === 'credential').reduce((m, c) => Math.max(m, c.until), 0)
  const modelCooldowns = cooldowns.filter((c) => c.scope === 'model' && c.until > Date.now())
  const fileName = account.displayName !== account.email ? account.email : null
  return (
    <article className={`cp-card ${accountTone(account)} ${account.stale ? 'stale' : ''}`}>
      <header className="cp-card-head">
        <span className={`cp-dot s-${account.state || 'ok'}`} aria-hidden />
        <div className="cp-card-title">
          <strong title={account.name}>{account.displayName || who}</strong>
          <small>{[fileName, account.plan].filter(Boolean).join(' · ')}</small>
        </div>
        <span className={`cp-state s-${account.state || 'ok'}`}>{account.servingRecently && account.state !== 'disabled' ? <><i className="cp-live" /> In use</> : state}</span>
        <Switch checked={!account.disabled} label={account.disabled ? `Turn on ${who}` : `Turn off ${who}`}
          onChange={(on) => act(on ? 'Turning on' : 'Turning off', () => setAccountDisabled(account.name, !on), on ? `${who} is on.` : `${who} is off. The proxy will not route to it.`)} />
        <Menu items={[
          { label: 'Refresh login token', icon: KeyIcon, disabled: account.disabled || account.runtimeOnly, onClick: () => { if (window.confirm(`Ask the proxy to refresh ${who}'s login token now?`)) void act('Refreshing', () => refreshAccountLogin(account.name), `Refreshed ${who}.`) } },
          { label: 'Edit…', icon: PencilIcon, onClick: onEdit },
          { label: 'Models…', icon: CubeIcon, onClick: onModels },
          { label: 'Sign in again…', icon: ArrowTopRightOnSquareIcon, onClick: onSignIn },
          { label: 'Delete…', icon: TrashIcon, danger: true, disabled: account.runtimeOnly, onClick: () => {
            if (window.confirm(`Delete ${who} from the proxy? Its login file is removed and the proxy stops using it. Signing in again brings it back.`)) void act('Deleting', () => deleteAccount(account.name), `Deleted ${who}.`)
          } },
        ]} />
      </header>

      {account.authProblem && (
        <div className="cp-callout bad">
          <span>{account.statusReason || 'This login needs signing in again.'}</span>
          <button type="button" className="btn compact primary" onClick={onSignIn}>Sign in again</button>
        </div>
      )}
      {account.state === 'error' && !account.authProblem && account.error && <div className="cp-note bad">{account.error}</div>}

      {meters.length > 0 && account.state !== 'disabled' && (
        <div className="cp-meters">{meters.map((m: any) => <MeterRow key={m.key || m.label} m={m} />)}</div>
      )}

      {(cooldown > Date.now() || modelCooldowns.length > 0) && (
        <div className="cp-callout">
          <span>
            {cooldown > Date.now() ? `Cooling down, back ${whenLabel(cooldown)}` : 'Cooling down'}
            {modelCooldowns.length > 0 && <> · {modelCooldowns.slice(0, 4).map((c) => <code key={c.model || ''}>{c.model}</code>)}</>}
          </span>
          <button type="button" className="btn compact" onClick={() => {
            if (window.confirm(`Clear the proxy's cooldown on ${who}? It will be tried again at once, even if the provider is still refusing it.`)) void act('Resetting', () => resetAccountCooldown(account.name), `Cooldown cleared on ${who}.`)
          }}>Reset cooldown</button>
        </div>
      )}

      {account.backend === 'claude' && account.state === 'limited' && !account.disabled && <GrantBox account={account} onDone={reload} say={say} outerBusy={busy} />}
      {account.backend === 'codex' && (account.resetCredits ?? 0) > 0 && account.state === 'limited' && !account.disabled && (
        <div className="cp-callout">
          <span>Reset credits: {account.resetCredits} left</span>
          <button type="button" className="btn compact" disabled={busy} onClick={() => {
            if (!window.confirm(`Use one of ${who}'s ${account.resetCredits} reset credits? It clears its limit now and cannot be undone.`)) return
            void act('Using a credit', async () => {
              const r = await consumeCredit(account.name)
              if (r.result === 'unknown') say('No answer from ChatGPT. It may have gone through: check the usage, then try again (it will not be spent twice).', true)
              else say(`Limit reset on ${who}.`)
            })
          }}>Use one</button>
        </div>
      )}

      <footer className="cp-card-foot">
        {(account.recent || []).length > 0 && <Bars recent={account.recent} />}
        {!account.stale && <span>{(account.successCount ?? 0).toLocaleString()} ok · {(account.failedCount ?? 0).toLocaleString()} failed</span>}
        {account.priority ? <span>priority {account.priority}</span> : null}
        {account.weight ? <span>weight {account.weight}</span> : null}
        {account.note && account.note !== account.displayName ? <span title="Note">{account.note}</span> : null}
        <span className="cp-src">
          {account.passive ? `From its last request ${ago(account.fetchedAt)}` : account.fetchedAt ? `Read ${ago(account.fetchedAt)}` : ''}
          {account.stale ? ' · stale' : ''}
        </span>
      </footer>
    </article>
  )
}

function EditDialog({ account, onClose, act }: { account: ProxyAccount; onClose: () => void; act: (label: string, fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [note, setNote] = useState(account.note || '')
  const [priority, setPriority] = useState(account.priority == null ? '' : String(account.priority))
  const [weight, setWeight] = useState(account.weight == null ? '' : String(account.weight))
  const [websockets, setWebsockets] = useState(Boolean(account.websockets))
  const [error, setError] = useState('')
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const fields: any = {}
    if (note.trim() !== (account.note || '')) fields.note = note.trim()
    const p = priority.trim() === '' ? null : Number(priority)
    if (p !== account.priority && !(p === null && !account.priority)) {
      if (p !== null && !Number.isInteger(p)) return setError('Priority is a whole number.')
      fields.priority = p
    }
    const w = weight.trim() === '' ? null : Number(weight)
    if (w !== account.weight) {
      if (w !== null && (!Number.isInteger(w) || w < 0)) return setError('Weight is a whole number, 0 or more.')
      fields.weight = w
    }
    if (account.backend === 'codex' && websockets !== Boolean(account.websockets)) fields.websockets = websockets
    if (!Object.keys(fields).length) return onClose()
    await act('Saving', () => patchAccount(account.name, fields), 'Saved.')
    onClose()
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="event-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div><div className="modal-kicker">Edit login</div><h2>{account.email || account.name}</h2></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>
        <form className="todo-form" onSubmit={save}>
          <label className="field"><span>Name in Totem (the proxy's note)</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={account.email || ''} /></label>
          <label className="field"><span>Priority (higher is tried first)</span><input inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="0" /></label>
          <label className="field"><span>Weight (share of traffic when weighted)</span><input inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="none" /></label>
          {account.backend === 'codex' && (
            <label className="cp-check"><input type="checkbox" checked={websockets} onChange={(e) => setWebsockets(e.target.checked)} /> Use websockets for this login</label>
          )}
          {error && <p className="cp-note bad">{error}</p>}
          <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn primary">Save</button></div>
        </form>
      </div>
    </div>
  )
}

function ModelsDialog({ account, onClose }: { account: ProxyAccount; onClose: () => void }) {
  const [models, setModels] = useState<{ id: string; name: string | null }[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { getAccountModels(account.name).then((r) => setModels(r.models)).catch((e) => setError(e.message)) }, [account.name])
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="event-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div><div className="modal-kicker">Models this login can use</div><h2>{account.email || account.name}</h2></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>
        {error ? <p className="cp-note bad">{error}</p> : !models ? <p className="muted">Loading…</p> : !models.length ? <p className="muted">None reported.</p> : (
          <ul className="cp-models">{models.map((m) => <li key={m.id}><code>{m.id}</code>{m.name && m.name !== m.id ? <span className="muted"> {m.name}</span> : null}</li>)}</ul>
        )}
      </div>
    </div>
  )
}

type LoginStep = { state: string; url: string; provider: string; expiresAt: number; callback: string }

function LoginDialog({ initialProvider, forAccount, resume, onClose, onDone }: {
  initialProvider: 'claude' | 'codex' | null
  forAccount: string | null
  resume: { state: string; provider: string; startedAt: number; url?: string; expiresAt?: number; submitted?: boolean } | null
  onClose: () => void
  onDone: (text: string, bad?: boolean) => void
}) {
  const [provider, setProvider] = useState<'claude' | 'codex' | null>(initialProvider)
  const [step, setStep] = useState<LoginStep | null>(null)
  const [pasted, setPasted] = useState('')
  const [phase, setPhase] = useState<'pick' | 'starting' | 'open' | 'waiting' | 'done'>(resume ? (resume.submitted ? 'waiting' : 'open') : initialProvider ? 'starting' : 'pick')
  const [deadline, setDeadline] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [, tick] = useState(0)
  const state = step?.state || resume?.state || null
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const signInUrl = step?.url || resume?.url || null

  const begin = useCallback(async (p: 'claude' | 'codex') => {
    setProvider(p)
    setPhase('starting')
    setError('')
    try {
      setStep(await startLogin(p))
      setPhase('open')
    } catch (e: any) {
      setError(e.message)
      setPhase('pick')
    }
  }, [])

  useEffect(() => { if (initialProvider && !resume) void begin(initialProvider) }, [initialProvider, resume, begin])
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id) }, [])

  // The proxy finishes the sign-in on its own once it has the address; poll it.
  useEffect(() => {
    if (!state || (phase !== 'open' && phase !== 'waiting')) return
    let stop = false
    let misses = 0
    const poll = async () => {
      try {
        const r = await getLoginStatus(state)
        if (stop) return
        misses = 0
        if (r.status === 'ok') {
          setPhase('done')
          // What the proxy actually rewrote wins over what the owner meant to fix.
          const who = r.added || r.updated || forAccount
          const wrong = !r.added && r.updated && forAccount && r.updated !== forAccount
          const text = wrong
            ? `Signed in as ${r.updated}, not ${forAccount}. ${forAccount} still needs signing in: use a private window to pick it.`
            : `${r.added ? 'Added' : 'Signed in again:'} ${who || 'the login'}.${r.duplicate ? ` ${r.duplicate} is in the proxy twice now.` : ''}`
          onDoneRef.current(text, Boolean(wrong))
          return
        }
        if (r.status === 'error') { setError(r.error || 'Sign-in failed.'); setPhase('pick'); setStep(null); return }
      } catch (e: any) {
        if (stop || e instanceof AuthError) return
        // A blip is not the end of a sign-in the proxy may still finish.
        if (e?.status !== 404 && ++misses < 4) { timer = setTimeout(poll, 3000); return }
        setError(e.message)
        setPhase('pick')
        setStep(null)
        return
      }
      if (!stop) timer = setTimeout(poll, 3000)
    }
    let timer = setTimeout(poll, 3000)
    return () => { stop = true; clearTimeout(timer) }
  }, [state, phase, forAccount])

  const close = () => {
    if (state && phase !== 'done') void cancelLogin(state).catch(() => {})
    onClose()
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!state) return
    setError('')
    try {
      const r = await submitLoginCallback(state, pasted)
      if (r.expiresAt) setDeadline(r.expiresAt)
      setPhase('waiting')
    } catch (err: any) {
      setError(err.message)
    }
  }
  const expires = deadline || step?.expiresAt || resume?.expiresAt || (resume ? resume.startedAt + 600_000 : 0)
  const left = Math.max(0, Math.round((expires - Date.now()) / 1000))
  const name = (provider || resume?.provider) === 'codex' ? 'Codex' : 'Claude'
  const port = (provider || resume?.provider) === 'codex' ? 'localhost:1455' : 'localhost:54545'

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="event-modal cp-login" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div><div className="modal-kicker">{forAccount ? 'Sign in again' : 'Add a login'}</div><h2>{phase === 'pick' ? 'Which subscription?' : `${name}${forAccount ? `: ${forAccount}` : ''}`}</h2></div>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close"><Hi icon={XMarkIcon} size={20} /></button>
        </div>
        {phase === 'pick' && (
          <div className="cp-pick">
            {(['claude', 'codex'] as const).map((p) => (
              <button key={p} type="button" className="cp-pick-btn" onClick={() => begin(p)}>
                <ProviderLogo driver={p} name={p} size={22} /> {p === 'claude' ? 'Claude' : 'Codex (ChatGPT)'}
              </button>
            ))}
          </div>
        )}
        {phase === 'starting' && <p className="muted">Starting the sign-in…</p>}
        {(phase === 'open' || phase === 'waiting') && (
          <ol className="cp-steps">
            <li>
              {signInUrl ? <a className="btn primary" href={signInUrl} target="_blank" rel="noreferrer"><Hi icon={ArrowTopRightOnSquareIcon} size={15} /> Open the {name} sign-in</a>
                : <span className="muted">The sign-in page is open in another tab.</span>}
              <small>{forAccount ? <>Sign in as <b>{forAccount}</b>. </> : null}Use a private window to pick a different account than the one your browser is signed in to. If the {name} app opens instead, copy the link and open it in the browser.</small>
            </li>
            <li>
              <span>When it finishes, the browser lands on a page that does not load, at <code>{port}</code>. Copy that whole address and paste it here.</span>
              <form className="cp-paste" onSubmit={submit}>
                <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={`http://${port}/…?code=…&state=…`} disabled={phase === 'waiting'} autoFocus spellCheck={false} autoComplete="off" />
                <button type="submit" className="btn primary" disabled={!pasted.trim() || phase === 'waiting'}>{phase === 'waiting' ? 'Finishing…' : 'Submit'}</button>
              </form>
            </li>
          </ol>
        )}
        {phase === 'done' && <p>Done.</p>}
        {error && <p className="cp-note bad">{error}</p>}
        {(phase === 'open' || phase === 'waiting') && <p className="muted cp-expiry">This sign-in ends in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.</p>}
      </div>
    </div>
  )
}

export default function CliproxyView({ onAuthError, onNavigate }: { onAuthError: () => void; onNavigate: (t: NavTarget) => void }) {
  const [overview, setOverview] = useState<ProxyOverview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<ProxyAccount | null>(null)
  const [modelsOf, setModelsOf] = useState<ProxyAccount | null>(null)
  const [login, setLogin] = useState<{ provider: 'claude' | 'codex' | null; forAccount: string | null; resume: any } | null>(null)
  const { message, say } = useMessage()
  // Watching here is what puts the poller on its fast cadence.
  const live = useAiUsageLive({ onAuthError })

  const load = useCallback(async (retry = false) => {
    try {
      setOverview(await getProxy(retry))
      setError('')
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      setError(e.message)
    }
  }, [onAuthError])

  useEffect(() => {
    void load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  const act = useCallback(async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label)
    try {
      await fn()
      if (done) say(done)
    } catch (e: any) {
      if (e instanceof AuthError) { onAuthError(); return }
      say(e.message, true)
    } finally {
      setBusy(null)
      void load()
    }
  }, [load, onAuthError, say])

  // The live stream's quota wins over the list's copy of it.
  const accounts = useMemo(() => {
    const quota = new Map(((live.data?.accounts || []) as any[]).filter((a) => a.source === 'cliproxy').map((a) => [a.id, a]))
    return (overview?.accounts || []).map((a) => {
      const q = quota.get(a.id)
      if (!q) return a
      const merged: any = { ...a }
      for (const k of QUOTA_FIELDS) if (q[k] !== undefined) merged[k] = q[k]
      return merged as ProxyAccount
    })
  }, [overview, live.data])
  const groups = useMemo(() => providerGroups({ accounts: accounts.map((a) => ({ ...a, hidden: false })), pools: live.data?.pools || overview?.pools, providers: live.data?.providers }, { all: true }), [accounts, live.data, overview])
  const pendingLogin = overview?.logins?.[0] || null

  const head = (
    <header className="cp-head">
      <div>
        <h1><Hi icon={KeyIcon} size={20} /> CLIProxy</h1>
        <p className="muted">
          {overview?.configured
            ? `${accounts.length} login${accounts.length === 1 ? '' : 's'}${overview.url ? ` · ${(() => { try { return new URL(overview.url).host } catch { return overview.url } })()}` : ''}`
            : 'The proxy that holds your Claude and Codex logins.'}
        </p>
      </div>
      {overview?.configured && (
        <div className="cp-head-actions">
          <button type="button" className="btn cp-refresh" disabled={live.busy} onClick={() => live.forceRefresh()} aria-label="Refresh usage" title="Read every login's usage from the provider now">
            <Hi icon={ArrowPathIcon} size={15} className={live.busy ? 'spin' : ''} /> Refresh<span className="cp-refresh-more">usage</span>
          </button>
          <Menu buttonClass="btn cp-more" className="cp-more-menu" label="More proxy actions" items={[{
            label: 'Refresh login tokens', icon: ArrowPathIcon, disabled: Boolean(busy), onClick: () => {
              if (!window.confirm('Ask the proxy to refresh every login token now? It does this on its own when they near expiry.')) return
              void act('Refreshing logins', async () => {
                const r = await refreshAllLogins()
                const bad = r.results.filter((x) => !x.ok)
                say(bad.length ? `${bad.length} of ${r.results.length} failed: ${bad.map((b) => b.name).join(', ')}` : `Refreshed ${r.results.length} logins.`, bad.length > 0)
              })
            },
          }]} />
          <Menu buttonClass="btn primary" trigger={<><Hi icon={PlusIcon} size={15} /> Add login</>} items={(['claude', 'codex'] as const).map((provider) => ({
            label: provider === 'claude' ? 'Claude' : 'Codex',
            glyph: <ProviderLogo driver={provider} size={15} />,
            onClick: () => setLogin({ provider, forAccount: null, resume: null }),
          }))} />
        </div>
      )}
    </header>
  )

  if (!overview) {
    return <div className="view cp-view">{head}{error ? <div className="inline-warn"><WarnIcon /> {error}</div> : <p className="muted">Loading…</p>}</div>
  }

  if (!overview.configured) {
    return (
      <div className="view cp-view">
        {head}
        <div className="cp-setup">
          <p>Point Totem at your CLIProxyAPI and the usage limits show every Claude and Codex login it pools, and this page manages them: sign in new ones, switch them off, reset cooldowns, use reset grants.</p>
          <p>Set the proxy URL and a management key in Settings → Providers › CLIProxy. Use a scoped key: the proxy's full key can read every login's tokens. See <code>docs/cliproxy.md</code>.</p>
          <button type="button" className="btn primary" onClick={() => onNavigate({ tab: 'settings', sub: 'providers', hash: 'cliproxy' })}>Open settings</button>
        </div>
      </div>
    )
  }

  return (
    <div className="view cp-view">
      {head}
      {overview.reachable === false && (
        <div className="cp-banner bad">
          <WarnIcon /> {overview.code === 'bad_key' ? 'CLIProxy refused the management key. Update it in Settings → Providers › CLIProxy.' : `CLIProxy is not answering: ${overview.error}`}
          <button type="button" className="btn compact" onClick={() => load(true)}>Retry</button>
        </div>
      )}
      {pendingLogin && !login && (
        <div className="cp-banner">
          {pendingLogin.submitted
            ? `A ${pendingLogin.provider === 'codex' ? 'Codex' : 'Claude'} sign-in is finishing.`
            : `A ${pendingLogin.provider === 'codex' ? 'Codex' : 'Claude'} sign-in is waiting for its address.`}
          <button type="button" className="btn compact" onClick={() => setLogin({ provider: null, forAccount: null, resume: pendingLogin })}>Continue</button>
        </div>
      )}
      {message && <div className={`cp-banner ${message.bad ? 'bad' : 'good'}`} role="status">{message.text}</div>}
      {busy && <div className="cp-banner" role="status">{busy}…</div>}

      {!groups.length && overview.reachable !== false && (
        <div className="cp-setup"><p>The proxy has no Claude or Codex logins yet.</p><button type="button" className="btn primary" onClick={() => setLogin({ provider: null, forAccount: null, resume: null })}>Add a login</button></div>
      )}

      {accounts.length > 0 && <QuotaGraphs accounts={accounts} onAuthError={onAuthError} />}

      {groups.map((g: ProviderGroup) => (
        <section key={g.backend} className="cp-provider">
          <header className="cp-provider-head">
            <ProviderLogo driver={g.backend} name={g.name} size={20} />
            <h2>{g.name}</h2>
            <span className="muted">{poolSentence(g).replace(`${g.name}: `, '')}</span>
          </header>
          <div className="cp-cards">
            {g.accounts.map((a) => {
              const account = a as ProxyAccount
              return (
                <AccountCard key={account.id} account={account} act={act} busy={Boolean(busy)} say={say} reload={load}
                  onEdit={() => setEditing(account)} onModels={() => setModelsOf(account)}
                  onSignIn={() => setLogin({ provider: account.backend as 'claude' | 'codex', forAccount: account.email || account.name, resume: null })} />
              )
            })}
          </div>
        </section>
      ))}

      {editing && <EditDialog account={editing} onClose={() => setEditing(null)} act={act} />}
      {modelsOf && <ModelsDialog account={modelsOf} onClose={() => setModelsOf(null)} />}
      {login && (
        <LoginDialog initialProvider={login.provider} forAccount={login.forAccount} resume={login.resume}
          onClose={() => { setLogin(null); void load() }}
          onDone={(text, bad) => { setLogin(null); say(text, bad); void load(); void live.forceRefresh() }} />
      )}
    </div>
  )
}
