// Run with: node --test jobs/triggers.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeTrigger, isCompleteTrigger, describeTrigger, watchDue, checkWatch, checkSource, describeChange, describeChanges, cleanWatchState, sourceKey } from './triggers.mjs'

const git = (repo, ref = 'main', everyMinutes = 2) => ({ type: 'watch', source: { kind: 'git', repo, ref }, everyMinutes })

test('normalizeTrigger keeps valid watches and turns anything else into "use the schedule"', () => {
  assert.equal(normalizeTrigger(null), null)
  assert.equal(normalizeTrigger({ type: 'schedule' }), null)
  assert.deepEqual(normalizeTrigger(git('https://github.com/o/r.git', 'refs/heads/main')), { type: 'watch', sources: [{ kind: 'git', repo: 'https://github.com/o/r.git', ref: 'main' }], everyMinutes: 2 })
  assert.equal(normalizeTrigger(git('')), null)
  assert.equal(normalizeTrigger(git('relative/path')), null)
  assert.equal(normalizeTrigger({ type: 'watch', source: { kind: 'url', url: 'ftp://x' } }), null)
  assert.equal(normalizeTrigger({ type: 'watch', source: { kind: 'nope' } }), null)
})

test('a repo or ref that git would read as an option is refused', () => {
  assert.equal(normalizeTrigger(git('--upload-pack=touch /tmp/pwned')), null)
  assert.equal(normalizeTrigger(git('/srv/repo', '--output=/tmp/x')).sources[0].ref, 'main')
})

test('check intervals are clamped per source', () => {
  assert.equal(normalizeTrigger(git('/srv/repo', 'main', 0)).everyMinutes, 1)
  assert.equal(normalizeTrigger({ type: 'watch', source: { kind: 'url', url: 'https://a.example/x' }, everyMinutes: 1 }).everyMinutes, 5)
  assert.equal(normalizeTrigger({ type: 'watch', source: { kind: 'url', url: 'https://a.example/x' }, everyMinutes: 99999 }).everyMinutes, 1440)
  assert.equal(normalizeTrigger({ type: 'watch', source: { kind: 'url', url: 'https://a.example/x' } }).everyMinutes, 5)
})

test('describeTrigger reads like a schedule label', () => {
  assert.equal(describeTrigger(git('https://github.com/o/r.git')), 'When main changes in o/r (checked every 2 minutes)')
  assert.equal(
    describeTrigger({ type: 'watch', source: { kind: 'url', url: 'https://www.shop.example/p', contains: 'In stock' }, everyMinutes: 60 }),
    'When shop.example starts or stops showing “In stock” (checked every hour)',
  )
})

test('watchDue: never checked is due; then only after the interval', () => {
  const t = git('/srv/repo', 'main', 5)
  assert.equal(watchDue(t, null, 1000), true)
  assert.equal(watchDue(t, { checkedAt: 0 }, 4 * 60_000), false)
  assert.equal(watchDue(t, { checkedAt: 0 }, 5 * 60_000), true)
  assert.equal(watchDue(null, null, 0), false)
})

test('a git watch on a local checkout asks its origin, without a shell or prompts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-watch-'))
  await mkdir(join(dir, '.git'))
  const calls = []
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return 'abc1234def5678abc1234def5678abc1234def56\trefs/heads/main\n'
  }
  const [seen] = await checkWatch(git(dir), { exec })
  assert.deepEqual({ fingerprint: seen.fingerprint, label: seen.label }, { fingerprint: 'abc1234def5678abc1234def5678abc1234def56', label: 'abc1234' })
  assert.equal(calls[0].cmd, 'git')
  assert.deepEqual(calls[0].args.slice(0, 2), ['-C', dir])
  assert.ok(calls[0].args.includes('origin'))
  assert.ok(calls[0].args.includes('protocol.ext.allow=never'))
  assert.equal(calls[0].opts.env.GIT_TERMINAL_PROMPT, '0')
})

test('a missing branch or a path that is not a checkout is a readable error', async () => {
  await assert.rejects(checkSource({ kind: 'git', repo: 'https://github.com/o/r.git', ref: 'gone' }, { exec: async () => '' }), /no branch "gone"/)
  const [r] = await checkWatch(git('/definitely/not/here'), { exec: async () => '' })
  assert.match(r.error, /not a git checkout/)
})

test('a page watch with `contains` fingerprints presence, ignoring markup and scripts', async () => {
  const page = (html) => async () => ({ ok: true, status: 200, text: async () => html })
  const t = { kind: 'url', url: 'https://shop.example/p', contains: 'in stock' }
  assert.equal((await checkSource(t, { fetch: page('<p>Sold <b>out</b></p><script>var s="In stock"</script>') })).fingerprint, 'absent')
  const now = await checkSource(t, { fetch: page('<p>In   <b>Stock</b> now</p>') })
  assert.equal(now.fingerprint, 'present')
  assert.equal(now.label, 'shows “in stock”')
  await assert.rejects(checkSource(t, { fetch: async () => ({ ok: false, status: 503 }) }), /HTTP 503/)
})

