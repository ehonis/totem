import React, { useEffect, useState } from 'react'
import { ApiError, changePassword, clearSecret, createApprovalCode, getApprovalCodeStatus, getAuthStatus, logout } from '../../api'
import type { AuthStatus } from '../../api'
import { setApprovalCode, useHasApprovalCode, type ApprovalCodeStatus } from '../../approvalCode'
import { Hi, ArrowRightOnRectangleIcon, ClipboardDocumentIcon } from '../../icons'
import { pushError, pushSuccess } from '../../toast'
import { copyText } from '../../clipboard'
import { SettingsNote, SettingsPage, SettingsRow, SettingsSection } from './ui'

// Settings → Security: the approval code (auth/approval-code.mjs, the second
// credential that sending, running commands and opening prompts need, which an
// agent holding the bridge secret does not have), the password, and sign-out.

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : String(err))

function stateWord(status: ApprovalCodeStatus): { word: string; tone: string } {
  if (status.state === 'armed') return { word: 'On', tone: 'pill-ok' }
  if (status.state === 'missing' || status.state === 'tampered') return { word: 'Needs a new code', tone: 'pill-error' }
  return { word: 'Not set', tone: 'pill-warn' }
}

function ApprovalCodeSection() {
  const [status, setStatus] = useState<ApprovalCodeStatus | null>(null)
  const hasCode = useHasApprovalCode()
  const [password, setPassword] = useState('')
  const [entered, setEntered] = useState('')
  const [fresh, setFresh] = useState('')
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () => getApprovalCodeStatus().then(setStatus).catch(() => {})
  useEffect(() => { load() }, [])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setNote(null)
    try {
      const { code } = await createApprovalCode(password)
      setApprovalCode(code)
      setFresh(code)
      setPassword('')
      load()
    } catch (err) {
      setNote({ text: errorText(err), bad: true })
    } finally {
      setBusy(false)
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault()
    setApprovalCode(entered.trim())
    setEntered('')
    setNote({ text: 'Saved on this device.' })
  }

  if (!status) return null
  const armed = status.state === 'armed'
  const broken = status.state === 'missing' || status.state === 'tampered'
  const { word, tone } = stateWord(status)
  const summary = armed
    ? `Set ${status.setAt ? new Date(status.setAt).toLocaleDateString() : ''}. Sending, running commands and opening prompts ask for it. ${hasCode ? 'This device holds it.' : 'This device does not hold it yet.'}`
    : status.state === 'missing'
      ? 'Its file on the server is missing, so sends, commands and prompts are refused until you set a new one.'
      : status.state === 'tampered'
        ? `It changed outside Totem (${status.reason || 'the file is not the one Totem set'}), so sends, commands and prompts are refused until you set a new one. If you just ran npm run approval-code, restart Totem instead.`
        : status.state === 'legacy'
          ? 'Approvals rely on your sign-in alone, which an agent reading the server’s files could forge.'
          : 'Sending emails and messages, running commands and opening prompts wait until it is set.'

  return (
    <SettingsSection
      id="approval-code"
      title="Approval code"
      description="A second code the risky approvals need, so an agent holding the server’s secret still cannot approve its own sends."
      action={<span className={`pill ${tone}`}>{word}</span>}
    >
      <SettingsRow title="Status" description={summary} />
      {status.mode === 'password' ? (
        <SettingsRow
          id="approval-code-set"
          title={armed || broken ? 'Set a new code' : 'Set an approval code'}
          description="Re-enter your password. Devices holding an older code will need the new one."
          control={
            <form className="s-form" onSubmit={create}>
              <input className="s-input" type="password" autoComplete="current-password" placeholder="Password" aria-label="Password"
                value={password} onChange={(e) => setPassword(e.target.value)} />
              <button className="btn" type="submit" disabled={busy || !password}>{busy ? 'Setting…' : 'Set'}</button>
            </form>
          }
        />
      ) : (
        <SettingsRow title="Set an approval code" description={<>Behind an auth proxy there is no Totem password: run <code>npm run approval-code</code> in a terminal on the server.</>} />
      )}
      {fresh && (
        <SettingsRow
          title="Your new code"
          description="Saved on this device. Enter it on your other devices now; it is not shown again."
          control={
            <>
              <code className="s-code-big">{fresh}</code>
              <button className="btn compact" type="button" onClick={() => copyText(fresh).then((ok) => (ok ? pushSuccess('Copied') : pushError('Could not copy; select the code and copy it by hand')))}>
                <Hi icon={ClipboardDocumentIcon} size={14} /> Copy
              </button>
            </>
          }
        />
      )}
      {armed && (
        <SettingsRow
          id="approval-code-device"
          title={hasCode ? 'Replace on this device' : 'Enter on this device'}
          description="Paste the code you set on another device."
          control={
            <form className="s-form" onSubmit={save}>
              <input className="s-input" type="password" autoComplete="off" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" aria-label="Approval code"
                value={entered} onChange={(e) => setEntered(e.target.value)} />
              <button className="btn" type="submit" disabled={!entered.trim()}>Save</button>
              {hasCode && <button className="btn" type="button" onClick={() => { setApprovalCode(''); setNote({ text: 'Forgotten on this device.' }) }}>Forget</button>}
            </form>
          }
        />
      )}
      {note && <p className={note.bad ? 's-error' : 'muted'} role="status">{note.text}</p>}
    </SettingsSection>
  )
}

