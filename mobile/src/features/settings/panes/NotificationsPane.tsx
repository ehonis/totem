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
import { Hi, BellAlertIcon, DevicePhoneMobileIcon, ArrowPathIcon, ChevronDownIcon } from '../../../lib/icons'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Press } from '../../../ui/kit'
import { confirm } from '../../../ui/menu'
import { registerForPush, turnOffPush, type PushStatus } from '../../../shell/push'
import { Notice, Pill, Picker, Row, Section, Switch } from '../ui'

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
  // 'unknown': the question itself failed (offline, the server restarting).
  const [native, setNative] = useState<boolean | 'old' | 'unknown' | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<TestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setPermission((await Notifications.getPermissionsAsync()).status)
    try {
      const key = await api<{ native?: boolean }>('/api/push/key')
      setNative(key.native === undefined ? 'old' : key.native)
    } catch { setNative('unknown') }
    try { setDevices((await getDevices()).devices || []) } catch { /* the list is a nicety */ }
  }, [])

  useEffect(() => {
    // Opening the pane re-registers quietly (unless push is off here), so "this phone" is current.
    void registerForPush().then(setStatus).finally(() => void refresh())
  }, [refresh])

  const enable = async () => {
    setBusy(true)
    setError(null)
    const result = await registerForPush({ prompt: true, turnOn: true })
    setStatus(result)
    if (result === 'failed') setError("This phone couldn't register with the bridge. Try again in a moment.")
    await refresh()
    setBusy(false)
  }

  const disable = async () => {
    const ok = await confirm('Turn off notifications on this phone?', {
      message: 'Totem stops sending to this phone. Your other devices keep theirs.',
      confirmLabel: 'Turn off',
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await turnOffPush()
      setStatus('off')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
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
    <>
      {native === 'old' ? (
        <Notice tone="error">
          The bridge on the server is older than app push. Update Totem on the server and restart it; until then notifications only reach the web app.
        </Notice>
      ) : native === false ? (
        <Notice tone="error">
          The server can’t reach the app yet. It needs an APNs key: set APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID and APNS_TOPIC in .env on the server and restart Totem (docs/notifications.md → The native iPhone app).
        </Notice>
      ) : native === 'unknown' ? (
        <Notice tone="warn">
          <T size={13} lineHeight={19}>Totem didn’t answer, so whether it can send to this phone is unknown.</T>
          <Btn compact title="Try again" onPress={() => void refresh()} style={{ alignSelf: 'flex-start' }} />
        </Notice>
      ) : null}

      {permission === 'denied' ? (
        <Notice tone="warn">
          <T size={13} lineHeight={19}>Notifications are off for Totem in iOS. Turn them on in Settings → Totem → Notifications.</T>
          <Btn compact title="Open Settings" onPress={() => Linking.openSettings()} style={{ alignSelf: 'flex-start' }} />
        </Notice>
      ) : null}

      <Section
        id="push"
        title="This phone"
        description="Reminders, the daily digest, chats that finish while you are away, and anything that breaks."
        footer={error ? <T size={12.5} color={colors.red} lineHeight={17}>{error}</T> : undefined}
      >
        <Row
          id="push-toggle"
          title="Push notifications"
          description={registered ? 'This phone is registered and gets notifications.'
            : status === 'off' ? 'Off on this phone. Turn on to register it again.'
              : 'Asks for permission and registers this phone.'}
          control={registered
            ? <Btn compact title="Turn off" disabled={busy} onPress={disable} />
            : <Btn kind="primary" compact title={busy ? 'Working…' : 'Turn on'} disabled={busy || permission === 'denied'} onPress={enable} />}
        />
        <Row
          id="push-test"
          title="Send a test"
          description="Goes the same way the real notifications do, to every registered device."
          status={test ? (
            <T size={12.5} lineHeight={17} color={test.ok ? colors.green : colors.red}>
              {test.ok
                ? `Sent to ${test.delivered} device${test.delivered === 1 ? '' : 's'}. If nothing shows, check Focus modes.`
                : describeFailure(test)}
              {test.results.filter((r) => !r.ok).map((r) => ` ${r.label}: ${r.error || `HTTP ${r.status}`}.`).join('')}
            </T>
          ) : undefined}
          control={<Btn compact icon={BellAlertIcon} title="Send test" disabled={busy || active.length === 0} onPress={runTest} />}
        />
      </Section>

      <Section
        id="push-devices"
        title="Devices"
        description="Every device that gets Totem’s notifications."
        action={<Btn compact kind="ghost" icon={ArrowPathIcon} title="Re-check" onPress={() => void refresh()} />}
      >
        {devices.length === 0 ? (
          <Row title="No devices yet" description="Turn push on from the device you want notified. The app registers itself." />
        ) : null}
        {active.map((d) => (
          <Row
            key={d.id}
            icon={<Hi icon={DevicePhoneMobileIcon} size={14} color={colors.muted} />}
            title={d.label}
            description={`Registered ${when(d.createdAt)} · last notification ${when(d.lastDeliveredAt)}${d.host ? ` · ${d.host}` : ''}`}
            control={<Pill label="Active" tone="ok" />}
          />
        ))}
        {expired.map((d) => (
          <Row
            key={d.id}
            title={d.label}
            description={`Gone: the push service rejected it${d.lastError ? ` (${d.lastError})` : ''}. ${d.transport === 'apns' ? 'The app was probably deleted from that phone.' : 'Add Totem to that device’s Home Screen again and turn push on.'}`}
            control={<Pill label="Expired" tone="warn" />}
          />
        ))}
      </Section>

      <Duplicates />
    </>
  )
}

// The web pane's Duplicates section: the dedupe gate's settings (notify/dedupe.mjs)
// and what it held back.
function Duplicates() {
  const [state, setState] = useState<DedupeState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    try { setState(await getDedupe()); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const save = async (patch: Partial<DedupeSettings>) => {
    setError(null)
    try {
      const { settings } = await saveDedupe(patch)
      setState((s) => (s ? { ...s, settings } : s))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!state) return error ? <Notice tone="error">{error}</Notice> : null
  const { settings } = state
  const match = STORY_MATCH.map((m) => ({ value: String(m.value), label: m.label }))
  if (!match.some((m) => m.value === String(settings.sameStoryScore))) {
    match.push({ value: String(settings.sameStoryScore), label: `Custom (${settings.sameStoryScore})` })
  }
  const windows = [...new Set([12, 24, 48, 72, 168, settings.storyWindowHours])].sort((a, b) => a - b)
    .map((h) => ({ value: String(h), label: h < 48 ? `${h} hours` : `${h / 24} days` }))
  const shown = state.items.slice(0, 10)

  return (
    <Section
      id="duplicates"
      title="Duplicates"
      description="Something already said is not said again: a quota stays spent until it resets, and a story several feeds report goes out once. Reminders, approvals and chat answers are never held back."
      footer={error ? <T size={12.5} color={colors.red} lineHeight={17}>{error}</T> : undefined}
    >
      <Row
        id="dedupe"
        title="Hold back repeats"
        control={<Switch label="Hold back repeats" value={settings.enabled} onChange={(v) => void save({ enabled: v })} />}
      />
      {settings.enabled ? (
        <>
          <Row
            id="same-story"
            title="Same story"
            description="How alike two headlines must be. The same link always counts; so does the same model name and version."
            control={<Picker label="Same story" value={String(settings.sameStoryScore)} options={match} onChange={(v) => void save({ sameStoryScore: Number(v) })} />}
          />
          <Row
            id="story-window"
            title="Compare stories over"
            description="How far back a new headline is checked against what was sent."
            control={<Picker label="Compare stories over" value={String(settings.storyWindowHours)} options={windows} onChange={(v) => void save({ storyWindowHours: Number(v) })} />}
          />
          <Row
            id="model-check"
            title="Ask a model about close calls"
            description="Only for headlines the word and name overlap could not settle, on your default AI account. If it fails or is slow, the notification goes out."
            control={<Switch label="Ask a model about close calls" value={settings.modelCheck} onChange={(v) => void save({ modelCheck: v })} />}
          />
        </>
      ) : null}
      <Row
        id="held-back"
        title={`${state.suppressed} held back in the last ${state.days} days`}
        description={state.suppressed ? 'Each is counted on the notification it repeated, in Notification history.' : 'Nothing has been a repeat lately.'}
        control={<Btn compact kind="ghost" icon={ArrowPathIcon} title="Refresh" onPress={() => void load()} />}
      >
        {shown.length ? (
          <>
            <Press onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <T size={13} color={colors.accent} weight={600}>{open ? 'Hide' : `Show the last ${shown.length}`}</T>
              <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Hi icon={ChevronDownIcon} size={13} color={colors.accent} /></View>
            </Press>
            {open ? (
              <View style={{ gap: 10, marginTop: 10 }}>
                {shown.map((item) => (
                  <View key={item.id} style={{ gap: 2 }}>
                    <T size={13.5} weight={500}>{item.body || item.title}</T>
                    <T size={12} muted lineHeight={16}>
                      {item.reason === 'same-story' ? `Same story as “${item.duplicateTitle}”` : 'Already sent'}
                      {item.why ? ` · ${item.why}` : ''} · {when(item.at)}
                    </T>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </Row>
    </Section>
  )
}