test('a page watch without `contains` changes only when visible text does', async () => {
  const t = { kind: 'url', url: 'https://a.example/' }
  const at = (html) => checkSource(t, { fetch: async () => ({ ok: true, status: 200, text: async () => html }) })
  const a = await at('<p>Hello</p><script>Date.now()</script>')
  const b = await at('<div>Hello</div><script>somethingElse()</script>')
  const c = await at('<p>Hello there</p>')
  assert.equal(a.fingerprint, b.fingerprint)
  assert.notEqual(a.fingerprint, c.fingerprint)
})

test('describeChange lists the new commits for a local checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-watch-'))
  await mkdir(join(dir, '.git'))
  const exec = async (cmd, args) => (args.includes('log') ? 'def5678 Add triggers\n' : '')
  const text = await describeChange({ kind: 'git', repo: dir, ref: 'main' }, { fingerprint: 'abc1234', label: 'abc1234' }, { fingerprint: 'def5678', label: 'def5678' }, { exec })
  assert.match(text, /^main in .* moved from abc1234 to def5678\./)
  assert.match(text, /New commits:\ndef5678 Add triggers/)
})

// --- several sources ---------------------------------------------------------

const many = (...repos) => ({ type: 'watch', sources: repos.map((repo) => ({ kind: 'git', repo, ref: 'main' })), everyMinutes: 3 })

test('a watch lists several sources, merges duplicates and drops unusable ones', () => {
  const t = normalizeTrigger({ type: 'watch', everyMinutes: 3, sources: [
    { kind: 'git', repo: 'https://github.com/o/a.git', ref: 'main' },
    { kind: 'git', repo: 'https://github.com/o/a.git', ref: 'refs/heads/main' },
    { kind: 'git', repo: 'relative/nope', ref: 'main' },
    { kind: 'url', url: 'https://shop.example/p' },
  ] })
  assert.deepEqual(t.sources.map(sourceKey), ['git https://github.com/o/a.git main', 'url https://shop.example/p'])
  assert.equal(t.everyMinutes, 5, 'a page in the list raises the minimum')
  assert.equal(isCompleteTrigger({ type: 'watch', sources: [{ kind: 'git', repo: '/srv/a' }, { kind: 'git', repo: '' }] }), false)
  assert.equal(isCompleteTrigger(many('/srv/a', '/srv/b')), true)
  assert.equal(isCompleteTrigger(git('/srv/a')), true, 'the old single-source shape still saves')
})

test('describeTrigger names every source of a short list and counts a long one', () => {
  assert.equal(describeTrigger(many('https://github.com/o/a', 'https://github.com/o/b')), 'When main in o/a or main in o/b changes (checked every 3 minutes)')
  assert.match(describeTrigger(many('/srv/a', '/srv/b', '/srv/c', '/srv/d', '/srv/e')), /main in \/srv\/a, main in \/srv\/b, main in \/srv\/c and 2 more changes/)
})

test('checkWatch checks every source, and one unreadable source does not stop the rest', async () => {
  const exec = async (cmd, args) => (args.includes('https://github.com/o/a.git') ? 'aaaaaaa1111111\trefs/heads/main\n' : '')
  const results = await checkWatch(many('https://github.com/o/a.git', 'https://github.com/o/b.git'), { exec })
  assert.equal(results[0].fingerprint, 'aaaaaaa1111111')
  assert.match(results[1].error, /^main in o\/b: no branch "main"/)
})

test('describeChanges puts every change of one check into one event', async () => {
  const a = { kind: 'git', repo: 'https://github.com/o/a', ref: 'main' }
  const b = { kind: 'git', repo: 'https://github.com/o/b', ref: 'main' }
  const text = await describeChanges([
    { source: a, before: { fingerprint: '1', label: 'aaa1111' }, after: { fingerprint: '2', label: 'aaa2222' } },
    { source: b, before: { fingerprint: '3', label: 'bbb1111' }, after: { fingerprint: '4', label: 'bbb2222' } },
  ])
  assert.equal(text, 'main in o/a moved from aaa1111 to aaa2222.\n\nmain in o/b moved from bbb1111 to bbb2222.')
})

test('cleanWatchState reads a single-source record as that source\'s baseline and drops sources no longer watched', () => {
  const t = many('/srv/a', '/srv/b')
  const old = cleanWatchState({ fingerprint: 'f1', label: 'f1', checkedAt: 5 }, t)
  assert.deepEqual(old.seen, { 'git /srv/a main': { fingerprint: 'f1', label: 'f1' } })
  const pruned = cleanWatchState({ seen: { 'git /srv/a main': { fingerprint: 'x', label: 'x' }, 'git /srv/gone main': { fingerprint: 'y', label: 'y' } } }, t)
  assert.deepEqual(Object.keys(pruned.seen), ['git /srv/a main'])
})
