import { describe, expect, it } from 'vitest'
import { poolInputsFor } from './poolInputs'
import { buildLinkedPoolModels } from './poolLinked'
import { buildPoolModel } from './poolModel'
import type { ProxyAccount, ProxyHistorySample } from '../api'
import { HOUR_MS } from './poolModel'
import { createCliproxySource } from '../../../../cliproxy/source.mjs'
import { normalizeHistory } from '../../../../cliproxy/history.mjs'
const now = Date.UTC(2026, 10, 6)
const reset = now + 4 * HOUR_MS
const account = (extra = {}) =>
  ({
    id: 'claude:proxy:a',
    backend: 'claude',
    displayName: 'Seat A',
    source: 'cliproxy',
    fetchedAt: now,
    plan: 'Max 5x',
    meters: [
      { key: 'session:', remainingPct: 90, windowMinutes: 300, resetsAt: reset },
      { key: 'weekly_all:', remainingPct: 0, windowMinutes: 10080, resetsAt: reset + 48 * HOUR_MS },
      { key: 'weekly_scoped:opus', remainingPct: 88 },
    ],
    ...extra,
  }) as ProxyAccount

describe('Totem quota graph inputs', () => {
  it('preserves a historical weekly lockout when a post-reset usage check fails', async () => {
    const initial = now - 2 * HOUR_MS
    const weeklyReset = now - HOUR_MS
    let time = initial
    let failed = false
    const files = [{ name: 'a', provider: 'claude', auth_index: 'idx', status: 'active' }]
    const recorded: unknown[] = []
    const client = {
      configured: () => true, fingerprint: () => 'config', baseUrl: () => 'http://proxy.example.net', scrub: (s: string) => s,
      request: async (_method: string, path: string, options?: any) => {
        if (path === '/quota/history') { recorded.push({ t: time, ...options.json }); return {} }
        return { files }
      },
      upstream: async (_index: string, call: { url: string }) => {
        if (call.url.endsWith('/profile')) return { statusCode: 200, body: {} }
        if (failed) throw new Error('usage check unavailable')
        return { statusCode: 200, body: { limits: [
          { kind: 'session', percent: 20, resets_at: new Date(now + 3 * HOUR_MS).toISOString() },
          { kind: 'weekly_all', percent: 100, resets_at: new Date(weeklyReset).toISOString() },
        ] } }
      },
    }
    const source = createCliproxySource({ client, now: () => time })
    await source.read({ watched: true })
    time = now
    failed = true
    const { accounts } = await source.read({ watched: true })
    const history = normalizeHistory({ samples: recorded }, files, now).samples as ProxyHistorySample[]
    const weekly = poolInputsFor('claude', accounts, history, 'weekly')
    const five = poolInputsFor('claude', accounts, history, 'five-hour')
    const models = buildLinkedPoolModels(weekly, five, { now, burnWindowHours: 3, futureFactor: 1, recordedFromMs: initial, projectToMs: now + HOUR_MS })
    expect(models.fiveHour.recorded.find((p) => p.t === initial + HOUR_MS / 2)?.v).toBe(0)
    expect(models.fiveHour.recorded.find((p) => p.t === weeklyReset)?.v).toBe(80)
    expect(models.fiveHour.current).toBe(80)
  })
  it('maps the all-model weekly limit, keeps raw five-hour data and lets the linked model gate it', () => {
    const a = account()
    const history: ProxyHistorySample[] = [
      {
        t: now - HOUR_MS,
        accountId: a.id,
        provider: 'claude',
        source: 'passive',
        windows: {
          five_hour: { used: 10, resetAtMs: reset, windowMinutes: 300 },
          seven_day: { used: 100, resetAtMs: reset + 48 * HOUR_MS, windowMinutes: 10080 },
        },
      },
    ]
    const weekly = poolInputsFor('claude', [a], history, 'weekly')
    const five = poolInputsFor('claude', [a], history, 'five-hour')
    expect(weekly[0].remaining).toBe(0)
    expect(five[0].remaining).toBe(90)
    expect(five[0].size).toBe(5)
    const model = buildLinkedPoolModels(weekly, five, {
      now,
      burnWindowHours: 3,
      futureFactor: 1,
      recordedFromMs: now - HOUR_MS,
      projectToMs: now + HOUR_MS,
    }).fiveHour
    expect(model.current).toBe(0)
    expect(model.recorded.every((p) => p.v === 0)).toBe(true)
    expect(model.projected[0].v).toBe(0)
  })
  it("reads Claude's Fable cap live and from history, and gives Codex none", () => {
    const a = account({
      meters: [
        { key: 'weekly_all:', remainingPct: 33, windowMinutes: 10080, resetsAt: reset },
        { key: 'weekly_scoped:Fable', remainingPct: 28, windowMinutes: 10080, resetsAt: reset },
      ],
    })
    const history: ProxyHistorySample[] = [
      { t: now - HOUR_MS, accountId: a.id, provider: 'claude', source: 'passive', windows: { seven_day: { used: 60, resetAtMs: reset, windowMinutes: null }, seven_day_fable: { used: 70, resetAtMs: reset, windowMinutes: null } } },
      { t: now - 2 * HOUR_MS, accountId: a.id, provider: 'claude', source: 'passive', windows: { seven_day: { used: 59, resetAtMs: reset, windowMinutes: null } } },
    ]
    const [fable] = poolInputsFor('claude', [a], history, 'fable')
    expect(fable.remaining).toBe(28)
    expect(fable.resetAtMs).toBe(reset)
    expect(fable.samples).toEqual([{ t: now - HOUR_MS, remaining: 30, resetAtMs: reset }])
    expect(poolInputsFor('claude', [account()], [], 'fable')[0].remaining).toBeNull()
    const codex = account({ id: 'codex:proxy:b', backend: 'codex', meters: [{ key: 'weekly_scoped:Fable', remainingPct: 5 }] })
    expect(poolInputsFor('codex', [codex], [], 'fable')[0].remaining).toBeNull()
  })
  it('matches Codex primary and secondary by their actual duration', () => {
    const a = account({
      id: 'codex:proxy:b',
      backend: 'codex',
      meters: [
        { key: 'primary', remainingPct: 12, windowMinutes: 10080 },
        { key: 'secondary', remainingPct: 34, windowMinutes: 300 },
      ],
    })
    expect(poolInputsFor('codex', [a], [], 'weekly')[0].remaining).toBe(12)
    expect(poolInputsFor('codex', [a], [], 'five-hour')[0].remaining).toBe(34)
  })
  it('excludes disabled seats and local accounts, while including seats hidden from the floating panel', () => {
    const list = [account({ disabled: true }), account({ source: 'local' }), account({ hidden: true })]
    expect(poolInputsFor('claude', list, [], 'five-hour')).toHaveLength(1)
  })
  it('weights Claude plans by price, so Max 20x is 100% and a Max 5x seat 50%', () => {
    const big = account({ id: 'claude:proxy:big', plan: 'Max 20x', planSize: 20, meters: [{ key: 'session:', remainingPct: 100, windowMinutes: 300 }] })
    const team = account({ id: 'claude:proxy:team', plan: 'Team', planSize: 5, meters: [{ key: 'session:', remainingPct: 100, windowMinutes: 300 }] })
    const inputs = poolInputsFor('claude', [big, team], [], 'five-hour')
    expect(inputs.map((a) => a.size)).toEqual([10, 5])
    const model = buildPoolModel(inputs, { now, burnWindowHours: 3, futureFactor: 1, projectToMs: now + HOUR_MS })
    expect(model.capacity).toBe(150)
    expect(model.current).toBe(150)
    const codex = account({ id: 'codex:proxy:c', backend: 'codex', plan: 'Team', planSize: 1, meters: [{ key: 'primary', remainingPct: 100, windowMinutes: 300 }] })
    expect(poolInputsFor('codex', [codex], [], 'five-hour')[0].size).toBe(1)
  })
})
