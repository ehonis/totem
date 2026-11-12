import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, realpath, writeFile, symlink, readFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createChangeFlow, execRunner, planWorktree, classifyPath, refusedPaths, guardedLines, changeDenyRules, foldPath,
  summarizeChecks, prCard, changeWarnings, isInside, scriptsChanged, scanFiles, changedLines, gitignoreLines, newlyDirty,
  BRANCH_PREFIX, CHANGE_TOOL_DESCRIPTORS, CHANGE_TOOL_NAMES, ABANDONED_MS, collectSecrets, checkEnv, MAX_FILES, changeFlowEnabled,
} from './change.mjs'
import { normalizePart } from '../chat/store.mjs'
import { applyEvent } from '../chat/turn.mjs'

// Real git, isolated from the machine's own config; never a remote.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
})
const gitSync = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
const PR_URL = 'https://github.com/owner/totem/pull/42'
const SECRET = 'bridge-secret-value-0123456789abcdef'

// A live checkout with a few of Totem's real paths, committed.
async function makeLive(tmp) {
  const live = join(tmp, 'live')
  const files = {
    '.gitignore': 'node_modules\ndata/\n',
    'bridge.mjs': "const port = 8787\nconst ownerAuth = createOwnerAuth()\n",
    'auth/owner.mjs': 'export const x = 1\n',
    'web/src/x.tsx': 'export const X = 1\n',
    'package.json': JSON.stringify({ name: 't', scripts: { test: 'node --test' }, dependencies: {} }, null, 2),
    'web/package.json': JSON.stringify({ name: 'w', scripts: { build: 'vite build' } }, null, 2),
    'AGENTS.md': '# rules\n',
  }
  for (const [p, text] of Object.entries(files)) {
    await mkdir(join(live, p, '..'), { recursive: true })
    await writeFile(join(live, p), text)
  }
  await mkdir(join(live, 'node_modules'), { recursive: true })
  await mkdir(join(live, 'web', 'node_modules'), { recursive: true })
  await mkdir(join(live, 'data'), { recursive: true })
  await writeFile(join(live, 'data', 'auth.json'), JSON.stringify({ key: SECRET }))
  gitSync(tmp, 'init', '-q', '-b', 'main', live)
  gitSync(live, 'remote', 'add', 'origin', 'git@example.invalid:owner/totem.git')
  gitSync(live, 'add', '-A')
  gitSync(live, 'commit', '-q', '-m', 'base')
  return live
}

