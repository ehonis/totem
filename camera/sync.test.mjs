// Run with: node --test camera/
//
// These run against a fake card on disk rather than a real mount, so everything
// except the `mount` call itself is covered: the DCIM guard, both dedupe gates,
// date foldering, collision handling, and the checkpointing that decides what a
// yanked cable costs.
//
// The module reads its paths from the environment at import time, so the env has
// to be set before the dynamic import below — a static import would bind the
// real staging directory and these tests would write into the owner's photos.
import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, utimes, readFile, readdir, stat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { photo } from './fixtures.mjs'

const SANDBOX = await mkdtemp(join(tmpdir(), 'camera-sync-test-'))
process.env.CAMERA_STAGING_DIR = join(SANDBOX, 'staging')
process.env.CAMERA_STATE_DIR = join(SANDBOX, 'state')
process.env.CAMERA_MIN_FREE_BYTES = '0'

const { syncFrom, LEDGER_FILE } = await import('./sync.mjs')
const STAGING = process.env.CAMERA_STAGING_DIR

const CARD = join(SANDBOX, 'card')

// Put a file on the fake card. mtime is set explicitly because it's half of the
// cheap dedupe key, and a test that let it default would pass for the wrong
// reason.
async function put(relPath, content, mtime = new Date('2011-04-03T18:22:07Z')) {
  const full = join(CARD, relPath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
  await utimes(full, mtime, mtime)
  return full
}

/** Every file in staging, as paths relative to the staging root. */
async function staged(dir = STAGING, base = STAGING, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await staged(full, base, out)
    else out.push(full.slice(base.length + 1))
  }
  return out.sort()
}

beforeEach(async () => {
  await rm(CARD, { recursive: true, force: true })
  await rm(STAGING, { recursive: true, force: true })
  await rm(LEDGER_FILE, { force: true })
})

after(async () => { await rm(SANDBOX, { recursive: true, force: true }) })

test('copies a new photo into year/day folders, named by shot time', async () => {
  await put('DCIM/100OLYMP/P1010001.JPG', photo('2011:04:03 18:22:07'))
  const result = await syncFrom(CARD)
  assert.equal(result.copied, 1)
  assert.equal(result.duplicates, 0)
  assert.deepEqual(await staged(), ['2011/2011-04-03/2011-04-03_182207_P1010001.JPG'])
  assert.deepEqual(result.days, ['2011-04-03'])
})

test('the card is never modified', async () => {
  const file = await put('DCIM/100OLYMP/P1010001.JPG', photo('2011:04:03 18:22:07'))
  const before = await stat(file)
  await syncFrom(CARD)
  const after_ = await stat(file)
  assert.equal(before.size, after_.size)
  assert.equal(before.mtimeMs, after_.mtimeMs)
  // Nothing new appeared next to it either — no marker files, no sidecars.
  assert.deepEqual(await readdir(join(CARD, 'DCIM/100OLYMP')), ['P1010001.JPG'])
})

test('a second plug-in copies nothing', async () => {
  await put('DCIM/100OLYMP/P1010001.JPG', photo('2011:04:03 18:22:07'))
  assert.equal((await syncFrom(CARD)).copied, 1)

  const second = await syncFrom(CARD)
  assert.equal(second.copied, 0)
  assert.equal(second.skipped, 'nothing-new')
  assert.equal((await staged()).length, 1)
})

test('identical bytes under a new name are recognised and not stored twice', async () => {
  // What a card format looks like: numbering restarts, so the same photo comes
  // back as a different filename with a different mtime. The cheap key misses,
  // the content hash catches it.
  const bytes = photo('2011:04:03 18:22:07')
  await put('DCIM/100OLYMP/P1010001.JPG', bytes)
  await syncFrom(CARD)

  await rm(join(CARD, 'DCIM/100OLYMP/P1010001.JPG'))
  await put('DCIM/101OLYMP/P1020009.JPG', bytes, new Date('2012-01-01T00:00:00Z'))
  const result = await syncFrom(CARD)

  assert.equal(result.copied, 0)
  assert.equal(result.duplicates, 1)
  assert.deepEqual(await staged(), ['2011/2011-04-03/2011-04-03_182207_P1010001.JPG'])
})

test('a duplicate is remembered, so it is not re-read on every plug-in', async () => {
  // Without recording the cheap key for a discarded duplicate, this file gets
  // fully re-read forever — the exact cost the two-tier gate exists to avoid.
  const bytes = photo('2011:04:03 18:22:07')
  await put('DCIM/100OLYMP/P1010001.JPG', bytes)
  await syncFrom(CARD)
  await put('DCIM/101OLYMP/P1020009.JPG', bytes, new Date('2012-01-01T00:00:00Z'))
  assert.equal((await syncFrom(CARD)).duplicates, 1)

  const third = await syncFrom(CARD)
  assert.equal(third.skipped, 'nothing-new')
  assert.equal(third.duplicates, 0)
})

