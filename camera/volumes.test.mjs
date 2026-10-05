// Run with: node --test camera/
//
// On macOS this decides what counts as a camera, from a directory listing that
// also contains disk images, Time Machine, network shares and the boot volume.
// launchd starts it on *every* mount, so a wrong answer here is either "photos
// never sync" or "the Mac stalls for 30 seconds whenever you mount anything".
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findCameraVolumes, isSkippableVolume } from './volumes.mjs'

const SANDBOX = await mkdtemp(join(tmpdir(), 'camera-volumes-test-'))
after(async () => { await rm(SANDBOX, { recursive: true, force: true }) })

async function volumeRoot(name, layout) {
  const root = join(SANDBOX, name)
  for (const [path, isFile] of Object.entries(layout)) {
    const full = join(root, path)
    if (isFile) {
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, 'x')
    } else {
      await mkdir(full, { recursive: true })
    }
  }
  return root
}

test('finds the volume with a DCIM folder and ignores the rest', async () => {
  const root = await volumeRoot('r1', {
    'NO_NAME/DCIM/100OLYMP/P1010001.JPG': true,
    'BackupDrive/Documents/tax.pdf': true,
    'InstallerDMG/Applications': false,
  })
  const found = await findCameraVolumes([root])
  assert.deepEqual(found.map((f) => f.name), ['NO_NAME'])
  assert.equal(found[0].dcim, join(root, 'NO_NAME/DCIM'))
})

test('finds a lowercase dcim', async () => {
  const root = await volumeRoot('r2', { 'CARD/dcim/100OLYMP': false })
  const found = await findCameraVolumes([root])
  assert.deepEqual(found.map((f) => f.name), ['CARD'])
})

test('a DCIM nested deeper than the volume root is not a camera', async () => {
  // Someone's backup of a photo folder is not a card, and treating it as one
  // would pull a whole archive into Photos.
  const root = await volumeRoot('r3', { 'BackupDrive/Photos/DCIM/x': false })
  assert.deepEqual(await findCameraVolumes([root]), [])
})

test('skips the volumes macOS always has mounted', () => {
  for (const name of [
    'Macintosh HD', '.timemachine', 'Preboot', 'Recovery', 'VM', 'Data',
    'Time Machine Backups', 'backup.sparsebundle', '.DocumentRevisions-V100',
  ]) {
    assert.equal(isSkippableVolume(name), true, `${name} should be skipped`)
  }
})

test('does not skip the names a camera card actually gets', () => {
  // Cameras and readers produce these; a greedy skip pattern that swallowed one
  // would mean the sync silently never fires.
  for (const name of ['NO_NAME', 'Untitled', 'EOS_DIGITAL', 'OLYMPUS', 'SD Card', 'XZ-1']) {
    assert.equal(isSkippableVolume(name), false, `${name} should not be skipped`)
  }
})

test('a volume root that does not exist is not an error', async () => {
  // /media and /run/media do not both exist on any one Linux box, and neither
  // exists on a Mac.
  assert.deepEqual(await findCameraVolumes([join(SANDBOX, 'nope'), join(SANDBOX, 'also-nope')]), [])
})

test('the same volume reachable from two roots is reported once', async () => {
  const root = await volumeRoot('r4', { 'CARD/DCIM/100OLYMP': false })
  const found = await findCameraVolumes([root, root])
  assert.equal(found.length, 1)
})

test('a symlinked volume entry is still probed', async () => {
  // /Volumes represents some mounts as symlinks, so filtering on isDirectory()
  // alone would miss them.
  const root = await volumeRoot('r5', { 'placeholder': false })
  const real = await volumeRoot('r5-target', { 'CARD/DCIM/100OLYMP': false })
  await symlink(join(real, 'CARD'), join(root, 'LinkedCard'))
  const found = await findCameraVolumes([root])
  assert.deepEqual(found.map((f) => f.name), ['LinkedCard'])
})

test('several cards at once are all found', async () => {
  const root = await volumeRoot('r6', {
    'CARD_A/DCIM/100OLYMP': false,
    'CARD_B/DCIM/101OLYMP': false,
    'NotACamera/stuff': false,
  })
  const found = await findCameraVolumes([root])
  assert.deepEqual(found.map((f) => f.name).sort(), ['CARD_A', 'CARD_B'])
})