function AccountSection({ onSignedOut }: { onSignedOut: () => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { getAuthStatus().then(setStatus).catch(() => {}) }, [])

  async function signOut() {
    await logout().catch(() => {})
    clearSecret()
    // Signing out of this device forgets its approval code too.
    setApprovalCode('')
    onSignedOut()
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setNote(null)
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setNote({ text: 'Password changed. Every other device has been signed out.' })
    } catch (err) {
      setNote({ text: errorText(err), bad: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection id="account" title="Sign-in">
      {status?.mode === 'password' && (
        <SettingsRow
          id="change-login"
          title="Password"
          description="Changing it signs out every other device."
          control={
            <form className="s-form" onSubmit={savePassword}>
              <input className="s-input" type="password" autoComplete="current-password" placeholder="Current" aria-label="Current password"
                value={current} onChange={(e) => setCurrent(e.target.value)} />
              <input className="s-input" type="password" autoComplete="new-password" placeholder="New (8+ characters)" aria-label="New password"
                value={next} onChange={(e) => setNext(e.target.value)} />
              <button className="btn" type="submit" disabled={busy || !current || next.length < 8}>Change</button>
            </form>
          }
        />
      )}
      {note && <p className={note.bad ? 's-error' : 'muted'} role="status">{note.text}</p>}
      <SettingsRow
        id="sign-out"
        title="Sign out of this device"
        description={status?.mode === 'proxy'
          ? 'Sign-in is handled by the auth proxy in front of Totem. This forgets any saved bridge secret and approval code here.'
          : 'Ends this session and forgets this device’s saved bridge secret and approval code.'}
        control={
          <button className="btn danger" type="button" onClick={signOut}>
            <Hi icon={ArrowRightOnRectangleIcon} size={15} /> Sign out
          </button>
        }
      />
    </SettingsSection>
  )
}

export default function SecurityPane({ onSignedOut }: { onSignedOut: () => void }) {
  return (
    <SettingsPage>
      <ApprovalCodeSection />
      <AccountSection onSignedOut={onSignedOut} />
      <SettingsNote>
        <span>
        Agents run as the same user as Totem, so they can read what it can. The approval code stops a caller that holds only the server’s secret; it does not stop an agent that can rewrite Totem’s files. See <code>docs/self-hosting.md</code> → What remains open.
        </span>
      </SettingsNote>
    </SettingsPage>
  )
}