async function setup(t, { state: extra = {}, worktreeRoot, secrets, flow: flowOptions = {} } = {}) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'change-test-')))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const live = await makeLive(tmp)
  // remote: what GitHub holds per branch (pushes land here); prHead: the branch the PR is on.
  const state = { pushed: [], remote: {}, prState: 'OPEN', prHead: null, checks: [{ name: 'ci', state: 'IN_PROGRESS', bucket: 'pending' }], ...extra }
  const real = execRunner()
  const calls = []
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts })
    if (cmd === 'git') {
      const at = args.indexOf('-C')
      const dir = args[at + 1]
      const sub = args[at + 2]
      if (sub === 'push') {
        const [sha, ref] = args.at(-1).split(':')
        state.pushed.push(args.at(-1))
        state.remote[ref] = sha
        return ok()
      }
      if (sub === 'ls-remote') {
        if (state.offline) return { code: 128, stdout: '', stderr: 'Could not resolve host' }
        const ref = args.at(-1)
        return ok(state.remote[ref] ? `${state.remote[ref]}\t${ref}\n` : '')
      }
      if (sub === 'fetch') { gitSync(dir, 'update-ref', 'refs/totem-change/base', 'main'); return ok() }
      return real(cmd, args, opts)
    }
    if (cmd === 'nice') return state.npm ? state.npm(args, opts) : ok('all tests ok')
    if (cmd === 'gh') {
      const [, verb, what] = args
      if (verb === 'view' && /^\d+$/.test(what)) return state.prState ? ok(JSON.stringify({ state: state.prState, headRefName: state.prHead })) : { code: 1, stdout: '', stderr: 'could not connect to api.github.com' }
      if (verb === 'view') { state.prHead ??= what; return state.existing ? ok(`${state.existing}\n`) : { code: 1, stdout: '', stderr: 'no pull requests found' } }
      if (verb === 'create') {
        state.prHead ??= args[args.indexOf('--head') + 1]
        return state.createFails ? { code: 1, stdout: '', stderr: 'a pull request for branch already exists' } : ok(`${PR_URL}\n`)
      }
      if (verb === 'checks') return ok(JSON.stringify(state.checks))
    }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`)
  }
  const flow = createChangeFlow({
    liveRoot: live, agentCwd: live, cwd: live,
    worktreeRoot: worktreeRoot?.(tmp, live) ?? join(tmp, 'changes'),
    recordsFile: join(tmp, 'records.json'),
    run, skillText: async () => 'the steps', secrets: secrets || (async () => [SECRET]), randomId: () => 'abc123', sleep: async () => {},
    ...flowOptions,
  })
  return { tmp, live, state, flow, calls }
}

const gitCalls = (calls, sub) => calls.filter((c) => c.cmd === 'git' && c.args[c.args.indexOf('-C') + 2] === sub)
const ghCalls = (calls, verb) => calls.filter((c) => c.cmd === 'gh' && c.args[1] === verb)
const edit = (dir, p, text) => mkdir(join(dir, p, '..'), { recursive: true }).then(() => writeFile(join(dir, p), text))

// --- 1: the runner -------------------------------------------------------------

test('a command that exits before reading its input does not crash the process (EPIPE)', async () => {
  const run = execRunner()
  for (let i = 0; i < 5; i++) {
    const r = await run('true', [], { input: 'x'.repeat(4_000_000) })
    assert.equal(r.code, 0)
  }
})

test('a timeout or a stop kills the whole tree, grandchildren included', async () => {
  const run = execRunner()
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  const t0 = Date.now()
  const r = await run('sh', ['-c', 'sleep 30 & echo $!; wait'], { timeout: 400 })
  assert.ok(Date.now() - t0 < 8000, 'settles soon after the timeout')
  assert.notEqual(r.code, 0)
  const grandchild = Number(r.stdout.trim())
  assert.ok(grandchild > 0)
  await new Promise((res) => setTimeout(res, 200))
  assert.equal(alive(grandchild), false, 'the sleep under sh is gone')

  const stop = new AbortController()
  const p = run('sh', ['-c', 'sleep 30 & echo $!; wait'], { timeout: 60_000, signal: stop.signal })
  setTimeout(() => stop.abort(), 300)
  const s = await p
  assert.equal(s.stopped, true)
  await new Promise((res) => setTimeout(res, 200))
  assert.equal(alive(Number(s.stdout.trim())), false)
})

// --- 7: where the worktree goes --------------------------------------------------

test('the worktree is never the bridge cwd, the live checkout or anything around them', () => {
  const live = '/srv/apps/totem'
  assert.throws(() => planWorktree({ root: live, live: [live], slug: 'x', id: '1' }), /Refusing/)
  assert.throws(() => planWorktree({ root: join(live, '.worktrees'), live: [live], slug: 'x', id: '1' }), /Refusing/)
  assert.throws(() => planWorktree({ root: '/srv', live: [live], slug: 'apps', id: 'x' }), /Refusing/, 'a root holding the checkout')
  assert.throws(() => planWorktree({ root: '/home/me', live: [live], others: ['/home/me/agent'], slug: 'x', id: '1' }), /Refusing/, 'a root holding AGENT_CWD')
  assert.throws(() => planWorktree({ root: '/home/me', live: [live], others: ['/home/me/x-1'], slug: 'x', id: '1' }), /Refusing/, 'the worktree is AGENT_CWD')
  assert.doesNotThrow(() => planWorktree({ root: '/home/me/.totem-changes', live: [live], others: ['/home/me'], slug: 'x', id: '1' }), 'an AGENT_CWD of the home folder is fine')
  assert.throws(() => planWorktree({ root: 'changes', live: [live], slug: 'x', id: '1' }), /absolute/)
  const ok = planWorktree({ root: '/srv/totem-changes', live: [live, live], slug: 'reading-page', id: 'abc' })
  assert.equal(ok.path, '/srv/totem-changes/reading-page-abc')
  assert.equal(ok.branch, `${BRANCH_PREFIX}reading-page-abc`)
  assert.equal(isInside(ok.path, live), false)
})

test('start refuses a worktree folder inside the live checkout without creating it or touching git', async (t) => {
  const { flow, calls, live } = await setup(t, { worktreeRoot: (_tmp, l) => join(l, '.worktrees', 'deeper') })
  await assert.rejects(flow.start('t1', { name: 'reading page' }), /Refusing: the change worktree .* live checkout dirty/)
  assert.equal(existsSync(join(live, '.worktrees')), false, 'nothing made inside the live checkout')
  assert.equal(gitCalls(calls, 'worktree').length, 0)
  assert.equal(gitCalls(calls, 'fetch').length, 0)
  assert.equal(gitSync(live, 'status', '--porcelain'), '')
})

test('start makes a worktree off origin/main outside the checkout, without moving origin/main, and resumes it', async (t) => {
  const { flow, calls, live, tmp } = await setup(t)
  const r = await flow.start('t1', { name: 'Reading page!' })
  assert.equal(r.branch, 'totem-change/reading-page-abc123')
  assert.equal(r.path, join(tmp, 'changes', 'reading-page-abc123'))
  assert.equal(isInside(r.path, live), false)
  assert.equal(r.steps, 'the steps')
  const fetch = gitCalls(calls, 'fetch')[0].args
  assert.equal(fetch.at(-1), '+refs/heads/main:refs/totem-change/base', 'fetches into its own ref, not refs/remotes/origin/main')
  assert.ok(fetch.includes('--no-optional-locks') && fetch.includes('core.hooksPath=/dev/null'))
  assert.equal(existsSync(join(r.path, 'node_modules')), true)
  const again = await flow.start('t1', { name: 'other' })
  assert.equal(again.resumed, true)
  assert.equal(again.path, r.path)
  assert.equal(gitCalls(calls, 'worktree').length, 1)
})

test('two starts racing in one chat make one worktree', async (t) => {
  const { flow, calls } = await setup(t)
  const [a, b] = await Promise.all([flow.start('t1', { name: 'x' }), flow.start('t1', { name: 'x' })])
  assert.equal(a.path, b.path)
  assert.equal(gitCalls(calls, 'worktree').filter((c) => c.args.includes('add')).length, 1)
})

test('a start that fails after creating the worktree removes it and its branch', async (t) => {
  const { flow, live, tmp } = await setup(t)
  // An ignore that only matches directories: the node_modules symlink would be committed.
  await writeFile(join(live, '.gitignore'), 'node_modules/\ndata/\n')
  gitSync(live, 'commit', '-qam', 'slash')
  await assert.rejects(flow.start('t1', { name: 'x' }), /not ignored/)
  assert.equal(existsSync(join(tmp, 'changes', 'x-abc123')), false)
  assert.equal(gitSync(live, 'branch', '--list', 'totem-change/*'), '')
  assert.deepEqual(await flow.records(), {})
})

// --- 3: paths, case-folded -------------------------------------------------------

test('denied and protected paths are caught whatever their case or Unicode form', () => {
  for (const p of ['data/todos.db', 'Data/x', 'DATA', '.env', '.ENV', '.env.local', 'web/.env', 'secrets/key.pem', 'Secrets/k', '.git/hooks/pre-commit', 'web/.GIT/config', 'node_modules', 'web/Node_Modules']) {
    assert.equal(classifyPath(p)?.kind, 'denied', p)
  }
  for (const p of ['auth/owner.mjs', 'Auth/owner.mjs', 'logs/approvals.mjs', 'LOGS/Approval-controller.mjs', '.github/workflows/ci.yml', '.GITHUB/workflows/deploy.yml', 'dev/change.mjs', 'dev/Change.mjs', 'skills/seeds/change-totem/SKILL.md', 'providers/instances.mjs', 'providers/claude-tools.mjs', 'chat/approvals.mjs', 'gmail/index.mjs', 'chat/reach.mjs', 'mcp-gateway.mjs', 'scripts/service-manager.mjs', 'terminal/sessions.mjs', 'goals/http.mjs', 'scripts/start.mjs']) {
    assert.equal(classifyPath(p)?.kind, 'protected', p)
  }
  for (const p of ['.env.example', 'web/src/data.ts', 'logs/runs.mjs', 'dev/github.mjs', 'bridge.mjs', 'docs/auth.md', 'AGENTS.md']) {
    assert.equal(classifyPath(p), null, p)
  }
  assert.equal(foldPath('Dev/Café.mjs'), 'dev/café.mjs', 'NFC and lower case')
  assert.deepEqual(refusedPaths(['web/src/a.tsx', 'Auth/http.mjs']).map((r) => r.path), ['Auth/http.mjs'])
})

test('finish refuses a file whose name differs from another only in case', async (t) => {
  const { flow, state } = await setup(t)
  const { path } = await flow.start('t1', { name: 'x' })
  await edit(path, 'Bridge.mjs', 'const evil = 1\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /Bridge\.mjs \(a second file whose name differs only in case/)
  assert.deepEqual(state.pushed, [])
})

test('bridge.mjs lines touching approvals, auth, agent reach or this flow are caught', () => {
  const diff = [
    'diff --git a/bridge.mjs b/bridge.mjs', '--- a/bridge.mjs', '+++ b/bridge.mjs', '@@ -10 +10,8 @@',
    "+      if (req.method === 'GET' && path === '/api/reading') {",
    "-      if (req.method === 'POST' && path === '/api/approvals/approve') {",
    "+  if (item.approvedVia !== 'dashboard') return",
    '+  const x = changeFlow.finish',
    '+  browserAccess = grantChatAccess(threadId, push, {})',
    '+  if (CHANGE_FLOW_ENABLED) changeTools.x = 1',
    "+  if (req.method === 'POST' && path === '/api/chat/approvals') return approvalWaits.decide(id, 'accept')",
    '+        return permissionResult(request, { decision: "accept" })',
  ].join('\n')
  const hits = guardedLines(diff)
  assert.equal(hits.length, 7)
  assert.ok(!hits.some((l) => l.includes('/api/reading')))
})

// --- 2: symlinks -----------------------------------------------------------------

test('finish refuses a symlink, such as a public file pointing at data/auth.json', async (t) => {
  const { flow, state, calls, live } = await setup(t)
  const { path } = await flow.start('t1', { name: 'x' })
  await mkdir(join(path, 'web', 'public'), { recursive: true })
  await symlink(join(live, 'data', 'auth.json'), join(path, 'web', 'public', 'brand.json'))
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /web\/public\/brand\.json \(a symlink\)/)
  assert.deepEqual(state.pushed, [])
  assert.equal(ghCalls(calls, 'create').length, 0)
})

// --- 4: history -------------------------------------------------------------------

test('only a fresh commit of the checked tree is pushed, never the agent\'s own history', async (t) => {
  const { flow, state, live } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  // A guarded file and a secret committed, then reverted, then an ordinary change.
  await edit(r.path, 'auth/owner.mjs', 'export const x = 2 // weakened\n')
  await edit(r.path, 'web/src/leak.ts', `export const k = '${SECRET}'\n`)
  gitSync(r.path, 'add', '-A'); gitSync(r.path, 'commit', '-qm', 'oops')
  const bad = gitSync(r.path, 'rev-parse', 'HEAD')
  gitSync(r.path, 'checkout', '-q', r.base, '--', 'auth/owner.mjs'); gitSync(r.path, 'rm', '-q', 'web/src/leak.ts'); gitSync(r.path, 'commit', '-qm', 'revert')
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')

  const card = await flow.finish('t1', { title: 'Reading list page', summary: 'Adds a page.' })
  assert.equal(state.pushed.length, 1)
  const [sha, ref] = state.pushed[0].split(':')
  assert.equal(ref, `refs/heads/${r.branch}`)
  assert.equal(sha, card.head, 'the exact commit, not HEAD')
  assert.equal(gitSync(live, 'rev-list', '--count', `${r.base}..${sha}`), '1', 'one commit on the base')
  assert.throws(() => gitSync(live, 'merge-base', '--is-ancestor', bad, sha), 'the reverted commit is not in what was pushed')
  assert.deepEqual(gitSync(live, 'diff', '--name-only', r.base, sha).split('\n'), ['web/src/x.tsx'])
})

test('a follow-up is one more commit on top of the last push', async (t) => {
  const { flow, state, live } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  const first = await flow.finish('t1', { title: 'T', summary: 'S' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 3\n')
  const second = await flow.finish('t1', { title: 'T', summary: 'S' })
  assert.equal(gitSync(live, 'rev-parse', `${second.head}^`), first.head)
  assert.equal(state.pushed.length, 2)
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /Nothing changed since the last update/)
})

// --- 5: the checks run the change's code ---------------------------------------------

test('tests that move HEAD or write tracked files stop the push', async (t) => {
  const { flow, state } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  state.npm = async (args, opts) => { if (args.includes('test')) gitSync(opts.cwd, 'commit', '-q', '--allow-empty', '-m', 'sneaky'); return ok() }
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /HEAD moved/)
  state.npm = async (args, opts) => { if (args.includes('build')) await writeFile(join(r.path, 'web/src/x.tsx'), 'export const X = 666\n'); return ok() }
  gitSync(r.path, 'reset', '-q', '--hard', 'HEAD~1')
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /changed the worktree \(web\/src\/x\.tsx/)
  assert.deepEqual(state.pushed, [])
})

test('a failing test run pushes nothing; one flaky failure is retried and flagged', async (t) => {
  const { flow, state } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  state.npm = async () => ({ code: 1, stdout: 'not ok 3 - reading list', stderr: '' })
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /npm test failed[\s\S]*not ok 3/)
  assert.deepEqual(state.pushed, [])
  let runs = 0
  state.npm = async (args) => (args.includes('test') && runs++ === 0 ? { code: 1, stdout: 'flake', stderr: '' } : ok())
  const card = await flow.finish('t1', { title: 'T', summary: 'S' })
  assert.ok(card.warnings.some((w) => /retry/.test(w)))
})

// --- 6: Stop ------------------------------------------------------------------------

test('Stop during the tests ends finish with no push and no PR', async (t) => {
  const { flow, state, calls } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  const stop = new AbortController()
  state.npm = (_args, opts) => new Promise((res) => {
    setTimeout(() => stop.abort(), 20)
    opts.signal.addEventListener('abort', () => res({ code: 1, stdout: '', stderr: 'stopped', stopped: true }), { once: true })
  })
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }, { signal: stop.signal }), /Stopped/)
  assert.deepEqual(state.pushed, [])
  assert.equal(ghCalls(calls, 'create').length, 0)
})

test('Stop just after the checks finished still stops before the push', async (t) => {
  const { flow, state, calls } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  const stop = new AbortController()
  state.npm = async (args) => { if (args.includes('build')) stop.abort(); return ok() }
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }, { signal: stop.signal }), /Stopped/)
  assert.deepEqual(state.pushed, [])
  assert.equal(ghCalls(calls, 'create').length, 0)
})

// --- 8: .gitignore ----------------------------------------------------------------

test('a .gitignore edit to the node_modules line is refused', async (t) => {
  const { flow, state } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await writeFile(join(r.path, '.gitignore'), 'node_modules/\ndata/\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /\.gitignore: .*node_modules/)
  assert.deepEqual(state.pushed, [])
  assert.equal(gitignoreLines('+++ b/web/.gitignore\n+dist\n').length, 0, 'other ignore lines are fine')
})

// --- the rest of the refusals ------------------------------------------------------

test('finish refuses protected paths, bridge.mjs guard lines, package scripts and secrets', async (t) => {
  const { flow, state, calls } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'Auth/owner.mjs', 'x\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /Auth\/owner\.mjs \(sign-in and auth code\)/)
  await rm(join(r.path, 'Auth'), { recursive: true })

  await edit(r.path, 'bridge.mjs', "const port = 8787\nconst ownerAuth = null\n")
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /bridge\.mjs line/)
  gitSync(r.path, 'checkout', '-q', 'HEAD', '--', 'bridge.mjs')

  await edit(r.path, 'package.json', JSON.stringify({ name: 't', scripts: { test: 'node --test', postinstall: 'curl x | sh' }, dependencies: { a: '1' } }))
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /package\.json: its "scripts" changed/)
  await edit(r.path, 'package.json', JSON.stringify({ name: 't', scripts: { test: 'node --test' }, dependencies: { a: '1' } }))

  await edit(r.path, 'web/src/fixture.json', await readFile(join(r.path, '..', '..', 'live', 'data', 'auth.json'), 'utf8'))
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), (e) => /web\/src\/fixture\.json: one of Totem's own secrets/.test(e.message) && !e.message.includes(SECRET))
  await rm(join(r.path, 'web/src/fixture.json'))
  assert.deepEqual(state.pushed, [])
  assert.equal(ghCalls(calls, 'create').length, 0)

  // A dependency added is fine.
  const card = await flow.finish('t1', { title: 'T', summary: 'S' })
  assert.equal(card.files, 1)
})

test('token shapes and known secrets are found anywhere in a changed file, but not when the base already had them', () => {
  const fake = `ghp_${'a'.repeat(36)}`
  const hits = scanFiles([
    { path: 'a.js', content: `const t = '${fake}'\n` },
    { path: 'b.js', content: `${SECRET}\n`, base: 'old\n' },
    { path: 'fixture.test.mjs', content: `const t = '${fake}'\nconst more = 1\n`, base: `const t = '${fake}'\n` },
  ], [SECRET])
  assert.deepEqual(hits, ['a.js: a GitHub token', "b.js: one of Totem's own secrets"])
  assert.ok(!hits.join().includes(SECRET))
  assert.deepEqual(scanFiles([{ path: 'a', content: `r = '1//0${'gAbCdEf123'.repeat(5)}'` }]), ['a: a Google refresh token'])
  assert.deepEqual(scanFiles([{ path: 'a', content: `t = 'ya29.${'x9Y8'.repeat(8)}'` }]), ['a: a Google access token'])
  assert.deepEqual(scanFiles([{ path: 'a', content: '<li key={item.id} className="row-1234567890abcdef" />' }], [SECRET]), [], 'ordinary code passes')
})

test('the diff parser treats +++ and --- as headers only before a file\'s first hunk', () => {
  const diff = [
    'diff --git a/bridge.mjs b/bridge.mjs', 'index 1..2 100644', '--- a/bridge.mjs', '+++ b/bridge.mjs',
    '@@ -1,0 +2 @@', '+++ x, ownerAuth.verifySession = () => ({ ok: true })', '--- y',
    'diff --git a/docs/x.md b/docs/x.md', '--- a/docs/x.md', '+++ b/docs/x.md', '@@ -3 +3 @@', '-old', '+new',
  ].join('\n')
  assert.deepEqual(changedLines(diff).map((l) => [l.file, l.text]), [
    ['bridge.mjs', '+++ x, ownerAuth.verifySession = () => ({ ok: true })'], ['bridge.mjs', '--- y'], ['docs/x.md', '-old'], ['docs/x.md', '+new'],
  ])
  assert.equal(guardedLines(diff).length, 1)
})

test('package scripts compare by value', () => {
  assert.equal(scriptsChanged('{"scripts":{"a":"b"}}', '{"dependencies":{"x":"1"},"scripts":{"a":"b"}}'), false)
  assert.equal(scriptsChanged('{"scripts":{"a":"b"}}', '{"scripts":{"a":"c"}}'), true)
  assert.equal(scriptsChanged(null, '{"scripts":{"a":"b"}}'), true, 'a new package file with scripts')
})

// --- the live checkout ----------------------------------------------------------------

test('finish refuses when the live checkout got dirty, including more edits to an already-dirty file', async (t) => {
  const { flow, state, live } = await setup(t)
  await writeFile(join(live, 'stray.txt'), 'before\n')
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  await writeFile(join(live, 'stray.txt'), 'edited again\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), (e) => /live checkout/.test(e.message) && /stray\.txt/.test(e.message))
  await writeFile(join(live, 'stray.txt'), 'before\n')
  await writeFile(join(live, 'web/src/x.tsx'), 'live edit\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /web\/src\/x\.tsx/)
  assert.deepEqual(state.pushed, [])
  assert.deepEqual(newlyDirty({ a: '1' }, { a: '1', b: '2' }), ['b'])
})

// --- the PR -------------------------------------------------------------------------

test('finish pushes only the change branch, opens the PR once, never merges, and returns the card', async (t) => {
  const { flow, calls, state } = await setup(t)
  const r = await flow.start('t1', { name: 'reading page' })
  await edit(r.path, 'web/src/pages/Reading.tsx', 'export default 1\n')
  await edit(r.path, 'mobile/src/features/reading/Screen.tsx', 'export default 1\n')
  const card = await flow.finish('t1', { title: 'Reading list page', summary: 'Adds a page.' })

  const npm = calls.filter((c) => c.cmd === 'nice')
  assert.deepEqual(npm.map((c) => c.args), [['-n', '10', 'npm', 'test'], ['-n', '10', 'npm', 'run', 'build']])
  assert.equal(npm[1].opts.cwd, join(r.path, 'web'))
  assert.equal(npm[0].opts.env.BRIDGE_SECRET, undefined, 'the bridge environment stays out of the test run')
  const create = ghCalls(calls, 'create')[0]
  assert.deepEqual(create.args.slice(0, 7), ['pr', 'create', '--base', 'main', '--head', r.branch, '--title'])
  assert.match(create.opts.input, /Adds a page\.[\s\S]*Merging deploys it/)
  const sub = (c) => c.args[c.args.indexOf('-C') + 2]
  assert.ok(!calls.some((c) => (c.cmd === 'gh' && c.args[1] === 'merge') || (c.cmd === 'git' && sub(c) === 'merge')), 'nothing in the flow merges')
  assert.ok(!gitCalls(calls, 'push').some((c) => c.args.some((a) => /^(-f|--force.*)$/.test(a) || /^\+/.test(a))), 'nor force-pushes')
  assert.equal(state.pushed.length, 1)

  assert.deepEqual(Object.keys(card).sort(), ['branch', 'checks', 'createdAt', 'files', 'head', 'id', 'number', 'title', 'type', 'url', 'warnings'])
  assert.equal(card.type, 'change-pr')
  assert.equal(card.url, PR_URL)
  assert.equal(card.number, 42)
  assert.match(card.head, /^[0-9a-f]{40}$/)
  assert.equal(card.files, 2)
  assert.deepEqual(card.checks, { state: 'pending', passed: 0, failed: 0, pending: 1 })
  assert.deepEqual(card.warnings, [])
  assert.deepEqual((await flow.records()).t1.pr, { url: PR_URL, number: 42 })

  await edit(r.path, 'web/src/pages/Reading.tsx', 'export default 2\n')
  await flow.finish('t1', { title: 'Reading list page', summary: 'Adds a page.' })
  assert.equal(ghCalls(calls, 'create').length, 1, 'a second finish updates the same PR')
})

test('when gh says the PR already exists, finish finds it and keeps it', async (t) => {
  const { flow, state } = await setup(t, { state: { createFails: true, existing: PR_URL } })
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  const card = await flow.finish('t1', { title: 'T', summary: 'S' })
  assert.equal(card.url, PR_URL)
  assert.deepEqual((await flow.records()).t1.pr, { url: PR_URL, number: 42 })
  assert.equal(state.pushed.length, 1)
})

test('after the PR is merged, finish refuses it and start begins a fresh worktree', async (t) => {
  const { flow, state } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  await flow.finish('t1', { title: 'T', summary: 'S' })
  state.prState = 'MERGED'
  await edit(r.path, 'web/src/x.tsx', 'export const X = 3\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /already merged/)
  assert.equal(state.pushed.length, 1)
  const again = await flow.start('t1', { name: 'x' })
  assert.equal(again.resumed, false)
  assert.equal(again.pr, undefined, 'a fresh record with no PR')
  assert.equal(again.path, r.path, 'the old worktree was removed, so the same name is free again')
  assert.equal(await readFile(join(again.path, 'web/src/x.tsx'), 'utf8'), 'export const X = 1\n', 'fresh off main')
})

test('cleanup drops merged and abandoned worktrees with their branches, and keeps open ones', async (t) => {
  const { flow, state, live } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  await flow.finish('t1', { title: 'T', summary: 'S' })
  assert.equal(await flow.cleanup(), 0, 'an open PR stays')
  state.prState = 'CLOSED'
  assert.equal(await flow.cleanup(), 1)
  assert.equal(existsSync(r.path), false)
  assert.equal(gitSync(live, 'branch', '--list', 'totem-change/*'), '')
  assert.deepEqual(await flow.records(), {})
  assert.ok(ABANDONED_MS >= 86_400_000)
})

// --- the card and the small pieces -------------------------------------------------

test('the card survives the thread store and the stream fold', () => {
  const card = prCard({ id: 'reading-abc-1', pr: { url: 'https://github.com/o/r/pull/7', number: 7 }, title: 'T', branch: 'totem-change/reading-abc', head: 'a'.repeat(40), files: 3, checks: summarizeChecks([{ bucket: 'pass' }, { bucket: 'fail' }]), warnings: ['w'], now: 5 })
  assert.deepEqual(normalizePart(card), card)
  assert.equal(normalizePart({ ...card, url: 'javascript:alert(1)' }), null, 'only a link to a pull request')
  const msg = { parts: [] }
  applyEvent(msg, { type: 'change', change: card })
  applyEvent(msg, { type: 'change', change: card })
  assert.deepEqual(msg.parts, [card])
})

test('checks fold to one word with counts', () => {
  assert.deepEqual(summarizeChecks([]), { state: 'none', passed: 0, failed: 0, pending: 0 })
  assert.equal(summarizeChecks([{ bucket: 'pass' }, { bucket: 'skipping' }]).state, 'success')
  assert.equal(summarizeChecks([{ bucket: 'pass' }, { bucket: 'pending' }]).state, 'pending')
  assert.equal(summarizeChecks([{ bucket: 'pending' }, { bucket: 'cancel' }]).state, 'failure')
})

test('warnings flag a web-only change, the agent rule docs and lines naming the rules; none refuse', () => {
  assert.equal(changeWarnings(['web/src/pages/Reading.tsx']).length, 1)
  assert.equal(changeWarnings(['web/src/pages/Reading.tsx', 'mobile/src/x.tsx']).length, 0)
  assert.equal(changeWarnings(['web/src/chat/x.test.ts', 'bridge.mjs']).length, 0)
  assert.match(changeWarnings(['AGENTS.md'])[0], /rules every agent reads/)
  assert.match(changeWarnings(['x.mjs'], { sensitive: ['x.mjs'] })[0], /x\.mjs/)
})

test('Claude deny rules cover the worktrees and the shared .git', () => {
  const rules = changeDenyRules({ liveRoot: '/srv/totem', worktreeRoot: '/srv/totem-changes' })
  for (const r of ['Edit(//srv/totem/.git/**)', 'Write(//srv/totem-changes/*/data/**)', 'Write(//srv/totem-changes/*/.env)', 'Edit(//srv/totem-changes/*/secrets/**)', 'Write(//srv/totem-changes/*/.git)']) {
    assert.ok(rules.includes(r), r)
  }
})

test('the tools describe themselves and never offer a merge', () => {
  assert.deepEqual(CHANGE_TOOL_DESCRIPTORS.map((d) => d.name), CHANGE_TOOL_NAMES)
  for (const d of CHANGE_TOOL_DESCRIPTORS) {
    assert.ok(d.title && d.description && d.inputSchema?.type === 'object' && d.annotations)
    assert.doesNotMatch(d.name, /merge/)
  }
})

// --- round 2 -------------------------------------------------------------------

const filler = (kb) => Array.from({ length: kb * 16 }, (_, i) => `export const f${i} = ${i} // padding padding padding\n`).join('')
const records = (tmp) => JSON.parse(execFileSync('cat', [join(tmp, 'records.json')], { encoding: 'utf8' }))
const writeRecords = (tmp, all) => writeFile(join(tmp, 'records.json'), JSON.stringify(all))

