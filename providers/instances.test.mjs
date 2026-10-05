// Run with: node --test providers/instances.test.mjs
//
// These tests specify which login a spawned CLI ends up using. A failure here
// means a request runs against the wrong account — work billed to the personal
// plan, or a work conversation written into a personal home.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readlink, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeInstances,
  resolveInstances,
  instanceEnvironment,
  codexHomeLayout,
  materializeCodexShadowHome,
  splitLaunchArgs,
  slugifyInstanceId,
  expandHome,
  isValidInstanceId,
} from './instances.mjs'

const DRIVERS = ['cursor', 'codex', 'claude', 'opencode']
const DEFS = {
  cursor: { name: 'Cursor', cli: 'cursor-agent', authPaths: ['/home/x/.config/cursor/auth.json'] },
  codex: { name: 'Codex', cli: 'codex', authPaths: [] },
  claude: { name: 'Claude Code', cli: 'claude', authPaths: [] },
  opencode: { name: 'OpenCode', cli: 'opencode', authPaths: [] },
}
const HOME = '/home/tester'

function resolved(instances) {
  return resolveInstances(normalizeInstances(instances, { drivers: DRIVERS }), {
    drivers: DRIVERS, defs: DEFS, home: HOME,
  })
}

test('every driver gets its default instance even with nothing configured', () => {
  const list = resolved({})
  assert.deepEqual(list.map((i) => i.id), DRIVERS)
  assert.ok(list.every((i) => i.isDefault))
  assert.equal(list.find((i) => i.id === 'claude').name, 'Claude Code')
})

test('a stored instance id is a driver id, so old configs need no migration', () => {
  const list = resolved({ codex: { driver: 'codex', config: { binaryPath: '/opt/codex' } } })
  const codex = list.find((i) => i.id === 'codex')
  assert.equal(codex.isDefault, true)
  assert.equal(codex.cli, '/opt/codex')
})

test('extra accounts follow their driver default, in the order they were added', () => {
  const list = resolved({
    codex_work: { driver: 'codex', displayName: 'Codex (Work)' },
    claude_work: { driver: 'claude' },
    codex_side: { driver: 'codex' },
  })
  assert.deepEqual(list.map((i) => i.id), [
    'cursor', 'codex', 'codex_work', 'codex_side', 'claude', 'claude_work', 'opencode',
  ])
  assert.equal(list.find((i) => i.id === 'codex_work').name, 'Codex (Work)')
  // No display name: the slug is the label rather than a second row reading "Codex".
  assert.equal(list.find((i) => i.id === 'codex_side').name, 'codex_side')
})

test('only claude and codex take a second account', () => {
  const instances = normalizeInstances({
    cursor_work: { driver: 'cursor' },
    opencode_work: { driver: 'opencode' },
    claude_work: { driver: 'claude' },
  }, { drivers: DRIVERS })
  assert.deepEqual(Object.keys(instances), ['claude_work'])
})

test('unknown drivers and malformed ids are dropped, not half-applied', () => {
  const instances = normalizeInstances({
    'Claude Work': { driver: 'claude' },
    '9lives': { driver: 'claude' },
    gemini_work: { driver: 'gemini' },
    claude_ok: { driver: 'claude' },
  }, { drivers: DRIVERS })
  assert.deepEqual(Object.keys(instances), ['claude_ok'])
  assert.equal(isValidInstanceId('claude_ok'), true)
  assert.equal(isValidInstanceId('Claude'), false)
})

test('claude isolates through CLAUDE_CONFIG_DIR, never HOME', () => {
  const [claude] = resolved({ claude_work: { driver: 'claude', config: { homePath: '~/.claude-work' } } })
    .filter((i) => i.id === 'claude_work')
  const env = instanceEnvironment(claude, { HOME, PATH: '/usr/bin' }, HOME)
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/tester/.claude-work')
  assert.equal(env.HOME, HOME)
  assert.deepEqual(claude.authPaths, [
    '/home/tester/.claude-work/.credentials.json',
    '/home/tester/.claude-work/.claude/.credentials.json',
  ])
})

