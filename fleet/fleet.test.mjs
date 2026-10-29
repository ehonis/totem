import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stateForZip, resolveRate, STATE_RATES } from './pricing.mjs'
import { wallWatts } from './power.mjs'
import { createFleetStore, credit, totals, healthOf } from './store.mjs'

test('a ZIP code names its state and the state its rate', () => {
  assert.equal(stateForZip('43215'), 'OH')
  assert.equal(stateForZip('94110'), 'CA')
  assert.equal(stateForZip('10001-1234'), 'NY')
  assert.equal(stateForZip('abc'), null)
  assert.deepEqual(resolveRate({ zip: '43215' }).centsPerKwh, STATE_RATES.OH)
  assert.equal(resolveRate({ zip: '43215', rateCents: 14.2 }).source, 'custom')
  assert.equal(resolveRate({}).source, 'us')
})

test('wall watts add what no sensor sees, then power-supply loss', () => {
  const linux = wallWatts({ parts: { cpu: { w: 10, measured: true }, gpu: { w: 12, measured: false } } }, 'linux')
  assert.equal(linux.measured, 'partial')
  assert.equal(linux.watts, Math.round(((10 + 12 + 25) / 0.85) * 10) / 10)
  const mac = wallWatts({ parts: { system: { w: 9, measured: true }, cpu: { w: 2, measured: true } } }, 'darwin')
  assert.equal(mac.measured, 'measured')
  assert.equal(mac.watts, 10)
  assert.equal(wallWatts({ parts: { cpu: { w: 10, measured: false } } }, 'linux', { baseWatts: 0, efficiency: 1 }).watts, 10)
})

test('credit spreads time and energy over hour buckets', () => {
  const hours = {}
  const h = 3_600_000
  credit(hours, 10 * h - 1_800_000, 10 * h + 1_800_000, 100)
  assert.deepEqual(hours[9], [1800, 50])
  assert.deepEqual(hours[10], [1800, 50])
  assert.deepEqual(totals(hours, 9 * h, 11 * h), { up: 3600, wh: 100 })
})

const snap = (over = {}) => ({
  id: 'box', hostname: 'box', platform: 'linux', os: 'Linux', cores: 2, bootedAt: 10 * 3_600_000, // booted as Totem first saw it
  cpu: { total: 10, cores: [10, 10], load: [0, 0, 0] },
  memory: { total: 100, used: 50, swapTotal: 0, swapUsed: 0 },
  disks: [], net: { rxBps: 0, txBps: 0 }, temps: {},
  power: { parts: { cpu: { w: 47.25, measured: true } } }, // (47.25 + 25 base) / 0.85 = 85 W at the wall
  ...over,
})

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-'))
  let clock = 10 * 3_600_000
  const notes = []
  const store = createFleetStore({ file: join(dir, 'fleet.json'), historyFile: join(dir, 'hist.json'), now: () => clock, notify: (n) => notes.push(n) })
  try {
    await fn({ store, tick: (ms) => { clock += ms }, notes, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('readings are ignored until the owner switches Fleet on', async () => {
  await withStore(async ({ store }) => {
    const r = await store.report(snap())
    assert.equal(r.enabled, false)
    assert.equal((await store.status()).devices.length, 0)
  })
})

test('a gap in readings on the same boot counts as up; a reboot does not', async () => {
  await withStore(async ({ store, tick }) => {
    await store.updateSettings({ enabled: true, zip: '43215' })
    await store.report(snap())
    tick(30 * 60_000) // Totem was away for half an hour, the box was not
    await store.report(snap())
    let d = (await store.status()).devices[0]
    assert.equal(d.uptime.pct24h, 100)
    assert.equal(d.energy.todayKwh, 0.043) // 85 W for half an hour = 42.5 Wh
    tick(30 * 60_000) // this time it rebooted ten minutes ago
    await store.report(snap({ bootedAt: 10 * 3_600_000 + 50 * 60_000 }))
    d = (await store.status()).devices[0]
    assert.equal(d.uptime.pct24h, 66.67) // up 30 + 10 of 60 minutes
    assert.equal(d.energy.todayCost, Math.round((((42.5 + 85 / 6) / 1000) * STATE_RATES.OH) / 100 * 100) / 100)
  })
})

test('a machine first seen long after boot counts as up since boot, with no invented energy', async () => {
  await withStore(async ({ store, tick }) => {
    await store.updateSettings({ enabled: true })
    tick(3 * 24 * 3_600_000) // first reading three days after boot
    await store.report(snap())
    tick(60_000)
    await store.report(snap())
    const d = (await store.status()).devices[0]
    assert.equal(d.uptime.pct7d, 100)
    assert.equal(d.uptime.since, 10 * 3_600_000)
    assert.equal(d.energy.todayKwh, 0.001) // one minute at 85 W, nothing before
    assert.equal((await store.device('box')).daily.length, 1)
  })
})

test('processes are asked for only while someone has the machine open', async () => {
  await withStore(async ({ store, tick }) => {
    await store.updateSettings({ enabled: true })
    assert.equal((await store.report(snap())).processes, false)
    await store.device('box')
    const r = await store.report(snap({ processes: [{ pid: 1, name: 'init' }] }))
    assert.equal(r.processes, true)
    assert.equal(r.next, 3000)
    tick(60_000)
    assert.equal((await store.report(snap())).processes, false)
  })
})

test('a silent machine raises one notification, and another when it returns', async () => {
  await withStore(async ({ store, tick, notes }) => {
    await store.updateSettings({ enabled: true })
    await store.report(snap())
    tick(6 * 60_000)
    store.checkOffline()
    store.checkOffline()
    assert.equal(notes.length, 1)
    assert.match(notes[0].title, /stopped reporting/)
    assert.equal(notes[0].url, '/fleet#box')
    await store.report(snap())
    assert.equal(notes.length, 2)
    assert.match(notes[1].title, /is back/)
    assert.equal(notes[1].url, '/fleet#box')
  })
})

test('history and settings survive a restart, mode 0600', async () => {
  await withStore(async ({ store, dir }) => {
    await store.updateSettings({ enabled: true, rateCents: 12 })
    await store.report(snap())
    await store.flush()
    const cfg = JSON.parse(await readFile(join(dir, 'fleet.json'), 'utf8'))
    assert.equal(cfg.rateCents, 12)
    const hist = JSON.parse(await readFile(join(dir, 'hist.json'), 'utf8'))
    assert.equal(hist.box.hostname, 'box')
    await assert.rejects(store.updateSettings({ zip: '123' }), /five digits/)
  })
})

test('health flags full disks, swap and sustained CPU', () => {
  const s = snap({ disks: [{ mount: '/', size: 100, used: 96 }], memory: { total: 100, used: 50, swapTotal: 10, swapUsed: 10 } })
  const h = healthOf(s, { online: true, series: [{ cpu: 95 }, { cpu: 97 }] })
  assert.equal(h.level, 'bad')
  assert.deepEqual(h.issues.map((i) => i.text), ['/ 96% full', 'CPU 96% for the last few minutes', 'Swap 100% used'])
  assert.equal(healthOf(s, { online: false, series: [] }).level, 'down')
})