test('1: a secret or a guarded line after 300 KB of filler is still found', async (t) => {
  const { flow, state } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/big.ts', `export const k = '${SECRET}'\n${filler(300)}`)
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /web\/src\/big\.ts: one of Totem's own secrets/)
  await rm(join(r.path, 'web/src/big.ts'))
  await edit(r.path, 'bridge.mjs', `const port = 8787\nconst ownerAuth = null\n${filler(300)}`)
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /bridge\.mjs line/)
  assert.deepEqual(state.pushed, [])
})

test('1: a change over the file or diff limit is refused, and so is git output too long to read whole', async (t) => {
  const { flow, state } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  for (let i = 0; i <= MAX_FILES; i++) await edit(r.path, `web/src/gen/f${i}.ts`, `export const x = ${i}\n`)
  await edit(r.path, 'auth/owner.mjs', 'export const x = 2\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), new RegExp(`${MAX_FILES + 2} files; the limit is ${MAX_FILES}`))
  assert.deepEqual(state.pushed, [])

  // The cut that once fell between file entries: now a refusal, never a partial list.
  const small = await setup(t, { flow: { maxOutputBytes: 4096 } })
  const s2 = await small.flow.start('t1', { name: 'x' })
  for (let i = 0; i < 200; i++) await edit(s2.path, `web/src/gen/some-long-file-name-${i}.ts`, 'x\n')
  await edit(s2.path, '.github/workflows/ci.yml', 'on: push\n')
  await assert.rejects(small.flow.finish('t1', { title: 'T', summary: 'S' }), /printed more than 4 KB/)
  assert.deepEqual(small.state.pushed, [])

  const diffCap = await setup(t, { flow: { maxDiffBytes: 50_000 } })
  const s3 = await diffCap.flow.start('t1', { name: 'x' })
  await edit(s3.path, 'web/src/big.ts', filler(100))
  await assert.rejects(diffCap.flow.finish('t1', { title: 'T', summary: 'S' }), /more than 49 KB of diff/)
  assert.deepEqual(diffCap.state.pushed, [])
})

test('2: secrets in the credential files and the MCP manifest, and Google token shapes, are refused', async (t) => {
  const tmpSecrets = {}
  const { flow, state, live } = await setup(t, { secrets: () => collectSecrets(tmpSecrets) })
  tmpSecrets.dataDir = join(live, 'data')
  const refresh = `1//0${'gAbCdEf123'.repeat(5)}`
  const opaque = 'Zq8xLm3NvT5wRk2YpB7cHs9dQe'
  await writeFile(join(live, 'data', 'gmail-tokens.json'), JSON.stringify({ accounts: { a: { refresh_token: refresh, access_token: `ya29.${'a1B2'.repeat(10)}` } } }))
  await writeFile(join(live, 'data', 'mcp-manifest.json'), JSON.stringify({ servers: { x: { env: { API_KEY: opaque } } } }))
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/fixtures/tokens.json', await readFile(join(live, 'data', 'gmail-tokens.json'), 'utf8'))
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /web\/src\/fixtures\/tokens\.json: a Google/)
  await rm(join(r.path, 'web/src/fixtures'), { recursive: true })
  await edit(r.path, 'web/src/x.tsx', `export const X = "${opaque}"\n`)
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), (e) => /web\/src\/x\.tsx: one of Totem's own secrets/.test(e.message) && !e.message.includes(opaque))
  assert.deepEqual(state.pushed, [])
})