test('an unconfigured default sets no home override at all', () => {
  const claude = resolved({}).find((i) => i.id === 'claude')
  const env = instanceEnvironment(claude, { PATH: '/usr/bin' }, HOME)
  assert.equal('CLAUDE_CONFIG_DIR' in env, false)
  const codex = resolved({}).find((i) => i.id === 'codex')
  assert.equal('CODEX_HOME' in instanceEnvironment(codex, { PATH: '/usr/bin' }, HOME), false)
})

test('a codex shadow home is what CODEX_HOME points at; the shared home stays shared', () => {
  const instance = resolved({
    codex_work: { driver: 'codex', config: { homePath: '~/.codex', shadowHomePath: '~/.codex-totem/work' } },
  }).find((i) => i.id === 'codex_work')
  const layout = codexHomeLayout(instance, HOME)
  assert.equal(layout.mode, 'overlay')
  assert.equal(layout.sharedHomePath, '/home/tester/.codex')
  assert.equal(layout.effectiveHomePath, '/home/tester/.codex-totem/work')
  assert.equal(instanceEnvironment(instance, {}, HOME).CODEX_HOME, '/home/tester/.codex-totem/work')
  // The quota belongs to the account, so usage reads the shadow home's auth.json.
  assert.equal(instance.usageHome, '/home/tester/.codex-totem/work')
  assert.deepEqual(instance.authPaths, ['/home/tester/.codex-totem/work/auth.json'])
})

test('per-instance env vars are applied, but cannot override the account selector', () => {
  const instance = resolved({
    claude_work: {
      driver: 'claude',
      config: { homePath: '~/.claude-work' },
      env: [{ name: 'ANTHROPIC_LOG', value: 'debug' }, { name: 'CLAUDE_CONFIG_DIR', value: '/tmp/wrong' }],
    },
  }).find((i) => i.id === 'claude_work')
  const env = instanceEnvironment(instance, {}, HOME)
  assert.equal(env.ANTHROPIC_LOG, 'debug')
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/tester/.claude-work')
})

test('launch arguments split like argv, keeping quoted paths whole', () => {
  assert.deepEqual(splitLaunchArgs('--chrome  --profile "/tmp/a b"'), ['--chrome', '--profile', '/tmp/a b'])
  assert.deepEqual(splitLaunchArgs(''), [])
  assert.deepEqual(splitLaunchArgs("--name 'two words'"), ['--name', 'two words'])
})

test('home paths expand from ~ and $HOME', () => {
  assert.equal(expandHome('~/.codex', HOME), '/home/tester/.codex')
  assert.equal(expandHome('$HOME/.codex', HOME), '/home/tester/.codex')
  assert.equal(expandHome('/etc/codex', HOME), '/etc/codex')
  assert.equal(expandHome('', HOME), '')
})

test('a display name becomes a unique-ish slug id', () => {
  assert.equal(slugifyInstanceId('codex', 'Codex (Work)'), 'codex_work')
  assert.equal(slugifyInstanceId('claude', '  '), 'claude_account')
})

// ---- shadow home materialization, against a real filesystem ----------------

async function shadowFixture() {
  const home = await mkdtemp(join(tmpdir(), 'totem-codex-'))
  const shared = join(home, '.codex')
  await mkdir(join(shared, 'sessions'), { recursive: true })
  await writeFile(join(shared, 'config.toml'), '# shared config\n')
  await writeFile(join(shared, 'auth.json'), '{"tokens":{"shared":true}}')
  const instance = { driver: 'codex', config: { homePath: shared, shadowHomePath: join(home, 'shadow') } }
  return { home, shared, shadow: join(home, 'shadow'), instance }
}

test('the shadow home shares config and sessions but keeps its own auth.json', async () => {
  const { shared, shadow, instance } = await shadowFixture()
  await materializeCodexShadowHome(instance)

  // Shared state is one file seen through two paths: MCP servers Totem syncs
  // into config.toml reach every account without being written twice.
  assert.equal(await readlink(join(shadow, 'config.toml')), join(shared, 'config.toml'))
  assert.equal((await lstat(join(shadow, 'sessions'))).isSymbolicLink(), true)
  assert.equal(await readFile(join(shadow, 'config.toml'), 'utf8'), '# shared config\n')

  // The login is not shared, and the shared account's auth.json is not visible.
  assert.equal(await lstat(join(shadow, 'auth.json')).catch(() => null), null)

  await writeFile(join(shadow, 'auth.json'), '{"tokens":{"work":true}}')
  assert.equal(await readFile(join(shared, 'auth.json'), 'utf8'), '{"tokens":{"shared":true}}')
})

