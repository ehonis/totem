// Run with: node --test camera/
//
// Four combinations run this code: Linux-as-root-from-udev, Linux-as-the-user-over-ssh,
// macOS-as-the-user-from-launchd, and the tests. They disagree about what `~` is —
// notably, homedir() is `/root` under udev — and getting it wrong means photos
// written somewhere nobody looks, or a staging directory that two halves of the
// pipeline don't agree on.
//
// The platform-specific defaults are checked in a child process, because
// paths.mjs reads process.platform at import time and there is no honest way to
// re-import it under a different one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)

/** Resolve the defaults as they'd be on `platform`, with `env` applied. */
async function resolveOn(platform, env = {}) {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })
    const p = await import('${new URL('./paths.mjs', import.meta.url).href}')
    console.log(JSON.stringify({
      isMac: p.IS_MAC,
      staging: p.stagingDir(),
      archive: p.archiveDir(),
      state: p.stateDir('/repo'),
      roots: p.VOLUME_ROOTS,
    }))
  `], { env: { ...process.env, ...env } })
  return JSON.parse(stdout)
}

test('on macOS everything hangs off the home directory', async () => {
  const p = await resolveOn('darwin', { CAMERA_STAGING_DIR: '', CAMERA_STATE_DIR: '', CAMERA_ARCHIVE_DIR: '' })
  assert.equal(p.isMac, true)
  assert.equal(p.staging, `${homedir()}/Pictures/camera-inbox`)
  assert.equal(p.archive, `${homedir()}/Pictures/camera-archive`)
  // Not the repo: install-mac.sh copies the engine to ~/.local/lib, so there is
  // no checkout to keep state in.
  assert.equal(p.state, `${homedir()}/.local/state/totem-camera`)
  assert.deepEqual(p.roots, ['/Volumes'])
})

test('on Linux staging hangs off the checkout owner, not the process', async () => {
  // This is the one that matters. The card pull runs as root from udev, where
  // homedir() is /root — so a homedir()-based default would put the user's
  // photos in /root/Pictures, owned by root, invisible to the Mac's rsync.
  // Resolving from the owner of the checkout gives the same answer as root and
  // as the user. (These tests run as the checkout's owner, so that's homedir().)
  const p = await resolveOn('linux', { CAMERA_STAGING_DIR: '', CAMERA_STATE_DIR: '', CAMERA_ARCHIVE_DIR: '' })
  assert.equal(p.isMac, false)
  const owner = statSync(fileURLToPath(new URL('..', import.meta.url))).uid
  if (owner === process.getuid()) {
    assert.equal(p.staging, `${homedir()}/Pictures/camera-inbox`)
    assert.equal(p.archive, `${homedir()}/Pictures/camera-archive`)
  }
  assert.ok(!p.staging.startsWith('/root/') || owner === 0)
  assert.equal(p.state, '/repo/data')
  assert.ok(p.roots.includes('/media'))
})

test('the environment wins on both platforms', async () => {
  for (const platform of ['darwin', 'linux']) {
    const p = await resolveOn(platform, {
      CAMERA_STAGING_DIR: '/tmp/stg',
      CAMERA_ARCHIVE_DIR: '/tmp/arc',
      CAMERA_STATE_DIR: '/tmp/state',
    })
    assert.equal(p.staging, '/tmp/stg', platform)
    assert.equal(p.archive, '/tmp/arc', platform)
    assert.equal(p.state, '/tmp/state', platform)
  }
})

test('the archive is always a sibling of staging, so the move is a rename', async () => {
  // ack.mjs relies on this: staging and archive on one filesystem means moving a
  // file is a rename rather than a copy-and-delete, which can't half-fail.
  const p = await resolveOn('darwin', { CAMERA_STAGING_DIR: '/mnt/photos/inbox', CAMERA_ARCHIVE_DIR: '' })
  assert.equal(p.archive, '/mnt/photos/camera-archive')
})