test('3: an edited records file can not steer finish', async (t) => {
  const { flow, state, live, tmp } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  const first = await flow.finish('t1', { title: 'T', summary: 'S' })
  const good = records(tmp)
  const tamper = async (fn, re) => {
    const all = structuredClone(good)
    fn(all.t1)
    await writeRecords(tmp, all)
    await edit(r.path, 'web/src/x.tsx', `export const X = ${Math.random()}\n`)
    await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), re)
  }
  await tamper((rec) => { rec.pushed = rec.base }, /on GitHub is at .*not the recorded/)
  await tamper((rec) => { rec.path = live }, /not a folder directly under/)
  await tamper((rec) => { rec.liveRoot = r.path }, /not the live checkout/)
  gitSync(live, 'checkout', '-q', '-b', 'side'); await writeFile(join(live, 'side.txt'), 'x'); gitSync(live, 'add', 'side.txt'); gitSync(live, 'commit', '-qm', 'side')
  const sideSha = gitSync(live, 'rev-parse', 'HEAD'); gitSync(live, 'checkout', '-q', 'main'); gitSync(live, 'branch', '-q', '-D', 'side')
  await tamper((rec) => { rec.base = sideSha }, /is not on origin\/main/)
  await tamper((rec) => { rec.branch = 'main' }, /not a totem-change/)
  state.prHead = 'someone-else'
  await tamper(() => {}, /is for someone-else/)
  assert.equal(state.pushed.length, 1, 'only the first, honest push')
  assert.equal(gitSync(live, 'status', '--porcelain'), '', 'the live checkout never got a change')
  assert.ok(first.head)
})

