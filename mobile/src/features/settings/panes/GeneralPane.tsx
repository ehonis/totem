// Settings → General (web SettingsView.tsx GeneralPane + AccountSection): this
// device's preferences, the owner password, which Totem the app talks to, and
// signing out.
import React, { useEffect, useState } from 'react'
import { TextInput, View, StyleSheet } from 'react-native'
import { ApiError, changePassword, getAuthStatus, type AuthStatus } from '../../../lib/api'
import { useSettings, setSetting } from '../../../lib/settings'
import { clearSecretStored, useConnection } from '../../../lib/connection'
import { ArrowRightOnRectangleIcon, ServerStackIcon } from '../../../lib/icons'
import { colors, fonts } from '../../../theme'
import { Btn, Toggle } from '../../../ui/kit'
import { confirm } from '../../../ui/menu'
import { success } from '../../../ui/haptics'
import { Note, PaneHead, SectionTitle, Select, SettingList, SettingRow } from '../ui'

// The web's Default tab choices, less Code and Brain, which the app doesn't have.
const LANDING = [
  { value: 'overview', label: 'Overview' },
  { value: 'productivity', label: 'Productivity' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'chat', label: 'Chat' },
  { value: 'todos', label: 'Productivity · Todos' },
  { value: 'calendar', label: 'Productivity · Calendar' },
  { value: 'habits', label: 'Productivity · Habits' },
  { value: 'lists', label: 'Productivity · Lists' },
  { value: 'totems', label: 'Totems' },
]

export default function GeneralPane() {
  const s = useSettings()
  return (
    <>
      <PaneHead desc="Preferences for how the app looks and behaves on this device." />

      <SectionTitle title="Appearance" />
      <SettingList>
        <SettingRow title="Reduce motion" desc="Turn off animations and transitions across the app.">
          <Toggle value={s.reduceMotion} onChange={(v) => setSetting('reduceMotion', v)} />
        </SettingRow>
        <SettingRow title="Compact density" desc="Tighten spacing and padding to fit more on screen.">
          <Toggle value={s.compact} onChange={(v) => setSetting('compact', v)} />
        </SettingRow>
      </SettingList>

      <SectionTitle title="Behavior" />
      <SettingList>
        <SettingRow title="Auto-refresh data" desc="Poll live views like Usage in the background while open.">
          <Toggle value={s.autoRefresh} onChange={(v) => setSetting('autoRefresh', v)} />
        </SettingRow>
        <SettingRow title="Default tab" desc="Which tab opens when you first open the app.">
          <Select value={s.landingTab} options={LANDING} onChange={(v) => setSetting('landingTab', v)} />
        </SettingRow>
      </SettingList>

      <AccountSection />
    </>
  )
}

function Field(props: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      selectionColor={colors.accent}
      keyboardAppearance="dark"
      autoCapitalize="none"
      autoCorrect={false}
      {...props}
      style={st.field}
    />
  )
}

// Change the owner password, see which Totem this is, sign out. In proxy mode
// there is no password here to change: the auth proxy in front owns sign-in.
function AccountSection() {
  const conn = useConnection()
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [note, setNote] = useState('')
  const [noteErr, setNoteErr] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => { getAuthStatus().then(setStatus).catch(() => {}) }, [])

  async function savePassword() {
    setBusy(true)
    setNote('')
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      success()
      setNoteErr(false)
      setNote('Password changed. Other signed-in devices have been signed out.')
    } catch (err) {
      setNoteErr(true)
      setNote(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // The app signs in with the bridge secret, not a session cookie, so signing out
  // is forgetting the secret. The address stays, so signing back in is one field.
  async function signOut() {
    if (await confirm('Sign out?', { message: 'This forgets the bridge secret on this device.', confirmLabel: 'Sign out' })) {
      await clearSecretStored()
    }
  }

  async function changeServer() {
    if (await confirm('Change server?', { message: 'You’ll be signed out here and can connect to another Totem.', confirmLabel: 'Change server', destructive: false })) {
      await clearSecretStored()
    }
  }

  return (
    <>
      <SectionTitle title="Account" />
      <SettingList>
        <SettingRow title="Server" desc={conn.baseUrl.replace(/^https?:\/\//, '') || 'Not connected'}>
          <Btn compact icon={ServerStackIcon} title="Change server" onPress={changeServer} />
        </SettingRow>
        {status?.mode === 'password' ? (
          <SettingRow title="Change password" desc="Signs out every other device." stacked>
            <View style={{ gap: 8 }}>
              <Field secureTextEntry autoComplete="current-password" textContentType="password" placeholder="Current" value={current} onChangeText={setCurrent} />
              <Field secureTextEntry autoComplete="new-password" textContentType="newPassword" placeholder="New (8+ characters)" value={next} onChangeText={setNext} />
              <Btn title="Change" disabled={busy || !current || !next} loading={busy} onPress={savePassword} style={{ alignSelf: 'flex-start' }} />
            </View>
          </SettingRow>
        ) : null}
        {note ? <Note text={note} error={noteErr} /> : null}
        <SettingRow
          title="Sign out"
          desc={status?.mode === 'proxy'
            ? 'Sign-in is handled by the auth proxy in front of Totem (TOTEM_AUTH=proxy). This forgets the saved bridge secret on this device.'
            : 'Forget the saved bridge secret on this device.'}
        >
          <Btn kind="danger" icon={ArrowRightOnRectangleIcon} title="Sign out" onPress={signOut} />
        </SettingRow>
      </SettingList>
    </>
  )
}

const st = StyleSheet.create({
  field: {
    minHeight: 40, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.bg2, color: colors.text, fontFamily: fonts[400], fontSize: 15,
  },
})
