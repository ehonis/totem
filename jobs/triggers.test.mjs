// Run with: node --test jobs/triggers.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeTrigger, describeTrigger, watchDue, checkWatch, describeChange } from './triggers.mjs'

const git = (repo, ref = 'main', everyMinutes = 2) => ({ type: 'watch', source: { kind: 'git', repo, ref }, everyMinutes })

test('normalizeTrigger keeps valid watches and turns anything else into "use the schedule"', () => {
  assert.equal(normalizeTrigger(null), null)
  assert.equal(normalizeTrigger({ type: 'schedule' }), null)
  assert.deepEqual(normalizeTrigger(git('https://github.com/o/r.git', 'refs/heads/main')), { type: 'watch', source: { kind: 'git', repo: 'https://github.com/o/r.git', ref: 'main' }, everyMinutes: 2 })
  assert.equal(normalizeTrigger(git('')), null)
  assert.equal(normalizeTrigger(git('relative/path')), null)
  assert.equal(normalizeTrigger({ type: 'watch', source: { kind: 'url', url: 'ftp://x' } }), null)
  assert.equal(normalizeTrigger({ type: 'watch', source: { kind: 'nope' } }), null)
})

test('a repo or ref that git would read as an option is refused', () => {
  assert.equal(normalizeTrigger(git('--upload-pack=touch /tmp/pwned')), null)
  assert.equal(normalizeTrigger(git('/srv/repo', '--output=/tmp/x')).source.ref, 'main')
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
  const seen = await checkWatch(git(dir), { exec })
  assert.deepEqual(seen, { fingerprint: 'abc1234def5678abc1234def5678abc1234def56', label: 'abc1234' })
  assert.equal(calls[0].cmd, 'git')
  assert.deepEqual(calls[0].args.slice(0, 2), ['-C', dir])
  assert.ok(calls[0].args.includes('origin'))
  assert.ok(calls[0].args.includes('protocol.ext.allow=never'))
  assert.equal(calls[0].opts.env.GIT_TERMINAL_PROMPT, '0')
})

test('a missing branch or a path that is not a checkout is a readable error', async () => {
  await assert.rejects(checkWatch(git('https://github.com/o/r.git', 'gone'), { exec: async () => '' }), /no branch "gone"/)
  await assert.rejects(checkWatch(git('/definitely/not/here'), { exec: async () => '' }), /not a git checkout/)
})

test('a page watch with `contains` fingerprints presence, ignoring markup and scripts', async () => {
  const page = (html) => async () => ({ ok: true, status: 200, text: async () => html })
  const t = { type: 'watch', source: { kind: 'url', url: 'https://shop.example/p', contains: 'in stock' } }
  assert.equal((await checkWatch(t, { fetch: page('<p>Sold <b>out</b></p><script>var s="In stock"</script>') })).fingerprint, 'absent')
  const now = await checkWatch(t, { fetch: page('<p>In   <b>Stock</b> now</p>') })
  assert.equal(now.fingerprint, 'present')
  assert.equal(now.label, 'shows “in stock”')
  await assert.rejects(checkWatch(t, { fetch: async () => ({ ok: false, status: 503 }) }), /HTTP 503/)
})

test('a page watch without `contains` changes only when visible text does', async () => {
  const t = { type: 'watch', source: { kind: 'url', url: 'https://a.example/' } }
  const at = (html) => checkWatch(t, { fetch: async () => ({ ok: true, status: 200, text: async () => html }) })
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
  const text = await describeChange(git(dir), { fingerprint: 'abc1234', label: 'abc1234' }, { fingerprint: 'def5678', label: 'def5678' }, { exec })
  assert.match(text, /^main in .* moved from abc1234 to def5678\./)
  assert.match(text, /New commits:\ndef5678 Add triggers/)
})