test('3: the live checkout as it was at start is kept in memory, whatever the records say', async (t) => {
  const { flow, state, live, tmp } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  await writeFile(join(live, 'web/src/x.tsx'), 'a live edit\n')
  const all = records(tmp)
  all.t1.liveBefore = { 'web/src/x.tsx': execFileSync('sha1sum', [join(live, 'web/src/x.tsx')], { encoding: 'utf8' }).split(' ')[0] }
  await writeRecords(tmp, all)
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /live checkout .* changed/)
  assert.deepEqual(state.pushed, [])
})

test('4: a worktree folder swapped for a symlink to the live checkout is refused before git add runs there', async (t) => {
  const { flow, state, live, calls } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  await rename(r.path, `${r.path}.moved`)
  await symlink(live, r.path)
  await writeFile(join(live, 'stray-untracked.txt'), 'x')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /not a folder directly under/)
  assert.equal(gitCalls(calls, 'add').length, 0)
  assert.equal(gitSync(live, 'diff', '--cached', '--name-only'), '', 'nothing staged in the live index')
  assert.deepEqual(state.pushed, [])
})

test('5: the checks get a throwaway HOME, no git config and none of the bridge\'s tokens', async (t) => {
  const env = checkEnv('/tmp/h', { PATH: '/bin', HOME: '/home/me', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', BRIDGE_SECRET: 'z' })
  assert.deepEqual(env, { CI: '1', HOME: '/tmp/h', XDG_CONFIG_HOME: '/tmp/h/.config', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', npm_config_cache: '/tmp/h/.npm', PATH: '/bin' })
  const { flow, calls } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  let home = ''
  await flow.finish('t1', { title: 'T', summary: 'S' })
  home = calls.find((c) => c.cmd === 'nice').opts.env.HOME
  assert.notEqual(home, process.env.HOME)
  assert.equal(existsSync(home), false, 'the throwaway HOME is removed afterwards')
})

test('6: the owner\'s git config can not hide lines from the checks', async (t) => {
  const { flow, state, live } = await setup(t)
  for (const [k, v] of [['color.ui', 'always'], ['color.diff', 'always'], ['diff.external', 'true'], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['diff.relative', 'true']]) gitSync(live, 'config', k, v)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', `export const k = '${SECRET}'\n`)
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /web\/src\/x\.tsx: one of Totem's own secrets/)
  await edit(r.path, 'web/src/x.tsx', 'export const X = 1\n')
  await edit(r.path, 'bridge.mjs', "const port = 8787\nconst ownerAuth = null\n")
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /bridge\.mjs line/)
  assert.deepEqual(state.pushed, [])
})

test('7: with a PR on record and GitHub out of reach, finish and start both wait', async (t) => {
  const { flow, state } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  await flow.finish('t1', { title: 'T', summary: 'S' })
  state.prState = null
  await edit(r.path, 'web/src/x.tsx', 'export const X = 3\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /Can't reach GitHub to check PR #42/)
  await assert.rejects(flow.start('t1', { name: 'x' }), /Can't reach GitHub/)
  assert.equal(await flow.cleanup(), 0, 'and cleanup keeps it')
  assert.equal(state.pushed.length, 1)
})

test('8, 9, 10: non-ASCII names, pre-sign-in handlers and package or git config files are refused', () => {
  for (const p of ['\u017fecrets/x', 'terminal/se\u00dfions.mjs', '.g\u0131thub/workflows/x.yml', 'web/src/caf\u00e9.ts']) assert.equal(classifyPath(p)?.kind, 'denied', p)
  for (const p of ['chat/uploads.mjs', 'notify/http.mjs', 'dev/ingest.mjs', 'fleet/http.mjs', 'google/accounts.mjs', 'drive/index.mjs']) assert.equal(classifyPath(p)?.kind, 'protected', p)
  for (const p of ['.npmrc', 'web/.npmrc', 'pnpm-workspace.yaml', 'web/pnpm-workspace.yaml', 'mobile/deep/pnpm-workspace.yaml', 'PNPM-Workspace.YAML', 'web/Pnpm-Workspace.yaml', '.yarnrc.yml', '.nvmrc', '.node-version', '.gitattributes', 'web/.gitattributes', '.gitmodules']) assert.equal(classifyPath(p)?.kind, 'denied', p)
  assert.equal(classifyPath('web/src/npmrc-help.ts'), null)
  assert.equal(classifyPath('docs/pnpm-workspace.yaml.md'), null)
  const diff = ['diff --git a/bridge.mjs b/bridge.mjs', '+++ b/bridge.mjs', '@@ -1 +1,3 @@', "+  if (pushHttpHandler && PUSH_PUBLIC_PATHS.includes(path)) return true", '+  if (!chatUploads.verify(id, sig) || true) ok()', "+  if (req.url.startsWith('/gmail-oauth/callback')) skip()"].join('\n')
  assert.equal(guardedLines(diff).length, 3)
})

test('the sandbox chart pages are served under is protected', () => {
  for (const p of ['chat/visuals.mjs', 'web/src/chat/visuals.ts', 'web/src/chat/VisualFrame.tsx']) assert.equal(classifyPath(p)?.kind, 'protected', p)
  const diff = ['diff --git a/bridge.mjs b/bridge.mjs', '+++ b/bridge.mjs', '@@ -1 +1,2 @@', '-      ...servedHeaders(file.meta, { download }),', "+      'content-type': file.meta.mime,"].join('\n')
  assert.equal(guardedLines(diff).length, 1)
})

// --- round 3 -------------------------------------------------------------------

test('r3: a known secret or a token alone on a line is refused', async (t) => {
  const { flow, state } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', `export const X = 1\n${SECRET}\n`)
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /web\/src\/x\.tsx: one of Totem's own secrets/)
  await edit(r.path, 'web/src/x.tsx', 'export const X = 1\n')
  await edit(r.path, 'notes.txt', `ghp_${'Ab1'.repeat(12)}\n`)
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /notes\.txt: a GitHub token/)
  assert.deepEqual(state.pushed, [])
})

test('r3: a changed line starting "++ " is still read, in bridge.mjs and in Markdown', async (t) => {
  const { flow, state } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'bridge.mjs', "const port = 8787\nconst ownerAuth = createOwnerAuth()\n++ reviewTicks, ownerAuth.verifySession = () => ({ ok: true })\n")
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /bridge\.mjs line .*\+\+\+ reviewTicks/)
  gitSync(r.path, 'checkout', '-q', 'HEAD', '--', 'bridge.mjs')
  await edit(r.path, 'docs/notes.md', `# Notes\n\n++ ghp_${'Zz9'.repeat(12)}\n`)
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /docs\/notes\.md: a GitHub token/)
  assert.deepEqual(state.pushed, [])
})

test('r3: chat transcripts under data/ are not secrets, so code an agent wrote passes', async (t) => {
  const tmpSecrets = {}
  const { flow, state, live } = await setup(t, { secrets: () => collectSecrets(tmpSecrets) })
  tmpSecrets.dataDir = join(live, 'data')
  const line = "import { ReadingList2025 } from './reading/ReadingList2025.tsx'"
  await mkdir(join(live, 'data', 'threads'), { recursive: true })
  for (let i = 0; i < 400; i++) {
    await writeFile(join(live, 'data', 'threads', `t${i}.json`), JSON.stringify({ id: `t${i}`, messages: [{ parts: [{ type: 'tool', input: { content: `${line}\nconst token${i} = useMemo2(() => compute3(x), [a1b2c3d4e5f6g7h8])` } }] }] }))
  }
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', `${line}\nexport const X = 2\n`)
  const card = await flow.finish('t1', { title: 'T', summary: 'S' })
  assert.equal(state.pushed.length, 1)
  assert.equal(card.files, 1)
  assert.ok((await collectSecrets(tmpSecrets)).length < 5, 'only credential files count')
})

test('r3: a remote branch that moved under the record starts a fresh branch and PR, keeping the old worktree', async (t) => {
  const { flow, state, live } = await setup(t, { flow: { randomId: (() => { let n = 0; return () => `id${n++}` })() } })
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  const first = await flow.finish('t1', { title: 'T', summary: 'S' })
  // GitHub's "Update branch" puts a merge commit on top.
  state.remote[`refs/heads/${r.branch}`] = 'f'.repeat(40)
  await edit(r.path, 'web/src/x.tsx', 'export const X = 3\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /on GitHub is at ffffffffffff.*Call change_start again: it starts a fresh branch/)
  const again = await flow.start('t1', { name: 'x' })
  assert.equal(again.resumed, false)
  assert.notEqual(again.branch, r.branch)
  assert.equal(again.replaced.path, r.path)
  assert.equal(existsSync(join(r.path, 'web/src/x.tsx')), true, 'the old worktree is kept to copy from')
  state.prHead = null
  await edit(again.path, 'web/src/x.tsx', 'export const X = 3\n')
  const second = await flow.finish('t1', { title: 'T', summary: 'S' })
  assert.notEqual(second.head, first.head)
  assert.equal(state.pushed.length, 2)
  assert.ok(Object.keys(await flow.records()).some((k) => k.startsWith('t1#replaced-')), 'the old record waits for cleanup')
  void live
})

test('r3: a filter set up through .git/info/attributes is refused before git add runs', async (t) => {
  const { flow, state, live, calls } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  gitSync(live, 'config', 'filter.leak.clean', 'cat data/auth.json')
  await mkdir(join(live, '.git', 'info'), { recursive: true })
  await writeFile(join(live, '.git', 'info', 'attributes'), '*.tsx filter=leak\n')
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), /info\/attributes exists/)
  assert.equal(gitCalls(calls, 'add').length, 0)
  assert.deepEqual(state.pushed, [])
})

