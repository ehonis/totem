// Settings → Security (web components/settings/SecurityPane.tsx): the approval
// code (auth/approval-code.mjs, the second credential that sending, running
// commands and opening prompts need, which an agent holding the bridge secret
// does not have), the password, which Totem this phone talks to, and sign-out.
//
// The app signs in with the bridge secret, which approves nothing on its own, so
// approving from the phone needs the code even where the web's signed-in session
// still approves alone.
import React, { useEffect, useState } from 'react'
import { View } from 'react-native'
import { ApiError, AuthError, changePassword, createApprovalCode, getApprovalCodeStatus, getAuthStatus, type AuthStatus } from '../../../lib/api'
import { setApprovalCode, useHasApprovalCode, type ApprovalCodeStatus } from '../../../lib/approvalCode'
import { clearSecretStored, useConnection } from '../../../lib/connection'
import { ArrowRightOnRectangleIcon, ClipboardIcon, ServerStackIcon } from '../../../lib/icons'
import { colors, fonts } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn } from '../../../ui/kit'
import { confirm } from '../../../ui/menu'
import { success } from '../../../ui/haptics'
import { copy, Field, Loading, Notice, Pill, Row, Section } from '../ui'

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : String(err))

function stateWord(status: ApprovalCodeStatus): { word: string; tone: 'ok' | 'warn' | 'error' } {
  if (status.state === 'armed') return { word: 'On', tone: 'ok' }
  if (status.state === 'missing' || status.state === 'tampered') return { word: 'Needs a new code', tone: 'error' }
  return { word: 'Not set', tone: 'warn' }
}

function NoteLine({ note }: { note: { text: string; bad?: boolean } | null }) {
  if (!note) return null
  return <T size={12.5} lineHeight={17} color={note.bad ? colors.red : colors.muted} accessibilityLiveRegion="polite">{note.text}</T>
}

