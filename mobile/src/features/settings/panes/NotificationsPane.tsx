// Settings → Notifications (web NotificationsSettings.tsx) for the native app.
//
// Same job as the web pane: tell the truth about why notifications are or aren't
// arriving, and a test button that goes through the same notifier the scheduled
// ones use. The causes differ on a native app: no Home Screen step, but iOS
// permission (refused once, it only comes back through the Settings app) and the
// bridge needing an APNs key (APNS_* in .env) rather than VAPID keys.
import React, { useCallback, useEffect, useState } from 'react'
import { Linking, View } from 'react-native'
import * as Notifications from 'expo-notifications'
import { api } from '../../../lib/api'
import { getDedupe, getDevices, saveDedupe, sendTestPush, STORY_MATCH, type DedupeSettings, type DedupeState } from '../../../lib/push'
import { Hi, BellAlertIcon, CheckCircleIcon, DevicePhoneMobileIcon, WarnIcon } from '../../../lib/icons'
import { colors, alpha } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn } from '../../../ui/kit'
import { registerForPush, type PushStatus } from '../../../shell/push'
import { Note, PaneHead, SectionTitle, Select, SettingList, SettingRow } from '../ui'

type Device = {
  id: string
  label: string
  state: 'active' | 'expired'
  host: string | null
  transport?: 'webpush' | 'apns'
  createdAt: number
  lastDeliveredAt: number | null
  lastError: string | null
}

type TestResult = {
  ok: boolean
  reason: string | null
  delivered: number
  results: { label: string; ok: boolean; status: number; gone: boolean; error: string | null }[]
}

const when = (ts: number | null) => {
  if (!ts) return 'never'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  return new Date(ts).toLocaleDateString()
}

function Callout({ children, tone = 'warn' }: { children: React.ReactNode; tone?: 'warn' | 'error' | 'ok' }) {
  const c = tone === 'ok' ? colors.green : tone === 'error' ? colors.red : colors.amber
  return (
    <View style={{ flexDirection: 'row', gap: 8, padding: 12, marginTop: 10, borderRadius: 10, backgroundColor: alpha(c, 0.08), borderWidth: 1, borderColor: alpha(c, 0.3) }}>
      {tone === 'ok' ? <Hi icon={CheckCircleIcon} size={15} color={colors.green} /> : <WarnIcon />}
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  )
}

function describeFailure(test: TestResult): string {
  if (test.reason === 'no-devices') return 'No registered devices to send to yet.'
  if (test.reason === 'not-configured') return 'The server has no push keys.'
  if (test.reason === 'all-devices-gone') return 'Every registered device was rejected by the push service. They are marked expired below.'
  return 'The push service refused it.'
}