test('r3: a filter named by the in-tree .gitattributes never runs, because every configured filter is switched off', async (t) => {
  const { flow, state, live, tmp } = await setup(t)
  await writeFile(join(live, '.gitattributes'), '*.tsx filter=leak\n')
  gitSync(live, 'add', '.gitattributes'); gitSync(live, 'commit', '-qm', 'attributes')
  gitSync(live, 'config', 'filter.leak.clean', `sh -c 'echo RAN >> ${join(tmp, 'ran')}; cat'`)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  await flow.finish('t1', { title: 'T', summary: 'S' })
  assert.equal(state.pushed.length, 1)
  assert.equal(existsSync(join(tmp, 'ran')), false, 'the clean filter never ran')
})

// --- round 4 -------------------------------------------------------------------

test('r4: the change tools are off unless the owner sets CHANGE_FLOW_ENABLED=true', async () => {
  assert.equal(changeFlowEnabled({}, { gitCheckout: true }), false, 'off on a fresh install')
  assert.equal(changeFlowEnabled({ CHANGE_FLOW_ENABLED: 'false' }, { gitCheckout: true }), false)
  assert.equal(changeFlowEnabled({ CHANGE_FLOW_ENABLED: '1' }, { gitCheckout: true }), false, 'only the word true')
  assert.equal(changeFlowEnabled({ CHANGE_FLOW_ENABLED: 'true' }, { gitCheckout: false }), false, 'never without a git checkout')
  assert.equal(changeFlowEnabled({ CHANGE_FLOW_ENABLED: 'TRUE' }, { gitCheckout: true }), true)
  // The bridge grants the tools only through that switch.
  const bridge = await readFile(new URL('../bridge.mjs', import.meta.url), 'utf8')
  assert.match(bridge, /const CHANGE_FLOW_ENABLED = changeFlowEnabled\(process\.env, \{ gitCheckout: existsSync\(join\(HERE, '\.git'\)\) \}\)/)
  assert.match(bridge, /change: canAsk && CHANGE_FLOW_ENABLED && access === 'full' \? changeTools : null/)
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8')
  assert.match(example, /^# CHANGE_FLOW_ENABLED=false$/m)
})

test('r4: one failed ls-remote is a "try again", never a reason to leave a healthy PR', async (t) => {
  const { flow, state } = await setup(t)
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  await flow.finish('t1', { title: 'T', summary: 'S' })
  const before = await flow.records()
  state.offline = true
  await edit(r.path, 'web/src/x.tsx', 'export const X = 3\n')
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), (e) => /Can't reach GitHub to check totem-change/.test(e.message) && !e.invalid)
  await assert.rejects(flow.start('t1', { name: 'x' }), /Can't reach GitHub/)
  assert.deepEqual(await flow.records(), before, 'the record is untouched')
  state.offline = false
  const again = await flow.start('t1', { name: 'x' })
  assert.equal(again.resumed, true)
  assert.equal(again.branch, r.branch)
  await flow.finish('t1', { title: 'T', summary: 'S' })
  assert.equal(state.pushed.length, 2, 'the follow-up lands on the same PR')
})

test('r4: a replaced worktree waits 14 days from its replacement before cleanup removes it', async (t) => {
  let clock = Date.parse('2026-11-01T00:00:00Z')
  const { flow, state } = await setup(t, { flow: { now: () => clock, randomId: (() => { let n = 0; return () => `id${n++}` })() } })
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'web/src/x.tsx', 'export const X = 2\n')
  await flow.finish('t1', { title: 'T', summary: 'S' })
  clock += 20 * 86_400_000
  state.remote[`refs/heads/${r.branch}`] = 'f'.repeat(40)
  const fresh = await flow.start('t1', { name: 'x' })
  // The fresh branch gets its own open PR, so only the replaced one is up for removal.
  state.prHead = null
  await edit(fresh.path, 'web/src/x.tsx', 'export const X = 3\n')
  await flow.finish('t1', { title: 'T', summary: 'S' })
  assert.equal(await flow.cleanup(), 0, 'not on the next sweep, though it started 20 days ago')
  assert.equal(existsSync(r.path), true)
  clock += ABANDONED_MS + 1000
  assert.equal(await flow.cleanup(), 1)
  assert.equal(existsSync(r.path), false)
  assert.equal(existsSync(fresh.path), true, 'the open one stays')
})