function ApprovalCodeSection() {
  const [status, setStatus] = useState<ApprovalCodeStatus | null>(null)
  const hasCode = useHasApprovalCode()
  const [password, setPassword] = useState('')
  const [entered, setEntered] = useState('')
  const [fresh, setFresh] = useState('')
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')

  const load = () => {
    setFailed('')
    getApprovalCodeStatus().then(setStatus).catch((e) => { if (!(e instanceof AuthError)) setFailed(errorText(e)) })
  }
  useEffect(() => { load() }, [])

  async function create() {
    setBusy(true)
    setNote(null)
    try {
      const { code } = await createApprovalCode(password)
      await setApprovalCode(code)
      setFresh(code)
      setPassword('')
      success()
      load()
    } catch (err) {
      setNote({ text: errorText(err), bad: true })
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    await setApprovalCode(entered.trim())
    setEntered('')
    setNote({ text: 'Saved on this phone.' })
  }

  if (!status) {
    return (
      <Section id="approval-code" title="Approval code">
        {failed ? (
          <Row title="Could not read the approval code" description={failed} control={<Btn compact title="Try again" onPress={load} />} />
        ) : <Loading />}
      </Section>
    )
  }
  const armed = status.state === 'armed'
  const broken = status.state === 'missing' || status.state === 'tampered'
  const { word, tone } = stateWord(status)
  const summary = armed
    ? `Set ${status.setAt ? new Date(status.setAt).toLocaleDateString() : ''}. Sending, running commands and opening prompts ask for it. ${hasCode ? 'This phone holds it.' : 'This phone does not hold it yet, so it cannot approve.'}`
    : status.state === 'missing'
      ? 'Its file on the server is missing, so sends, commands and prompts are refused until you set a new one.'
      : status.state === 'tampered'
        ? `It changed outside Totem (${status.reason || 'the file is not the one Totem set'}), so sends, commands and prompts are refused until you set a new one. If you just ran npm run approval-code, restart Totem instead.`
        : status.state === 'legacy'
          ? 'Approvals rely on your sign-in alone, which an agent reading the server’s files could forge. This phone cannot approve until one is set.'
          : 'Sending emails and messages, running commands and opening prompts wait until it is set.'

  return (
    <Section
      id="approval-code"
      title="Approval code"
      action={<Pill label={word} tone={tone} />}
      description="A second code the risky approvals need, so an agent holding the server’s secret still cannot approve its own sends."
      footer={<NoteLine note={note} />}
    >
      <Row title="Status" description={summary} />
      {status.mode === 'password' ? (
        <Row
          id="approval-code-set"
          title={armed || broken ? 'Set a new code' : 'Set an approval code'}
          description="Re-enter your password. Devices holding an older code will need the new one."
          stacked
          control={
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Field
                style={{ flex: 1 }}
                secureTextEntry
                autoComplete="current-password"
                textContentType="password"
                placeholder="Password"
                accessibilityLabel="Password"
                value={password}
                onChangeText={setPassword}
                returnKeyType="go"
                onSubmitEditing={() => { if (password && !busy) void create() }}
              />
              <Btn title={busy ? 'Setting…' : 'Set'} disabled={busy || !password} loading={busy} onPress={create} />
            </View>
          }
        />
      ) : (
        <Row title="Set an approval code" description="Behind an auth proxy there is no Totem password: run npm run approval-code in a terminal on the server." />
      )}
      {fresh ? (
        <Row
          title="Your new code"
          description="Saved on this phone. Enter it on your other devices now; it is not shown again."
          stacked
          control={
            <View style={{ gap: 8 }}>
              <T size={17} weight={600} selectable style={{ fontFamily: fonts.mono, letterSpacing: 0.5 }}>{fresh}</T>
              <Btn compact icon={ClipboardIcon} title="Copy" onPress={() => void copy(fresh)} style={{ alignSelf: 'flex-start' }} />
            </View>
          }
        />
      ) : null}
      {armed ? (
        <Row
          id="approval-code-device"
          title={hasCode ? 'Replace on this phone' : 'Enter on this phone'}
          description="Paste the code you set on another device."
          stacked
          control={
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Field
                style={{ flex: 1 }}
                secureTextEntry
                autoComplete="off"
                placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                accessibilityLabel="Approval code"
                value={entered}
                onChangeText={setEntered}
                returnKeyType="done"
                onSubmitEditing={() => { if (entered.trim()) void save() }}
              />
              <Btn title="Save" disabled={!entered.trim()} onPress={() => void save()} />
              {hasCode ? <Btn title="Forget" onPress={() => { void setApprovalCode(''); setNote({ text: 'Forgotten on this phone.' }) }} /> : null}
            </View>
          }
        />
      ) : null}
    </Section>
  )
}

function SignInSection() {
  const conn = useConnection()
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { getAuthStatus().then(setStatus).catch(() => {}) }, [])

  async function savePassword() {
    setBusy(true)
    setNote(null)
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      success()
      setNote({ text: 'Password changed. Every other device has been signed out.' })
    } catch (err) {
      setNote({ text: errorText(err), bad: true })
    } finally {
      setBusy(false)
    }
  }

  // The app signs in with the bridge secret, not a session cookie, so signing out
  // is forgetting it (and this phone's approval code, in clearSecretStored). The
  // address stays, so signing back in is one field.
  async function signOut() {
    if (await confirm('Sign out?', { message: 'This forgets the bridge secret and the approval code on this phone.', confirmLabel: 'Sign out' })) {
      await clearSecretStored()
    }
  }

  async function changeServer() {
    if (await confirm('Change server?', { message: 'You’ll be signed out here and can connect to another Totem.', confirmLabel: 'Change server', destructive: false })) {
      await clearSecretStored()
    }
  }

  return (
    <Section id="account" title="Sign-in" footer={<NoteLine note={note} />}>
      <Row
        id="server-address"
        title="Server"
        description={conn.baseUrl.replace(/^https?:\/\//, '') || 'Not connected'}
        control={<Btn compact icon={ServerStackIcon} title="Change" onPress={changeServer} />}
      />
      {status?.mode === 'password' ? (
        <Row
          id="change-login"
          title="Password"
          description="Changing it signs out every other device."
          stacked
          control={
            <View style={{ gap: 8 }}>
              <Field secureTextEntry autoComplete="current-password" textContentType="password" placeholder="Current" accessibilityLabel="Current password" value={current} onChangeText={setCurrent} />
              <Field secureTextEntry autoComplete="new-password" textContentType="newPassword" placeholder="New (8+ characters)" accessibilityLabel="New password" value={next} onChangeText={setNext} />
              <Btn title="Change" disabled={busy || !current || next.length < 8} loading={busy} onPress={savePassword} style={{ alignSelf: 'flex-start' }} />
            </View>
          }
        />
      ) : null}
      <Row
        id="sign-out"
        title="Sign out of this phone"
        description={status?.mode === 'proxy'
          ? 'Sign-in is handled by the auth proxy in front of Totem. This forgets the saved bridge secret and approval code here.'
          : 'Forgets this phone’s saved bridge secret and approval code.'}
        control={<Btn kind="danger" compact icon={ArrowRightOnRectangleIcon} title="Sign out" onPress={signOut} />}
      />
    </Section>
  )
}

export default function SecurityPane() {
  return (
    <>
      <ApprovalCodeSection />
      <SignInSection />
      <Notice tone="info">
        Agents run as the same user as Totem, so they can read what it can. The approval code stops a caller that holds only the server’s secret; it does not stop an agent that can rewrite Totem’s files. See docs/self-hosting.md → What remains open.
      </Notice>
    </>
  )
}