export default function NotificationsPane() {
  const [permission, setPermission] = useState<Notifications.PermissionStatus | null>(null)
  const [status, setStatus] = useState<PushStatus | null>(null)
  // null until known. 'old': the bridge predates native push (no `native` in
  // /api/push/key), so it needs updating, not keys. false: no APNs key set.
  const [native, setNative] = useState<boolean | 'old' | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [test, setTest] = useState<TestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setPermission((await Notifications.getPermissionsAsync()).status)
    try {
      const key = await api<{ native?: boolean }>('/api/push/key')
      setNative(key.native === undefined ? 'old' : key.native)
    } catch { setNative(false) }
    try { setDevices((await getDevices()).devices || []) } catch { /* the list is a nicety */ }
  }, [])

  useEffect(() => {
    // Opening the pane re-registers quietly, so "this phone" is current.
    void registerForPush().then(setStatus).finally(() => void refresh())
  }, [refresh])

  const enable = async () => {
    setBusy(true)
    setError(null)
    const result = await registerForPush({ prompt: true })
    setStatus(result)
    if (result === 'failed') setError("This phone couldn't register with the bridge. Pull to retry.")
    await refresh()
    setBusy(false)
  }

  const runTest = async () => {
    setBusy(true)
    setTest(null)
    setError(null)
    try {
      setTest(await sendTestPush({ title: 'Totem test', body: 'If you can read this on your phone, the whole path works.' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await refresh()
    setBusy(false)
  }

  const active = devices.filter((d) => d.state === 'active')
  const expired = devices.filter((d) => d.state === 'expired')
  const registered = status === 'registered'

  return (
    <View>
      <PaneHead desc="Push notifications from Totem itself: reminders, the daily digest, and anything that breaks. Test it from here." />

      {native === 'old' ? (
        <Callout tone="error">
          <T size={13} lineHeight={19}>
            The bridge on the server is older than app push. Update Totem on the box to a version with native
            push support and restart it; until then notifications only reach the web app.
          </T>
        </Callout>
      ) : native === false ? (
        <Callout tone="error">
          <T size={13} lineHeight={19}>
            The bridge can't reach the app yet. It needs an APNs key: set APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID
            and APNS_TOPIC in .env on the box and restart it (docs/notifications.md → The native iPhone app).
          </T>
        </Callout>
      ) : null}

      {permission === 'denied' ? (
        <Callout>
          <T size={13} lineHeight={19}>Notifications are off for Totem in iOS. Turn them on in Settings → Totem → Notifications.</T>
          <Btn compact title="Open Settings" onPress={() => Linking.openSettings()} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
        </Callout>
      ) : null}

      <SectionTitle title="This phone" />
      <SettingList>
        <SettingRow
          title="Push notifications"
          desc={registered ? 'This phone is registered and will receive notifications.' : 'Ask for permission and register this phone.'}
        >
          {registered
            ? <T size={13} color={colors.green} weight={600}>On</T>
            : <Btn kind="primary" compact title={busy ? 'Working…' : 'Turn on'} disabled={busy || permission === 'denied'} onPress={enable} />}
        </SettingRow>
        <SettingRow title="Send a test" desc="Goes through the same path the scheduled digests use, to every registered device.">
          <Btn compact icon={BellAlertIcon} title="Send test" disabled={busy || active.length === 0} onPress={runTest} />
        </SettingRow>
      </SettingList>

      {test ? (
        <Callout tone={test.ok ? 'ok' : 'error'}>
          <T size={13} lineHeight={19}>
            {test.ok
              ? `Sent to ${test.delivered} device${test.delivered === 1 ? '' : 's'}. If nothing arrives, check Focus modes.`
              : describeFailure(test)}
            {test.results.filter((r) => !r.ok).map((r) => ` ${r.label}: ${r.error || `HTTP ${r.status}`}.`).join('')}
          </T>
        </Callout>
      ) : null}
      {error ? <Callout tone="error"><T size={13} lineHeight={19}>{error}</T></Callout> : null}

      <SectionTitle title="Devices" />
      <SettingList>
        {devices.length === 0 ? (
          <SettingRow title="No devices yet" desc="Turn push on from the device you want notified." />
        ) : null}
        {active.map((d) => (
          <SettingRow
            key={d.id}
            title={d.label}
            desc={`Registered ${when(d.createdAt)} · last notification ${when(d.lastDeliveredAt)}${d.host ? ` · ${d.host}` : ''}`}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Hi icon={DevicePhoneMobileIcon} size={14} color={colors.muted} />
              <T size={12} color={colors.green} weight={600}>Active</T>
            </View>
          </SettingRow>
        ))}
        {expired.map((d) => (
          <SettingRow
            key={d.id}
            title={d.label}
            desc={`Gone: the push service rejected it${d.lastError ? ` (${d.lastError})` : ''}. ${d.transport === 'apns' ? 'The app was probably deleted from that phone.' : "Re-add Totem to that device's Home Screen and turn push on again."}`}
          >
            <T size={12} color={colors.amber} weight={600}>Expired</T>
          </SettingRow>
        ))}
      </SettingList>
      <Btn
        compact
        kind="ghost"
        title={refreshing ? 'Checking…' : 'Re-check'}
        onPress={async () => { setRefreshing(true); await refresh(); setRefreshing(false) }}
        style={{ alignSelf: 'flex-start', marginTop: 12 }}
      />

      <Duplicates />
    </View>
  )
}

// The web pane's Duplicates section (NotificationsSettings.tsx): the dedupe
// gate's settings and what it held back.
function Duplicates() {
  const [state, setState] = useState<DedupeState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getDedupe().then(setState).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const save = async (patch: Partial<DedupeSettings>) => {
    setError(null)
    try {
      const { settings } = await saveDedupe(patch)
      setState((s) => (s ? { ...s, settings } : s))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!state) return <Note text={error || undefined} error />
  const { settings } = state
  const onOff = [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]
  const match = STORY_MATCH.map((m) => ({ value: String(m.value), label: m.label }))
  if (!match.some((m) => m.value === String(settings.sameStoryScore))) {
    match.push({ value: String(settings.sameStoryScore), label: `Custom (${settings.sameStoryScore})` })
  }

  return (
    <>
      <SectionTitle title="Duplicates" />
      <SettingList>
        <SettingRow
          title="Hold back repeats"
          desc="A quota stays spent until it resets, and a story several feeds report goes out once. Reminders, approvals and chat answers are never held back."
        >
          <Select value={settings.enabled ? 'on' : 'off'} options={onOff} onChange={(v) => void save({ enabled: v === 'on' })} />
        </SettingRow>
        <SettingRow title="Same story" desc="How alike two headlines must be. The same link, or the same model and version, always counts.">
          <Select value={String(settings.sameStoryScore)} options={match} disabled={!settings.enabled} onChange={(v) => void save({ sameStoryScore: Number(v) })} />
        </SettingRow>
        <SettingRow title="Ask a model about close calls" desc="Only for headlines the overlap could not settle. If it fails, the notification goes out.">
          <Select value={settings.modelCheck ? 'on' : 'off'} options={onOff} disabled={!settings.enabled} onChange={(v) => void save({ modelCheck: v === 'on' })} />
        </SettingRow>
        <SettingRow
          title={`${state.suppressed} held back in the last ${state.days} days`}
          desc={state.suppressed ? 'Each is counted on the notification it repeated.' : 'Nothing has been a repeat lately.'}
        />
        {state.items.slice(0, 10).map((item) => (
          <SettingRow
            key={item.id}
            title={item.body || item.title}
            desc={`${item.reason === 'same-story' ? `Same story as “${item.duplicateTitle}”` : 'Already sent'} · ${when(item.at)}`}
          />
        ))}
      </SettingList>
      <Note text={error || undefined} error />
    </>
  )
}
