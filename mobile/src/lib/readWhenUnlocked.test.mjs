// The app's launch read of the keychain (readWhenUnlocked.ts), run by the
// bridge's `npm test`: a locked phone must not read as a signed-out app.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readWhenUnlocked } from './readWhenUnlocked.ts'

const locked = () => Object.assign(new Error('User interaction is not allowed.'), { code: 'ERR_KEY_CHAIN' })

// An app that starts in `state`; `open()` brings it to the foreground and wakes
// anyone waiting on untilActive().
function fakeApp(state) {
  let waiters = []
  const app = {
    state,
    waits: 0,
    delays: [],
    isActive: () => app.state === 'active',
    untilActive: () => {
      app.waits += 1
      if (app.state === 'active') return Promise.resolve()
      return new Promise((resolve) => waiters.push(resolve))
    },
    delay: async (ms) => { app.delays.push(ms) },
    open() {
      app.state = 'active'
      const w = waiters
      waiters = []
      w.forEach((fn) => fn())
    },
  }
  return app
}

test('a read refused in the background waits for the app to open, then reads again', async () => {
  const app = fakeApp('background')
  let unlocked = false
  let reads = 0
  const read = async () => {
    reads += 1
    if (!unlocked) throw locked()
    return 'secret'
  }
  const pending = readWhenUnlocked(read, app)
  await new Promise((r) => setImmediate(r))
  assert.equal(reads, 1)
  assert.equal(app.waits, 1)
  // Nothing settles while the phone stays locked.
  let settled = false
  pending.then(() => { settled = true })
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false)
  unlocked = true
  app.open()
  assert.deepEqual(await pending, { ok: true, value: 'secret' })
  assert.equal(reads, 2)
})

test('background failures do not use up the foreground tries', async () => {
  const app = fakeApp('background')
  let reads = 0
  const read = async () => {
    reads += 1
    // Refused twice in the background, then once more just after opening.
    if (reads <= 3) throw locked()
    return 'ok'
  }
  const pending = readWhenUnlocked(read, app, { foregroundTries: 2 })
  await new Promise((r) => setImmediate(r))
  // A second background failure: the app was woken but went back before reading.
  app.open()
  app.state = 'background'
  await new Promise((r) => setImmediate(r))
  app.open()
  assert.deepEqual(await pending, { ok: true, value: 'ok' })
  assert.equal(reads, 4)
  assert.deepEqual(app.delays, [400])
})

test('a read that keeps failing in the foreground gives up after its tries', async () => {
  const app = fakeApp('active')
  let reads = 0
  const error = locked()
  const outcome = await readWhenUnlocked(async () => { reads += 1; throw error }, app, { foregroundTries: 3, retryMs: 50 })
  assert.deepEqual(outcome, { ok: false, error })
  assert.equal(reads, 3)
  assert.deepEqual(app.delays, [50, 50])
  assert.equal(app.waits, 0)
})

test('a phone locked during a foreground read waits instead of using up a try', async () => {
  const app = fakeApp('active')
  let reads = 0
  const read = async () => {
    reads += 1
    // The last foreground try: the phone locks while the read is in flight.
    if (reads === 2) { app.state = 'background'; throw locked() }
    if (reads < 3) throw locked()
    return 'ok'
  }
  const pending = readWhenUnlocked(read, app, { foregroundTries: 2 })
  await new Promise((r) => setImmediate(r))
  assert.equal(reads, 2)
  assert.equal(app.waits, 1)
  app.open()
  assert.deepEqual(await pending, { ok: true, value: 'ok' })
  assert.deepEqual(app.delays, [400])
})

test('an empty keychain is a successful read, not a failure', async () => {
  const app = fakeApp('background')
  const outcome = await readWhenUnlocked(async () => '', app)
  assert.deepEqual(outcome, { ok: true, value: '' })
  assert.equal(app.waits, 0)
})