test('re-running picks up directories added to the shared home since last time', async () => {
  const { shared, shadow, instance } = await shadowFixture()
  await materializeCodexShadowHome(instance)
  await mkdir(join(shared, 'skills', 'new-skill'), { recursive: true })
  await writeFile(join(shared, 'prompts.md'), 'hi')
  await materializeCodexShadowHome(instance)
  assert.equal(await readFile(join(shadow, 'prompts.md'), 'utf8'), 'hi')
  assert.equal((await lstat(join(shadow, 'skills', 'new-skill'))).isDirectory(), true)
})

test('an auth.json symlink is refused rather than quietly sharing a login', async () => {
  const { shared, shadow, instance } = await shadowFixture()
  await materializeCodexShadowHome(instance)
  await symlink(join(shared, 'auth.json'), join(shadow, 'auth.json'))
  await assert.rejects(() => materializeCodexShadowHome(instance), /auth\.json must be its own file/)
})

test('a real file where a link belongs is reported, not deleted', async () => {
  const { shadow, instance } = await shadowFixture()
  await mkdir(shadow, { recursive: true })
  await writeFile(join(shadow, 'config.toml'), 'mine')
  await assert.rejects(() => materializeCodexShadowHome(instance), /already exists and is not a symlink/)
  assert.equal(await readFile(join(shadow, 'config.toml'), 'utf8'), 'mine')
})

test('a shadow home equal to the shared home is refused', async () => {
  const { shared, instance } = await shadowFixture()
  await assert.rejects(
    () => materializeCodexShadowHome({ ...instance, config: { homePath: shared, shadowHomePath: shared } }),
    /must be different/,
  )
})

test('mergeExecFields reports binary, home, launch-arg and env changes', async () => {
  const { mergeExecFields } = await import('./instances.mjs')
  const known = {
    config: { binaryPath: '', homePath: '~/.claude-work', shadowHomePath: '', launchArgs: '' },
    env: [{ name: 'ANTHROPIC_API_KEY', value: 'sk-secret', sensitive: true }],
  }
  // Name/accent only: nothing exec-sensitive changes.
  assert.deepEqual(mergeExecFields(known, { displayName: 'Work' }).changed, [])
  // The dashboard sends sensitive values back redacted; that is "unchanged" and the value survives.
  const redacted = mergeExecFields(known, { env: [{ name: 'ANTHROPIC_API_KEY', value: '', sensitive: true, valueRedacted: true }] })
  assert.deepEqual(redacted.changed, [])
  assert.equal(redacted.entry.env[0].value, 'sk-secret')
  // Unchanged config echoed back is not a change.
  assert.deepEqual(mergeExecFields(known, { config: { ...known.config } }).changed, [])
  assert.deepEqual(mergeExecFields(known, { config: { ...known.config, binaryPath: '/tmp/evil' } }).changed, ['binaryPath'])
  assert.deepEqual(mergeExecFields(known, { config: { ...known.config, launchArgs: '--x' } }).changed, ['launchArgs'])
  assert.deepEqual(mergeExecFields(known, { config: { homePath: '/tmp' } }).changed, ['homePath'])
  assert.deepEqual(mergeExecFields(known, { env: [{ name: 'LD_PRELOAD', value: '/tmp/x.so' }] }).changed, ['env'])
})