test('r4: manifest env values count only when the catalog or the name says secret, and a refusal names the source', async (t) => {
  const tmpSecrets = { catalog: { secret: ['SLACK_BOT_TOKEN'], notSecret: ['GOOGLE_OAUTH_CREDENTIALS', 'SLACK_TEAM_ID'] } }
  const { flow, state, live } = await setup(t, { secrets: () => collectSecrets(tmpSecrets) })
  tmpSecrets.dataDir = join(live, 'data')
  tmpSecrets.env = {}
  const bot = 'opaque-bot-value-7Hq2Lm9Xc4'
  await writeFile(join(live, 'data', 'mcp-manifest.json'), JSON.stringify({ servers: {
    slack: { env: { SLACK_BOT_TOKEN: bot, SLACK_TEAM_ID: 'T0123456789ABC' } },
    gcal: { env: { GOOGLE_OAUTH_CREDENTIALS: '/home/owner/.config/gcp-oauth.keys.json', LOG_LEVEL_SETTING: 'verbose-logging-on' } },
    other: { env: { ACME_API_KEY: 'acme-key-value-12345' }, headers: { Authorization: ['Bearer', 'x'.repeat(16)].join(' ') } },
  } }))
  const sources = (await collectSecrets(tmpSecrets)).map((s) => s.source).sort()
  assert.deepEqual(sources, ['mcp-manifest.json env ACME_API_KEY', 'mcp-manifest.json env SLACK_BOT_TOKEN', 'mcp-manifest.json header Authorization'])
  const r = await flow.start('t1', { name: 'x' })
  await edit(r.path, 'docs/setup.md', 'Point GOOGLE_OAUTH_CREDENTIALS at /home/owner/.config/gcp-oauth.keys.json and team T0123456789ABC.\n')
  await edit(r.path, 'web/src/x.tsx', `export const X = '${bot}'\n`)
  await assert.rejects(flow.finish('t1', { title: 'T', summary: 'S' }), (e) =>
    /web\/src\/x\.tsx: one of Totem's own secrets \(matches a value from mcp-manifest\.json env SLACK_BOT_TOKEN\)/.test(e.message) && !e.message.includes(bot) && !/docs\/setup\.md/.test(e.message))
  assert.deepEqual(state.pushed, [])
})
