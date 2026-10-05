// Run with: node --test notify/updates.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, parseVersion, decideUpdate, readInstalledVersion, proposalFor } from './updates.mjs'
import { DEFAULT_SOURCES } from './feed.mjs'

const claude = {
  id: 'claude-code',
  label: 'Claude Code',
  update: { installed: { kind: 'command', command: 'claude --version' }, command: 'claude update', channel: 'stable' },
}

test('versions sort numerically, not as strings', async () => {
  assert.ok(compareVersions('2.1.275', '2.1.9') > 0)
  assert.ok(compareVersions('0.0.42', '0.0.40') > 0)
  assert.equal(compareVersions('2.1.275', '2.1.275'), 0)
  // A prerelease is on the way to the release, not past it.
  assert.ok(compareVersions('0.0.43-nightly.20260917', '0.0.43') < 0)
  assert.ok(compareVersions('0.0.43-nightly.20260917', '0.0.42') > 0)
})

test('a version is pulled out of whatever the CLI prints around it', async () => {
  assert.equal(parseVersion('2.1.273 (Claude Code)'), '2.1.273')
  assert.equal(parseVersion('v0.0.42\n'), '0.0.42')
  assert.equal(parseVersion('command not found'), null)
})

test('being behind stages a proposal', async () => {
  const d = decideUpdate({ source: claude, released: '2.1.275', installed: '2.1.273' })
  assert.equal(d.action, 'stage')
})

test('being up to date stages nothing and closes anything open', async () => {
  assert.equal(decideUpdate({ source: claude, released: '2.1.275', installed: '2.1.275' }).action, 'none')
  // He ran the update himself. An inbox button offering to run it again is a
  // button that does nothing, and the inbox is meant to be trustworthy.
  const closing = decideUpdate({
    source: claude, released: '2.1.275', installed: '2.1.275', open: { id: 'P7', target: '2.1.275' },
  })
  assert.equal(closing.action, 'resolve')
  assert.equal(closing.id, 'P7')
})

test('a newer release supersedes the proposal already open for an older one', async () => {
  const d = decideUpdate({
    source: claude, released: '2.1.280', installed: '2.1.273', open: { id: 'P7', target: '2.1.275' },
  })
  assert.equal(d.action, 'restage')
  assert.equal(d.id, 'P7')
})

test('a proposal already targeting this release is reused, not duplicated', async () => {
  const d = decideUpdate({
    source: claude, released: '2.1.275', installed: '2.1.273', open: { id: 'P7', target: '2.1.275' },
  })
  assert.equal(d.action, 'reuse')
  assert.equal(d.id, 'P7')
})

test('a nightly install is never updated by the stable tag', async () => {
  // `t3 service update` writes the same systemd unit whichever channel it runs
  // from, so this would swap him off nightly without ever saying so.
  const t3 = { id: 't3-code', label: 'T3 Code', update: { command: 'npx -y t3@latest service update', channel: 'stable' } }
  const d = decideUpdate({ source: t3, released: '0.0.43', installed: '0.0.42-nightly.20260916' })
  assert.equal(d.action, 'none')
  assert.match(d.reason, /channel/)

  // And a proposal staged before he switched channels gets closed.
  const withOpen = decideUpdate({
    source: t3, released: '0.0.43', installed: '0.0.42-nightly.20260916', open: { id: 'P7', target: '0.0.43' },
  })
  assert.equal(withOpen.action, 'resolve')
})

test('an unreadable installed version proposes nothing rather than guessing', async () => {
  const d = decideUpdate({ source: claude, released: '2.1.275', installed: null })
  assert.equal(d.action, 'none')
  // And it leaves an open proposal alone: "I could not check" is not "you are
  // up to date".
  const withOpen = decideUpdate({ source: claude, released: '2.1.275', installed: null, open: { id: 'P7', target: '2.1.275' } })
  assert.equal(withOpen.action, 'none')
})

test('a source with no update command is never acted on', async () => {
  const hn = { id: 'hn-big', label: 'Hacker News' }
  assert.equal(decideUpdate({ source: hn, released: '1.0.0', installed: '0.9.0' }).action, 'none')
})

test('reading the installed version never throws', async () => {
  const boom = async () => { throw new Error('ENOENT') }
  assert.equal(await readInstalledVersion({ kind: 'command', command: 'claude --version' }, { exec: boom }), null)
  assert.equal(await readInstalledVersion({ kind: 'json', file: 'x.json', key: 'activeVersion' }, { readFile: boom }), null)
  assert.equal(await readInstalledVersion({ kind: 'invented' }, {}), null)

  assert.equal(
    await readInstalledVersion({ kind: 'command', command: 'x' }, { exec: async () => '2.1.273 (Claude Code)' }),
    '2.1.273',
  )
  assert.equal(
    await readInstalledVersion({ kind: 'json', file: 'x', key: 'activeVersion' }, { readFile: async () => '{"activeVersion":"0.0.42"}' }),
    '0.0.42',
  )
})

test('the proposal says what will run and why, in his words not a version number', async () => {
  const p = proposalFor(claude, { released: '2.1.275', installed: '2.1.273' })
  assert.equal(p.title, 'Update Claude Code to 2.1.275')
  assert.equal(p.command, 'claude update')
  assert.match(p.why, /2\.1\.273/)
  // The meta is how the next scan finds this proposal again.
  assert.deepEqual(p.meta, { update: 'claude-code', target: '2.1.275', from: '2.1.273' })
})

test('the shipped sources declare updates that match how they are installed', async () => {
  const byId = Object.fromEntries(DEFAULT_SOURCES.map((s) => [s.id, s]))
  // Claude Code is the native installer here, not a global npm package: `npm i -g`
  // would leave two copies and a symlink pointing at the old one.
  assert.equal(byId['claude-code'].update.command, 'claude update')
  assert.doesNotMatch(byId['claude-code'].update.command, /npm/)
  // T3 Code has no CLI on PATH, so its version comes from the service's own state.
  assert.equal(byId['t3-code'].update.installed.kind, 'json')
  // Both guard the channel, and every declared update explains itself.
  for (const source of DEFAULT_SOURCES.filter((s) => s.update)) {
    assert.equal(source.update.channel, 'stable', `${source.id} must declare its channel`)
    assert.ok(source.update.what.length > 20, `${source.id} must explain what it runs`)
  }
})