test('bridge refuses exec-sensitive provider edits unless TOTEM_ALLOW_UI_EXEC_CONFIG is set', async () => {
  const { readFileSync } = await import('node:fs')
  const bridge = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8')
  assert.match(bridge, /merged\.changed\.length && !EXEC_CONFIG_EDITABLE[\s\S]{0,80}send\(res, 403/)
  assert.match(bridge, /custom && !EXEC_CONFIG_EDITABLE\) throw/)
  assert.match(bridge, /EXEC_CONFIG_EDITABLE = \/\^\(1\|true\|yes\)\$\/i\.test\(String\(process\.env\.TOTEM_ALLOW_UI_EXEC_CONFIG/)
})

test('Claude deny rules cover the session key, stored keys, .env and secrets as absolute paths', async () => {
  const { claudeSecretDenyRules } = await import('./instances.mjs')
  const rules = claudeSecretDenyRules('/srv/totem/')
  // `//` is Claude Code's spelling of an absolute path in a permission rule.
  assert.ok(rules.includes('Read(//srv/totem/data/auth.json)'))
  assert.ok(rules.includes('Edit(//srv/totem/.env)'))
  assert.ok(rules.includes('Read(//srv/totem/secrets/**)'))
  assert.ok(rules.includes('Read(//srv/totem/data/ai-settings.json)'))
  const { readFileSync } = await import('node:fs')
  const bridge = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8')
  const start = bridge.indexOf('function spawnClaudeStream(')
  assert.match(bridge.slice(start, start + 900), /args\.push\('--disallowedTools', \.\.\.\(readOnly \? CLAUDE_WRITE_TOOLS : \[\]\), \.\.\.claudeSecretDenyRules\(HERE\)\)/)
})

test('a Codex account gets the stored OpenAI key as CODEX_API_KEY too', async () => {
  const { instanceEnvironment } = await import('./instances.mjs')
  const codex = { driver: 'codex', config: {}, env: [] }
  const env = instanceEnvironment(codex, { OPENAI_API_KEY: 'sk-test-1234' }, '/home/x')
  assert.equal(env.CODEX_API_KEY, 'sk-test-1234')
  assert.equal(env.OPENAI_API_KEY, 'sk-test-1234')
  // An explicit CODEX_API_KEY wins, and other drivers are left alone.
  assert.equal(instanceEnvironment(codex, { OPENAI_API_KEY: 'a', CODEX_API_KEY: 'b' }, '/home/x').CODEX_API_KEY, 'b')
  assert.equal(instanceEnvironment({ driver: 'opencode', config: {}, env: [] }, { OPENAI_API_KEY: 'a' }, '/home/x').CODEX_API_KEY, undefined)
  assert.equal(instanceEnvironment(codex, {}, '/home/x').CODEX_API_KEY, undefined)
})

test('an effective API key counts as signed in, from env, stored settings or the account', async () => {
  const { effectiveApiKeyVar } = await import('./instances.mjs')
  const claude = { driver: 'claude', config: {}, env: [] }
  assert.equal(effectiveApiKeyVar(claude, {}, '/home/x'), null)
  // process.env carries both real env and keys applied from Settings -> AI.
  assert.equal(effectiveApiKeyVar(claude, { ANTHROPIC_API_KEY: 'sk-ant-x' }, '/home/x'), 'ANTHROPIC_API_KEY')
  assert.equal(effectiveApiKeyVar({ ...claude, env: [{ name: 'ANTHROPIC_API_KEY', value: 'k' }] }, {}, '/home/x'), 'ANTHROPIC_API_KEY')
  assert.equal(effectiveApiKeyVar(claude, { ANTHROPIC_API_KEY: '  ' }, '/home/x'), null)
  assert.equal(effectiveApiKeyVar({ driver: 'codex', config: {}, env: [] }, { OPENAI_API_KEY: 'sk' }, '/home/x'), 'CODEX_API_KEY')
  assert.equal(effectiveApiKeyVar({ driver: 'cursor', config: {}, env: [] }, { ANTHROPIC_API_KEY: 'sk' }, '/home/x'), null)
})

test('provider health and status treat a key-only account as ready', async () => {
  const { readFileSync } = await import('node:fs')
  const bridge = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8')
  const health = bridge.slice(bridge.indexOf('async function checkProviderHealth('))
  // The key check comes before the credentials-file and status-command checks.
  assert.ok(health.indexOf('effectiveApiKeyVar(instance)') < health.indexOf('claudeCredentialHealth(instance)'))
  assert.match(health.slice(0, 1500), /if \(keyVar\) return \{ \.\.\.base, state: 'ready'/)
  assert.match(bridge, /const authenticated = effectiveApiKeyVar\(instance\) \? true :/)
})