test('the same filename with different content is still copied', async () => {
  // The other half of a card format: P1010001.JPG is a *different* photo now.
  // Trusting the filename would lose it silently.
  await put('DCIM/100OLYMP/P1010001.JPG', photo('2011:04:03 18:22:07', { pad: 64 }))
  await syncFrom(CARD)
  await put('DCIM/100OLYMP/P1010001.JPG', photo('2015:08:09 10:11:12', { pad: 64 }), new Date('2015-08-09T10:11:12Z'))

  const result = await syncFrom(CARD)
  assert.equal(result.copied, 1)
  assert.deepEqual(await staged(), [
    '2011/2011-04-03/2011-04-03_182207_P1010001.JPG',
    '2015/2015-08-09/2015-08-09_101112_P1010001.JPG',
  ])
})

test('two photos with the same name and shot second do not overwrite each other', async () => {
  await put('DCIM/100OLYMP/P1010001.JPG', photo('2011:04:03 18:22:07', { pad: 32 }))
  await put('DCIM/101OLYMP/P1010001.JPG', photo('2011:04:03 18:22:07', { pad: 999 }))
  const result = await syncFrom(CARD)
  assert.equal(result.copied, 2)
  assert.deepEqual(await staged(), [
    '2011/2011-04-03/2011-04-03_182207_P1010001-2.JPG',
    '2011/2011-04-03/2011-04-03_182207_P1010001.JPG',
  ])
})

test('a volume with no DCIM folder is left completely alone', async () => {
  // The udev rule fires for any USB filesystem, so this is what plugging in a
  // memory stick does. It must be a quiet no-op, not an error.
  await mkdir(join(CARD, 'Documents'), { recursive: true })
  await writeFile(join(CARD, 'Documents/notes.txt'), 'hello')
  const result = await syncFrom(CARD)
  assert.equal(result.skipped, 'no-dcim')
  assert.equal(result.copied, 0)
  assert.deepEqual(await staged(), [])
})

test('RAW files and AppleDouble sidecars are ignored', async () => {
  await put('DCIM/100OLYMP/P1010001.JPG', photo('2011:04:03 18:22:07'))
  await put('DCIM/100OLYMP/P1010001.ORF', Buffer.alloc(2048, 7))
  await put('DCIM/100OLYMP/._P1010001.JPG', Buffer.from('AppleDouble junk'))
  await put('DCIM/100OLYMP/notes.txt', Buffer.from('x'))

  const result = await syncFrom(CARD)
  assert.equal(result.examined, 1)
  assert.deepEqual(await staged(), ['2011/2011-04-03/2011-04-03_182207_P1010001.JPG'])
})

test('a photo with no readable EXIF falls back to its mtime', async () => {
  const when = new Date('2013-07-04T09:08:07')
  await put('DCIM/100OLYMP/P1010005.JPG', Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 1, 2, 3]), when)
  await syncFrom(CARD)
  // Local time, because that's the zone a shot date is meaningful in.
  assert.deepEqual(await staged(), ['2013/2013-07-04/2013-07-04_090807_P1010005.JPG'])
})

test('a corrupt ledger starts over rather than blocking the sync', async () => {
  await put('DCIM/100OLYMP/P1010001.JPG', photo('2011:04:03 18:22:07'))
  await syncFrom(CARD)
  await writeFile(LEDGER_FILE, '{ this is not json')

  // Re-reads the card and re-copies — but the content hash is gone with the
  // ledger, so it lands beside the original rather than replacing it.
  const result = await syncFrom(CARD)
  assert.equal(result.copied, 1)
  assert.equal((await staged()).length, 2)
})

test('dry run reports what it would take and writes nothing', async () => {
  await put('DCIM/100OLYMP/P1010001.JPG', photo('2011:04:03 18:22:07'))
  const result = await syncFrom(CARD, { dryRun: true })
  assert.equal(result.wouldCopy, 1)
  assert.equal(result.copied, 0)
  assert.deepEqual(await staged(), [])
  // And the ledger is untouched, so the real run still sees the photo as new.
  assert.equal(await readFile(LEDGER_FILE, 'utf8').catch(() => null), null)
})

test('nested and oddly-cased DCIM layouts are still found', async () => {
  await put('dcim/100OLYMP/sub/P1010001.JPG', photo('2011:04:03 18:22:07'))
  assert.equal((await syncFrom(CARD)).copied, 1)
})

// A bad sector on an ageing card reads fine in stat() and fails in read(). Root
// bypasses the permission bits used to simulate that, so there's nothing to test.
test('an unreadable photo does not abandon the rest of the card', { skip: process.getuid?.() === 0 && 'runs as root' }, async () => {
  await put('DCIM/100OLYMP/P1010001.JPG', photo('2011:04:03 18:22:07', { pad: 10 }))
  const bad = await put('DCIM/100OLYMP/P1010002.JPG', photo('2011:04:03 18:22:08', { pad: 20 }))
  await put('DCIM/100OLYMP/P1010003.JPG', photo('2011:04:03 18:22:09', { pad: 30 }))
  await chmod(bad, 0o000)

  const result = await syncFrom(CARD)
  assert.equal(result.copied, 2)
  assert.match(result.error, /P1010002/)
  assert.deepEqual(await staged(), [
    '2011/2011-04-03/2011-04-03_182207_P1010001.JPG',
    '2011/2011-04-03/2011-04-03_182209_P1010003.JPG',
  ])

  // And it isn't written off: once the read succeeds, the next plug-in gets it.
  await chmod(bad, 0o644)
  assert.equal((await syncFrom(CARD)).copied, 1)
})
