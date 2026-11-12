import assert from 'node:assert/strict'
import test from 'node:test'
import { historyWindowsFromMeters, normalizeHistory } from './history.mjs'

const now = Date.UTC(2026, 10, 6)
const reset = now + 3600_000
const files = [{ name: 'a.json', provider: 'claude', auth_index: 'idx' }]

test('history exposes numeric quota for current credentials, with no raw credential fields', () => {
  const sample = { t: now - 1000, auth_index: 'idx', provider: 'claude', source: 'active', token: 'SECRET',
    windows: { five_hour: { used: 20, reset_at: reset }, seven_day: { used: 100 }, secret: { used: 1 } } }
  const out = normalizeHistory({ now, samples: [sample, { ...sample, auth_index: 'deleted' }, { ...sample, provider: 'codex' }, { ...sample, t: now + 1 }] }, files, now)
  assert.deepEqual(out.samples, [{ t: now - 1000, accountId: 'claude:proxy:a.json', provider: 'claude', source: 'active',
    windows: { five_hour: { used: 20, resetAtMs: reset, windowMinutes: null }, seven_day: { used: 100, resetAtMs: null, windowMinutes: null } } }])
  assert.doesNotMatch(JSON.stringify(out), /SECRET|auth_index|deleted/)
})

test('malformed and old history is discarded; values are bounded', () => {
  const make = (extra) => ({ t: now - 100, auth_index: 'idx', provider: 'claude', windows: { five_hour: { used: 500 } }, ...extra })
  const out = normalizeHistory({ samples: [null, make({t: now - 22 * 86400_000}), make({windows: { five_hour: { used: '9' } }}), make({})] }, files, now)
  assert.equal(out.samples.length, 1)
  assert.equal(out.samples[0].windows.five_hour.used, 100)
})

test('active history records raw main windows and Fable, and excludes other model-scoped limits', () => {
  const meters = [{ key: 'session:', usedPct: 20, resetsAt: reset, windowMinutes: 300 }, { key: 'weekly_all:', usedPct: 100, resetsAt: reset, windowMinutes: 10080 }, { key: 'weekly_scoped:opus', usedPct: 50 }, { key: 'weekly_scoped:Fable', usedPct: 72, resetsAt: reset, windowMinutes: 10080 }]
  assert.deepEqual(historyWindowsFromMeters('claude', meters), { five_hour: { used: 20, reset_at: reset, window_minutes: 300 }, seven_day: { used: 100, reset_at: reset, window_minutes: 10080 }, seven_day_fable: { used: 72, reset_at: reset, window_minutes: 10080 } })
  assert.deepEqual(historyWindowsFromMeters('codex', [{ key: 'weekly_scoped:Fable', usedPct: 72 }]), {})
  assert.deepEqual(historyWindowsFromMeters('codex', [{ key: 'primary', usedPct: 99, windowMinutes: 300 }]), { primary: { used: 99, window_minutes: 300 } })
})

test("Fable history reads the proxy's passive 7d_oi window and the active seven_day_fable one", () => {
  const sample = (windows, source = 'passive') => ({ t: now - 1000, auth_index: 'idx', provider: 'claude', source, windows })
  const out = normalizeHistory({ samples: [
    sample({ seven_day: { used: 67 }, seven_day_oi: { used: 72, reset_at: reset } }),
    sample({ seven_day_fable: { used: 40 }, seven_day_oi: { used: 99 } }, 'active'),
    sample({ seven_day_oi: { used: 'x' } }),
  ] }, files, now)
  assert.equal(out.samples.length, 2)
  assert.deepEqual(out.samples[0].windows.seven_day_fable, { used: 72, resetAtMs: reset, windowMinutes: null })
  assert.equal(out.samples[1].windows.seven_day_fable.used, 40)
  assert.equal(out.samples[0].windows.seven_day_oi, undefined)
})
