// Run with: node --test camera/
//
// ack.mjs is the only part of this that takes input from another machine — the
// MacBook pipes it a list of paths over ssh. So the guard gets real tests: a
// compromised or confused Mac must not be able to name a path outside staging
// and have this move it.
import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = await mkdtemp(join(tmpdir(), 'camera-ack-test-'))
process.env.CAMERA_STAGING_DIR = join(SANDBOX, 'camera-inbox')
process.env.CAMERA_ARCHIVE_DIR = join(SANDBOX, 'camera-archive')
process.env.CAMERA_STATE_DIR = join(SANDBOX, 'state')

const { ackPaths, safeTarget, STAGING, ARCHIVE } = await import('./ack.mjs')

// Something outside staging that a traversal would reach — the whole point of
// the guard is that this file is still here at the end of every test.
const SECRET = join(SANDBOX, 'private.txt')

async function put(rel, body = 'photo bytes') {
  const full = join(STAGING, rel)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, body)
  return full
}

beforeEach(async () => {
  await rm(STAGING, { recursive: true, force: true })
  await rm(ARCHIVE, { recursive: true, force: true })
  await writeFile(SECRET, 'do not touch')
})

after(async () => { await rm(SANDBOX, { recursive: true, force: true }) })

test('moves an acknowledged photo into the archive, keeping its folders', async () => {
  await put('2011/2011-04-03/2011-04-03_182207_P1010001.JPG')
  const result = await ackPaths(['2011/2011-04-03/2011-04-03_182207_P1010001.JPG'])

  assert.equal(result.moved, 1)
  assert.ok(await stat(join(ARCHIVE, '2011/2011-04-03/2011-04-03_182207_P1010001.JPG')))
  // Gone from staging is the point: staging *is* the backlog.
  assert.deepEqual(await readdir(join(STAGING, '2011/2011-04-03')), [])
})

test('refuses to walk out of staging', async () => {
  const escapes = [
    '../private.txt',
    '../../private.txt',
    '2011/../../private.txt',
    './../../private.txt',
    '..',
    '../',
  ]
  for (const path of escapes) {
    assert.equal(safeTarget(path), null, `should have refused ${path}`)
  }

  const result = await ackPaths(escapes)
  assert.equal(result.rejected, escapes.length)
  assert.equal(result.moved, 0)
  // And the thing they were reaching for is untouched.
  assert.equal(await stat(SECRET).then(() => true), true)
})

test('an absolute path is confined to staging, not followed to the real one', async () => {
  // Note this is *not* a rejection — the leading slash is stripped, so the path
  // is re-read as relative to staging. Which is the point: it resolves somewhere
  // harmless that almost certainly doesn't exist, rather than to /etc/passwd.
  for (const path of ['/etc/passwd', '//etc/passwd']) {
    assert.equal(safeTarget(path).full, join(STAGING, 'etc/passwd'))
  }
  const result = await ackPaths(['/etc/passwd'])
  assert.equal(result.moved, 0)
  assert.equal(result.missing, 1)
})

test('a leading slash on a real photo is stripped rather than rejected', async () => {
  // rsync and find emit paths with inconsistent leading slashes depending on how
  // they were invoked; that shouldn't cost an acknowledgement.
  await put('2011/2011-04-03/a.JPG')
  const result = await ackPaths(['/2011/2011-04-03/a.JPG'])
  assert.equal(result.moved, 1)
})

test('acknowledging something already archived is not an error', async () => {
  // The Mac retries an ack whose ssh call failed after the move succeeded. That
  // must be a no-op, not a failure that keeps the backlog looking stuck.
  await put('2011/2011-04-03/a.JPG')
  assert.equal((await ackPaths(['2011/2011-04-03/a.JPG'])).moved, 1)

  const again = await ackPaths(['2011/2011-04-03/a.JPG'])
  assert.equal(again.moved, 0)
  assert.equal(again.missing, 1)
  assert.equal(again.rejected, 0)
})

test('one bad path does not stop the good ones in the same batch', async () => {
  await put('2011/2011-04-03/a.JPG')
  await put('2011/2011-04-03/b.JPG')
  const result = await ackPaths(['2011/2011-04-03/a.JPG', '../private.txt', '2011/2011-04-03/b.JPG'])
  assert.equal(result.moved, 2)
  assert.equal(result.rejected, 1)
  assert.equal(await stat(SECRET).then(() => true), true)
})
