// First run: where the bridge is, and the owner's BRIDGE_SECRET. Styled after the
// web's sign-in card (AuthGate.tsx). The app has no origin of its own, so it needs
// the address too; the secret goes to the keychain. A bridge published behind
// Cloudflare Access gets its login page first (cfAccess.ts), then the secret.
import React, { useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet, View, type TextInput } from 'react-native'
import { Image } from 'expo-image'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from '../theme'
import { T } from '../ui/Text'
import { Btn, Input } from '../ui/kit'
import { getConnection, normalizeBaseUrl, saveConnection } from '../lib/connection'
import { probeAccess, signInWithAccess } from '../lib/cfAccess'
import { success } from '../ui/haptics'

async function check(baseUrl: string, secret: string, accessToken?: string): Promise<string | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 8000)
  const access: Record<string, string> = accessToken ? { 'cf-access-token': accessToken } : {}
  try {
    const health = await fetch(`${baseUrl}/health`, { headers: access, signal: ctl.signal })
    if (!health.ok) return `The server answered ${health.status}. Is this Totem?`
    // /health is public; the secret is only proven by a route that needs it.
    const probe = await fetch(`${baseUrl}/api/inbox/count`, { headers: { Authorization: `Bearer ${secret}`, ...access }, signal: ctl.signal })
    if (probe.status === 401) return 'That secret was refused.'
    if (!probe.ok) return `The server answered ${probe.status}.`
    return null
  } catch (e: any) {
    return e?.name === 'AbortError'
      ? 'No answer after 8 seconds. On Tailscale? Use the address your phone can reach.'
      : `Could not reach ${baseUrl}: ${e?.message || e}`
  } finally {
    clearTimeout(timer)
  }
}

export default function Connect() {
  const insets = useSafeAreaInsets()
  const [address, setAddress] = useState(() => getConnection().baseUrl.replace(/^http:\/\//, ''))
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stage, setStage] = useState('')
  const secretRef = useRef<TextInput>(null)

  const submit = async () => {
    const baseUrl = normalizeBaseUrl(address)
    if (!baseUrl || !secret.trim()) return
    setBusy(true)
    setError('')
    let accessToken: string | undefined
    try {
      // Behind a Cloudflare tunnel with Access, sign in there first.
      const guard = await probeAccess(baseUrl)
      if (guard.protected) {
        setStage('Sign in to Cloudflare Access to reach this server…')
        accessToken = (await signInWithAccess(baseUrl, guard.aud)) || undefined
        setStage('')
        if (!accessToken) { setBusy(false); setError('Cloudflare sign-in was closed before it finished.'); return }
      }
    } catch (e: any) {
      // Unreachable is reported by check() below with a clearer message.
      setStage('')
      if (!/Network request failed|fetch/i.test(e?.message || '')) { setBusy(false); setError(e?.message || String(e)); return }
    }
    const problem = await check(baseUrl, secret.trim(), accessToken)
    setBusy(false)
    if (problem) { setError(problem); return }
    success()
    await saveConnection({ baseUrl, secret: secret.trim(), accessToken })
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[st.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={st.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
          <Image source={require('../../assets/images/totem-logo.png')} style={{ width: 48, height: 48, marginLeft: -12 }} />
          <T brand size={20} style={{ letterSpacing: 2.4, textTransform: 'uppercase', marginLeft: -6 }}>Totem</T>
        </View>
        <T size={22} weight={700} style={{ marginBottom: 6 }}>Connect to Totem</T>
        <T muted style={{ marginBottom: 16 }}>
          The address of the machine running Totem (a Tailscale IP works), and its bridge secret.
        </T>
        <Input
          value={address}
          onChangeText={setAddress}
          placeholder="100.x.y.z or totem.example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="next"
          onSubmitEditing={() => secretRef.current?.focus()}
          style={{ marginBottom: 12, backgroundColor: colors.bg }}
        />
        <Input
          ref={secretRef}
          value={secret}
          onChangeText={setSecret}
          placeholder="Bridge secret"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={submit}
          style={{ marginBottom: 12, backgroundColor: colors.bg }}
        />
        {stage ? <T muted style={{ marginBottom: 12 }}>{stage}</T> : null}
        {error ? <T color={colors.red} style={{ marginBottom: 12 }}>{error}</T> : null}
        <Btn kind="primary" title="Connect" loading={busy} disabled={!address.trim() || !secret.trim()} onPress={submit} />
        <T muted size={12.5} style={{ marginTop: 14 }}>An IP or Tailscale name uses port 8787; a domain uses https (Cloudflare Access sign-in is handled).</T>
      </View>
    </KeyboardAvoidingView>
  )
}

const st = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', padding: 20 },
  card: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 16, padding: 24 },
})
