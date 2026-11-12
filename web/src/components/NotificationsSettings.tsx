/**
 * Settings → Notifications.
 *
 * The panel's first job is to tell the truth about why notifications are or are
 * not working, because on iOS every failure is silent. Push only works from a
 * Home Screen web app; permission is asked once and a refusal sticks until the
 * app is removed and re-added; removing it destroys the subscription without
 * telling anyone. A toggle that ignores all that is a toggle that lies.
 *
 * The second job is the test button, which goes through exactly the same
 * notifier the scheduled digests use — so a test that arrives on the phone
 * proves the real path, not a parallel one built for demos.
 *
 * The third is Duplicates: the dedupe gate's settings, and what it held back.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Hi, BellAlertIcon, WarnIcon, ArrowPathIcon, DevicePhoneMobileIcon } from '../icons'
import { SettingsLoading, SettingsNote, SettingsPage, SettingsRow, SettingsSection, Switch } from './settings/ui'
import {
  readPushState, subscribeToPush, unsubscribeFromPush, sendTestPush, getDevices,
  getDedupe, saveDedupe, STORY_MATCH,
  type PushState, type DedupeState, type DedupeSettings,
} from '../push'

type Device = {
  id: string
  label: string
  state: 'active' | 'expired'
  host: string | null
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

export default function NotificationsSettings() {
  const [state, setState] = useState<PushState | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [configured, setConfigured] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<TestResult | null>(null)

  const refresh = useCallback(async () => {
    setState(await readPushState())
    try {
      const data = await getDevices()
      setDevices(data.devices || [])
      setConfigured(data.configured !== false)
    } catch {
      // The device list is a nicety; the local state above is what gates the UI.
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const enable = async () => {
    setBusy(true)
    setError(null)
    // Must stay inside this click: iOS refuses a permission prompt that is not a
    // direct result of a user gesture, and counts it against the one chance the
    // app gets.
    const result = await subscribeToPush()
    if (result.ok === false) setError(result.error)
    await refresh()
    setBusy(false)
  }

  const disable = async () => {
    setBusy(true)
    await unsubscribeFromPush()
    await refresh()
    setBusy(false)
  }

  const runTest = async () => {
    setBusy(true)
    setTest(null)
    setError(null)
    try {
      setTest(await sendTestPush({
        title: 'Totem test',
        body: 'If you can read this on your phone, the whole path works.',
      }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await refresh()
    setBusy(false)
  }

  if (!state) return <SettingsLoading />

  const active = devices.filter((d) => d.state === 'active')
  const expired = devices.filter((d) => d.state === 'expired')
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)

  return (
    <SettingsPage>
      {!configured && (
        <SettingsNote tone="error">
          <WarnIcon />
          <span>
            The server has no VAPID keys. Run <code>node notify/cli.mjs keys</code> on the server,
            paste the three lines into <code>.env</code>, and restart Totem.
          </span>
        </SettingsNote>
      )}
      {state.blocker && <SettingsNote tone="warn"><WarnIcon /><span>{state.blocker}</span></SettingsNote>}

      <SettingsSection id="push" title="This device" description="Reminders, the daily digest, chats that finish while you are away, and anything that breaks.">
        <SettingsRow
          id="push-toggle"
          title="Push notifications"
          description={state.subscribed ? 'This device is registered and gets notifications.' : 'Asks this browser for permission and registers it.'}
          control={state.subscribed ? (
            <button className="btn" onClick={disable} disabled={busy}>Turn off</button>
          ) : (
            <button className="btn primary" onClick={enable} disabled={busy || Boolean(state.blocker) || !configured}>
              {busy ? 'Working…' : 'Turn on'}
            </button>
          )}
        />
        <SettingsRow
          id="push-test"
          title="Send a test"
          description="Goes the same way the real notifications do, to every registered device."
          status={test && (
            <span className={test.ok ? 's-ok' : 's-bad'}>
              {test.ok
                ? `Sent to ${test.delivered} device${test.delivered === 1 ? '' : 's'}. If nothing shows, check Focus modes${ios ? ' and that Totem is on the Home Screen' : ''}.`
                : describeFailure(test)}
              {test.results.filter((r) => !r.ok).map((r) => <em key={r.label}> {r.label}: {r.error || `HTTP ${r.status}`}.</em>)}
            </span>
          )}
          control={
            <button className="btn" onClick={runTest} disabled={busy || !configured || active.length === 0}>
              <Hi icon={BellAlertIcon} size={15} /> Send test
            </button>
          }
        />
        {ios && !state.subscribed && (
          <SettingsRow
            id="push-iphone"
            title="On an iPhone, add Totem to the Home Screen first"
            description="Apple only allows push for installed web apps, never a Safari tab: Share, then Add to Home Screen, then open Totem from that icon and turn push on."
            control={<button className="btn" onClick={() => void refresh()} disabled={busy}><Hi icon={ArrowPathIcon} size={15} /> Re-check</button>}
          />
        )}
        {error && <p className="s-error">{error}</p>}
      </SettingsSection>

      <SettingsSection id="push-devices" title="Devices" description="Every device that gets Totem’s notifications.">
        {devices.length === 0 && (
          <SettingsRow title="No devices yet" description="Turn push on from the device you want notified, most usefully your phone. The iPhone app registers itself." />
        )}
        {active.map((device) => (
          <SettingsRow
            key={device.id}
            title={<><Hi icon={DevicePhoneMobileIcon} size={14} /> {device.label}</>}
            description={`Registered ${when(device.createdAt)} · last notification ${when(device.lastDeliveredAt)}${device.host ? ` · ${device.host}` : ''}`}
            control={<span className="pill pill-ok">Active</span>}
          />
        ))}
        {expired.map((device) => (
          // Named rather than hidden: the usual cause is the web app being removed
          // from the Home Screen, and dropping the row makes that look like it never existed.
          <SettingsRow
            key={device.id}
            title={device.label}
            description={`Gone: the push service rejected it${device.lastError ? ` (${device.lastError})` : ''}. Add Totem to that device’s Home Screen again and turn push on.`}
            control={<span className="pill pill-warn">Expired</span>}
          />
        ))}
      </SettingsSection>

      <DuplicatesSection />
    </SettingsPage>
  )
}

function describeFailure(test: TestResult): string {
  if (test.reason === 'no-devices') return 'No registered devices to send to yet.'
  if (test.reason === 'not-configured') return 'The server has no VAPID keys.'
  if (test.reason === 'all-devices-gone') {
    return 'Every registered device was rejected by the push service — they have been marked expired below.'
  }
  return 'The push service refused it.'
}

// One push per usage state and one per story: the gate every notification passes
// (notify/dedupe.mjs). A repeat is folded into the notification it repeats, which
// the bell marks "N similar held back"; this lists them with the reason.
function DuplicatesSection() {
  const [state, setState] = useState<DedupeState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setState(await getDedupe()) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
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

  if (!state) return error ? <SettingsNote tone="error"><WarnIcon /><span>{error}</span></SettingsNote> : null
  const { settings } = state
  const match = STORY_MATCH.some((m) => m.value === settings.sameStoryScore)
    ? STORY_MATCH
    : [...STORY_MATCH, { value: settings.sameStoryScore, label: `Custom (${settings.sameStoryScore})` }]

  return (
    <SettingsSection
      id="duplicates"
      title="Duplicates"
      description="Something already said is not said again: a quota stays spent until it resets, and a story several feeds report goes out once. Reminders, approvals and chat answers are never held back."
    >
      <SettingsRow
        id="dedupe"
        title="Hold back repeats"
        control={<Switch label="Hold back repeats" checked={settings.enabled} onChange={(v) => void save({ enabled: v })} />}
      />
      {settings.enabled && (
        <>
          <SettingsRow
            id="same-story"
            title="Same story"
            description="How alike two headlines must be. The same link always counts; so does the same model name and version."
            control={
              <select className="model-select" aria-label="Same story" value={String(settings.sameStoryScore)} onChange={(e) => void save({ sameStoryScore: Number(e.target.value) })}>
                {match.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            }
          />
          <SettingsRow
            id="story-window"
            title="Compare stories over"
            description="How far back a new headline is checked against what was sent."
            control={
              <select className="model-select" aria-label="Compare stories over" value={String(settings.storyWindowHours)} onChange={(e) => void save({ storyWindowHours: Number(e.target.value) })}>
                {[...new Set([12, 24, 48, 72, 168, settings.storyWindowHours])].sort((a, b) => a - b).map((h) => (
                  <option key={h} value={h}>{h < 48 ? `${h} hours` : `${h / 24} days`}</option>
                ))}
              </select>
            }
          />
          <SettingsRow
            id="model-check"
            title="Ask a model about close calls"
            description="Only for headlines the word and name overlap could not settle, on your default AI account. If it fails or is slow, the notification goes out."
            control={<Switch label="Ask a model about close calls" checked={settings.modelCheck} onChange={(v) => void save({ modelCheck: v })} />}
          />
        </>
      )}
      <SettingsRow
        id="held-back"
        title={`${state.suppressed} held back in the last ${state.days} days`}
        description={state.suppressed ? 'Each is counted on the notification it repeated, in the bell.' : 'Nothing has been a repeat lately.'}
        control={<button className="btn compact" onClick={() => void load()}><Hi icon={ArrowPathIcon} size={14} /> Refresh</button>}
      >
        {state.items.length > 0 && (
          <details className="s-fold">
            <summary>Show the last {Math.min(10, state.items.length)}</summary>
            <ul className="s-plain-list">
              {state.items.slice(0, 10).map((item) => (
                <li key={item.id}>
                  <strong>{item.body || item.title}</strong>
                  <span className="muted">
                    {item.reason === 'same-story' ? `Same story as “${item.duplicateTitle}”` : 'Already sent'}
                    {` · ${item.why} · ${when(item.at)}`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </SettingsRow>
      {error && <p className="s-error">{error}</p>}
    </SettingsSection>
  )
}
