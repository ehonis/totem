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
import { Hi, BellAlertIcon, WarnIcon, ArrowPathIcon, CheckCircleIcon, DevicePhoneMobileIcon } from '../icons'
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

  if (!state) return <div className="settings-pane"><header className="settings-pane-head"><h2>Notifications</h2></header></div>

  const active = devices.filter((d) => d.state === 'active')
  const expired = devices.filter((d) => d.state === 'expired')

  return (
    <div className="settings-pane">
      <header className="settings-pane-head">
        <h2>Notifications</h2>
        <p>
          Push notifications from Totem itself — reminders, the daily digest, and anything
          that breaks. Test it from here and watch your phone.
        </p>
      </header>

      {!configured && (
        <div className="shortcut-warn error">
          <WarnIcon />
          <span>
            The server has no VAPID keys. Run <code>node notify/cli.mjs keys</code> on the box,
            paste the three lines into <code>.env</code>, and restart the bridge.
          </span>
        </div>
      )}

      {state.blocker && (
        <div className="shortcut-warn">
          <WarnIcon />
          <span>{state.blocker}</span>
        </div>
      )}

      <div className="settings-section-title"><span /><strong>This device</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy">
            <strong>Push notifications</strong>
            <span>
              {state.subscribed
                ? 'This device is registered and will receive notifications.'
                : 'Ask for permission and register this device.'}
            </span>
          </div>
          <div className="setting-control">
            {state.subscribed ? (
              <button className="btn" onClick={disable} disabled={busy}>Turn off</button>
            ) : (
              <button className="btn primary" onClick={enable} disabled={busy || Boolean(state.blocker) || !configured}>
                {busy ? 'Working…' : 'Turn on'}
              </button>
            )}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-copy">
            <strong>Send a test</strong>
            <span>
              Goes through the same path the scheduled digests use. Send it from this
              computer and it should appear on every registered device.
            </span>
          </div>
          <div className="setting-control">
            <button className="btn" onClick={runTest} disabled={busy || !configured || active.length === 0}>
              <Hi icon={BellAlertIcon} size={15} /> Send test
            </button>
          </div>
        </div>
      </div>

      {test && (
        <div className={`shortcut-warn${test.ok ? '' : ' error'}`}>
          {test.ok ? <CheckCircleIcon /> : <WarnIcon />}
          <span>
            {test.ok
              ? `Sent to ${test.delivered} device${test.delivered === 1 ? '' : 's'}. If nothing arrives, the push service accepted it but the phone did not show it — check Focus modes and that Totem is on the Home Screen.`
              : describeFailure(test)}
            {test.results.filter((r) => !r.ok).map((r) => (
              <em key={r.label}> {r.label}: {r.error || `HTTP ${r.status}`}.</em>
            ))}
          </span>
        </div>
      )}

      {error && (
        <div className="shortcut-warn error">
          <WarnIcon />
          <span>{error}</span>
        </div>
      )}

      <div className="settings-section-title"><span /><strong>Devices</strong></div>
      <div className="setting-list">
        {devices.length === 0 && (
          <div className="setting-row">
            <div className="setting-copy">
              <strong>No devices yet</strong>
              <span>Turn push on from the device you want notified — most usefully, your phone.</span>
            </div>
          </div>
        )}
        {active.map((device) => (
          <div className="setting-row" key={device.id}>
            <div className="setting-copy">
              <strong><Hi icon={DevicePhoneMobileIcon} size={14} /> {device.label}</strong>
              <span>Registered {when(device.createdAt)} · last notification {when(device.lastDeliveredAt)}{device.host ? ` · ${device.host}` : ''}</span>
            </div>
            <div className="setting-control"><span className="pill ok">Active</span></div>
          </div>
        ))}
        {expired.map((device) => (
          <div className="setting-row" key={device.id}>
            <div className="setting-copy">
              <strong>{device.label}</strong>
              {/* Named rather than hidden: the usual cause is the web app being
                  removed from the Home Screen, and silently dropping the row makes
                  that look like it never existed. */}
              <span>
                Gone — the push service rejected it{device.lastError ? ` (${device.lastError})` : ''}.
                Re-add Totem to that device's Home Screen and turn push on again.
              </span>
            </div>
            <div className="setting-control"><span className="pill warn">Expired</span></div>
          </div>
        ))}
      </div>

      <DuplicatesSection />

      <div className="settings-section-title"><span /><strong>Getting it on your phone</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy">
            <strong>iOS needs Totem on the Home Screen</strong>
            <span>
              Apple only allows push for installed web apps — it never works from a Safari tab.
              Open Totem in Safari on the phone, tap Share, then "Add to Home Screen". Open it
              from the new icon, come back to this page, and tap Turn on.
            </span>
          </div>
          <div className="setting-control">
            <button className="btn" onClick={() => void refresh()} disabled={busy}>
              <Hi icon={ArrowPathIcon} size={15} /> Re-check
            </button>
          </div>
        </div>
      </div>
    </div>
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

  if (!state) return error ? <div className="shortcut-warn error"><WarnIcon /><span>{error}</span></div> : null
  const { settings } = state
  const match = STORY_MATCH.some((m) => m.value === settings.sameStoryScore)
    ? STORY_MATCH
    : [...STORY_MATCH, { value: settings.sameStoryScore, label: `Custom (${settings.sameStoryScore})` }]

  return (
    <>
      <div className="settings-section-title"><span /><strong>Duplicates</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy">
            <strong>Hold back repeats</strong>
            <span>
              Something already said is not said again: a quota stays spent until it resets, and a story
              several feeds report goes out once. Reminders, approvals and chat answers are never held back.
            </span>
          </div>
          <div className="setting-control">
            <select className="model-select" value={settings.enabled ? 'on' : 'off'} onChange={(e) => void save({ enabled: e.target.value === 'on' })}>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>Same story</strong>
            <span>How alike two headlines must be. The same link always counts; so does the same model name and version.</span>
          </div>
          <div className="setting-control">
            <select className="model-select" disabled={!settings.enabled} value={String(settings.sameStoryScore)} onChange={(e) => void save({ sameStoryScore: Number(e.target.value) })}>
              {match.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>Compare stories over</strong>
            <span>How far back a new headline is checked against what was sent.</span>
          </div>
          <div className="setting-control">
            <select className="model-select" disabled={!settings.enabled} value={String(settings.storyWindowHours)} onChange={(e) => void save({ storyWindowHours: Number(e.target.value) })}>
              {[...new Set([12, 24, 48, 72, 168, settings.storyWindowHours])].sort((a, b) => a - b).map((h) => (
                <option key={h} value={h}>{h < 48 ? `${h} hours` : `${h / 24} days`}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>Ask a model about close calls</strong>
            <span>
              Only for a pair of headlines the word and name overlap could not settle, on your default AI
              account. If it fails or is slow, the notification goes out.
            </span>
          </div>
          <div className="setting-control">
            <select className="model-select" disabled={!settings.enabled} value={settings.modelCheck ? 'on' : 'off'} onChange={(e) => void save({ modelCheck: e.target.value === 'on' })}>
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>{state.suppressed} held back in the last {state.days} days</strong>
            <span>{state.suppressed ? 'Each one is counted on the notification it repeated, in the bell.' : 'Nothing has been a repeat lately.'}</span>
          </div>
          <div className="setting-control">
            <button className="btn" onClick={() => void load()}><Hi icon={ArrowPathIcon} size={15} /> Refresh</button>
          </div>
        </div>
        {state.items.slice(0, 10).map((item) => (
          <div className="setting-row" key={item.id}>
            <div className="setting-copy">
              <strong>{item.body || item.title}</strong>
              <span>
                {item.reason === 'same-story' ? `Same story as “${item.duplicateTitle}”` : 'Already sent'}
                {` · ${item.why} · ${when(item.at)}`}
              </span>
            </div>
          </div>
        ))}
      </div>
      {error && <div className="shortcut-warn error"><WarnIcon /><span>{error}</span></div>}
    </>
  )
}
