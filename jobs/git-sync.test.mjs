import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanGitSync, hostScript, hostCommand, parseHostOutput, summarizeGitSync, syncHost } from './git-sync.mjs'

test('cleanGitSync keeps usable hosts and drops the rest', () => {
  const c = cleanGitSync({
    hosts: [
      { name: 'here' },
      { name: 'box', ssh: 'box', dir: '~/repo' },
      { name: 'evil', ssh: '-oProxyCommand=x', dir: '~/repo' },
      { name: 'nodir', ssh: 'box2' },
      { name: 'up', ssh: 'box3', dir: '~/../etc' },
      { name: 'here' },
    ],
    install: 'scripts/install.sh',
  })
  assert.deepEqual(c.hosts.map((h) => h.name), ['here', 'box'])
  assert.equal(c.install, 'scripts/install.sh')
  assert.equal(cleanGitSync({ hosts: [] }), null)
  assert.equal(cleanGitSync({ hosts: [{ name: 'a' }], install: '../x.sh' }).install, null)
})

test('hostScript refuses an option-like ref', () => {
  assert.throws(() => hostScript({ dir: '/r', ref: '--upload-pack=x', install: null }))
})

test('hostCommand sends one quoted script through ssh', () => {
  const [cmd, args] = hostCommand({ name: 'b', ssh: 'b', dir: '~/repo' }, { repo: '/x', ref: 'main', install: null })
  assert.equal(cmd, 'ssh')
  assert.equal(args.at(-2), 'b')
  assert.match(args.at(-1), /^bash -c '/)
})

test('parseHostOutput reads SHAs and installer lines', () => {
  const out = parseHostOutput([
    'before=aaaaaaaaaa', 'origin=bbbbbbbbbb', 'after=bbbbbbbbbb',
    "install: install-skills: linking 'icons'",
    "install: install-skills: relinking 'review' (was -> /old)",
    "install: install-skills: skipping 'synced' — /x exists and is not a symlink",
  ].join('\n'))
  assert.equal(out.after, 'bbbbbbbbbb')
  assert.deepEqual(out.linked, ['icons', 'review'])
  assert.deepEqual(out.skipped, ['synced'])
})

const ok = (name, before, after, extra = {}) => ({ name, ok: true, out: { before, origin: 'b'.repeat(40), after, linked: [], skipped: [], ...extra } })
const B = 'b'.repeat(40)

test('summarizeGitSync: quiet when everything is already current', () => {
  assert.equal(summarizeGitSync([ok('a', B, B), ok('b', B, B)]).status, 'skipped')
})

test('summarizeGitSync: ok when a host moved', () => {
  const s = summarizeGitSync([ok('a', 'a'.repeat(40), B), ok('b', B, B)])
  assert.equal(s.status, 'ok')
  assert.match(s.text, /a: aaaaaaa → bbbbbbb/)
})

test('summarizeGitSync: error on a failed host or a skipped skill', () => {
  assert.equal(summarizeGitSync([ok('a', B, B), { name: 'b', ok: false, error: 'ssh timed out' }]).status, 'error')
  assert.equal(summarizeGitSync([ok('a', B, B, { skipped: ['x'] })]).status, 'error')
})

test('the script fast-forwards a real checkout and runs the installer', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-sync-'))
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString().trim()
  const origin = join(root, 'origin')
  mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'main')
  mkdirSync(join(origin, 'scripts'))
  writeFileSync(join(origin, 'scripts', 'install.sh'), "echo \"install-skills: linking 'one'\"\necho \"install-skills: skipping 'two' — in the way\" >&2\n")
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'one')
  const clone = join(root, 'clone')
  git(root, 'clone', '-q', origin, clone)
  writeFileSync(join(origin, 'two'), 'x')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'two')
  const tip = git(origin, 'rev-parse', 'HEAD')
  const [cmd, args] = hostCommand({ name: 'here' }, { repo: clone, ref: 'main', install: 'scripts/install.sh' })
  const out = parseHostOutput(execFileSync(cmd, args).toString())
  assert.equal(out.after, tip)
  assert.notEqual(out.before, tip)
  assert.deepEqual(out.linked, ['one'])
  assert.deepEqual(out.skipped, ['two'])
})

test('syncHost reports a failing host instead of throwing', async () => {
  const r = await syncHost({ name: 'gone', dir: '/nonexistent/repo' }, { ref: 'main', install: null })
  assert.equal(r.ok, false)
  assert.match(r.error, /nonexistent/)
})
