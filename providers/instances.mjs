/**
 * Provider instances — one configured *account*, not one CLI.
 *
 * Totem used to have exactly four agents: `cursor`, `codex`, `claude`, `opencode`.
 * That identifier did two jobs at once — it named the CLI to spawn *and* the login
 * that CLI would use — which was fine right up until the same CLI needed two
 * logins (a personal ChatGPT plan and a work one, a personal Claude subscription
 * and the team's).
 *
 * So the identifier is split in two, the way T3 Code splits it:
 *
 *   - **driver** — which CLI and protocol: `codex`, `claude`, `cursor`, `opencode`.
 *     Fixed, four of them, defined by PROVIDER_DEFS in bridge.mjs.
 *   - **instance id** — the routing key everything else stores: chats, jobs,
 *     `defaultProvider`, `enabledProviders`, the curated model lists. User-defined
 *     (`codex_work`, `claude_personal`).
 *
 * The migration is free because **the default instance of a driver has the driver's
 * own id**. `defaultProvider: "codex"` in an old provider-config.json is already a
 * valid instance id, so nothing has to be rewritten on upgrade.
 *
 * ## Isolating a login
 *
 * Neither CLI takes a "use this account" flag; both read whichever credentials
 * live in their config directory. So an instance is isolated by pointing that
 * directory somewhere else, per driver:
 *
 *   - **Claude** — `CLAUDE_CONFIG_DIR`. Deliberately *not* `HOME`: overriding HOME
 *     also moves the macOS keychain lookup, and the CLI then reports "not logged
 *     in" while staring straight at its own credentials.
 *   - **Codex** — `CODEX_HOME`, pointed at a *shadow home*: a directory where
 *     `auth.json` and `models_cache.json` are real files and every other entry is
 *     a symlink back to the shared `~/.codex`. The login is per-account; sessions,
 *     skills, `config.toml` and the MCP servers Totem syncs into it are shared by
 *     all of them. Without this, adding a second account would fork the MCP config
 *     and every synced server would have to be written twice.
 *
 * Only `claude` and `codex` take extra accounts. Cursor and OpenCode get exactly
 * one instance each — they're a single login here and nothing wants a second.
 *
 * @module providers/instances
 */
import { homedir } from 'node:os'
import { join, resolve, dirname, isAbsolute } from 'node:path'
import { mkdir, readdir, readlink, symlink, rm } from 'node:fs/promises'

/** Drivers that can hold more than one account. */
export const MULTI_ACCOUNT_DRIVERS = new Set(['claude', 'codex'])

/**
 * Instance ids are used as JSON object keys, URL query values and log fields, so
 * they're kept to a slug: starts with a letter, then letters/digits/`-`/`_`.
 */
const INSTANCE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

export function isValidInstanceId(id) {
  return INSTANCE_ID_RE.test(String(id || ''))
}

/**
 * Turn a display name into a candidate instance id (`Claude (Work)` → `claude_work`).
 * The caller still has to de-duplicate against existing ids.
 */
export function slugifyInstanceId(driver, name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    // "Codex (Work)" is the natural thing to type, and `codex_codex_work` is not
    // the natural id for it.
    .replace(new RegExp(`^${driver}_?`), '')
    .slice(0, 40)
  const id = slug ? `${driver}_${slug}` : `${driver}_account`
  return isValidInstanceId(id) ? id : `${driver}_account`
}

/** `~/x` and `$HOME/x` → an absolute path. Anything else is returned untouched. */
export function expandHome(path, home = homedir()) {
  const value = String(path || '').trim()
  if (!value) return ''
  if (value === '~' || value === '$HOME') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  if (value.startsWith('$HOME/')) return join(home, value.slice(6))
  return value
}

/** Absolute, home-expanded path, or '' when nothing was configured. */
function absolutePath(path, home) {
  const expanded = expandHome(path, home)
  return expanded ? resolve(expanded) : ''
}

/** Print a path back with the user's home as `~`, which is how the UI shows it. */
export function prettyPath(path, home = homedir()) {
  const value = String(path || '')
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value
}

/**
 * Per-instance environment variables: `[{ name, value, sensitive }]`.
 *
 * `sensitive` only changes how the value is rendered (the API redacts it and the
 * UI masks it) — it is still a plaintext entry in provider-config.json, same as
 * every other secret this box keeps on disk.
 */
export function normalizeEnvList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const raw of value) {
    const name = String(raw?.name || '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      value: typeof raw?.value === 'string' ? raw.value : '',
      sensitive: Boolean(raw?.sensitive),
    })
  }
  return out
}

function cleanString(value, max = 512) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** `#rrggbb`, or '' — the UI paints the instance's accent from it. */
function normalizeAccent(value) {
  const hex = cleanString(value, 7)
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : ''
}

/**
 * Normalize one stored instance entry. Returns null when the entry can't be
 * routed at all (unknown driver, or a second account on a driver that only has
 * room for one) — a stored entry we can't honour is dropped rather than
 * half-applied, because a half-applied account is one that spawns a CLI against
 * the wrong login.
 */
export function normalizeInstanceEntry(id, raw, { drivers }) {
  if (!isValidInstanceId(id)) return null
  const driver = cleanString(raw?.driver, 32)
  if (!drivers.includes(driver)) return null
  const isDefault = id === driver
  if (!isDefault && !MULTI_ACCOUNT_DRIVERS.has(driver)) return null
  const config = raw?.config && typeof raw.config === 'object' ? raw.config : {}
  return {
    driver,
    displayName: cleanString(raw?.displayName, 80),
    accentColor: normalizeAccent(raw?.accentColor),
    config: {
      binaryPath: cleanString(config.binaryPath),
      homePath: cleanString(config.homePath),
      // Codex only. Claude isolates through homePath alone.
      shadowHomePath: driver === 'codex' ? cleanString(config.shadowHomePath) : '',
      launchArgs: cleanString(config.launchArgs, 1024),
    },
    env: normalizeEnvList(raw?.env),
  }
}

/** Normalize the whole `instances` map from provider-config.json. */
export function normalizeInstances(value, { drivers }) {
  if (!value || typeof value !== 'object') return {}
  const out = {}
  for (const [rawId, raw] of Object.entries(value)) {
    const id = String(rawId || '').trim().toLowerCase()
    const entry = normalizeInstanceEntry(id, raw, { drivers })
    if (entry) out[id] = entry
  }
  return out
}

/**
 * Codex's home layout for one instance.
 *
 * `direct` — one login, `CODEX_HOME` is the shared home (or unset, so the CLI
 * picks its own `~/.codex`). `overlay` — `CODEX_HOME` is the shadow home, whose
 * `auth.json` is this account's and whose everything-else points at the shared one.
 */
export function codexHomeLayout(instance, home = homedir()) {
  const sharedHomePath = absolutePath(instance?.config?.homePath, home) || join(home, '.codex')
  const shadowHomePath = absolutePath(instance?.config?.shadowHomePath, home)
  if (!shadowHomePath) {
    return {
      mode: 'direct',
      sharedHomePath,
      // An unset homePath means "whatever the CLI would do on its own" — we don't
      // set CODEX_HOME at all in that case, so an odd CODEX_HOME already in the
      // service environment keeps working.
      effectiveHomePath: instance?.config?.homePath ? sharedHomePath : '',
    }
  }
  return { mode: 'overlay', sharedHomePath, effectiveHomePath: shadowHomePath }
}

/** Claude's config directory for one instance ('' = the CLI's own default). */
export function claudeConfigDir(instance, home = homedir()) {
  return absolutePath(instance?.config?.homePath, home)
}

/**
 * Where this instance's login is expected to sit on disk.
 *
 * Claude writes `<configDir>/.credentials.json` for a flat config dir, but a home
 * that was isolated by moving HOME instead has it one level down in `.claude/` —
 * accept either, the same way the usage poller does.
 */
export function instanceAuthPaths(instance, def, home = homedir()) {
  if (instance.driver === 'claude') {
    const dir = claudeConfigDir(instance, home) || join(home, '.claude')
    return [join(dir, '.credentials.json'), join(dir, '.claude', '.credentials.json')]
  }
  if (instance.driver === 'codex') {
    const layout = codexHomeLayout(instance, home)
    return [join(layout.effectiveHomePath || layout.sharedHomePath, 'auth.json')]
  }
  return def?.authPaths || []
}

/**
 * The home directory whose *quota* belongs to this instance — what the usage
 * poller is pointed at. For a Codex overlay that's the shadow home (its own
 * auth.json is the account), for Claude the config dir.
 */
export function instanceUsageHome(instance, home = homedir()) {
  if (instance.driver === 'claude') return claudeConfigDir(instance, home) || join(home, '.claude')
  if (instance.driver === 'codex') {
    const layout = codexHomeLayout(instance, home)
    return layout.effectiveHomePath || layout.sharedHomePath
  }
  return ''
}

/**
 * Split a launch-arguments string into argv, honouring single and double quotes
 * so a path with a space survives. Not a shell: no expansion, no operators.
 */
export function splitLaunchArgs(value) {
  const text = String(value || '').trim()
  if (!text) return []
  const args = []
  let current = ''
  let quote = ''
  let started = false
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    if (/\s/.test(char)) {
      if (started) { args.push(current); current = ''; started = false }
      continue
    }
    current += char
    started = true
  }
  if (started) args.push(current)
  return args
}

/**
 * The environment one instance's CLI is spawned with: the bridge's own
 * environment, then the instance's variables, then the config-dir override that
 * actually selects the account (which therefore wins over a stray env entry).
 */
export function instanceEnvironment(instance, baseEnv = process.env, home = homedir()) {
  const env = { ...baseEnv }
  for (const variable of instance.env || []) env[variable.name] = variable.value
  if (instance.driver === 'claude') {
    const dir = claudeConfigDir(instance, home)
    if (dir) env.CLAUDE_CONFIG_DIR = dir
  }
  if (instance.driver === 'codex') {
    const layout = codexHomeLayout(instance, home)
    if (layout.effectiveHomePath) env.CODEX_HOME = layout.effectiveHomePath
    // `codex exec` authenticates from CODEX_API_KEY; an OPENAI_API_KEY alone (the
    // name Settings -> AI stores it under, shared with OpenCode) is not enough for
    // it. Mirror it unless the account set its own.
    if (!env.CODEX_API_KEY && env.OPENAI_API_KEY) env.CODEX_API_KEY = env.OPENAI_API_KEY
  }
  return env
}

// ---------------------------------------------------------------------------
// Codex shadow home
//
// A shadow home is a Codex home whose login is its own and whose everything-else
// is the shared home's. It's built out of symlinks, one per top-level entry,
// which is why it has to be (re)materialized before use: a new directory in the
// shared home (a new `skills/`, say) is invisible to the shadow until it's linked.
// ---------------------------------------------------------------------------

/** Created in the shared home if missing, so the link targets exist to point at. */
const SHARED_DIRECTORIES = [
  'sessions', 'archived_sessions', 'sqlite', 'shell_snapshots',
  'worktrees', 'skills', 'plugins', 'cache', 'logs', 'mcp-oauth-locks',
]

/** The whole point: these stay real files in the shadow home, one per account. */
const PRIVATE_ENTRIES = new Set(['auth.json', 'models_cache.json'])

/** Scratch the shadow keeps to itself rather than scribbling on the shared home. */
const SHADOW_LOCAL_ENTRIES = new Set(['log', 'memories', 'tmp'])

/** Runtime junk that may legitimately exist as a real dir and can be replaced. */
const REPLACEABLE_ENTRIES = new Set(['mcp-oauth-locks'])

/** Symlink | real | missing — readlink is the cheapest way to ask all three. */
async function linkState(path) {
  try {
    return { kind: 'symlink', target: await readlink(path) }
  } catch (e) {
    if (e.code === 'ENOENT') return { kind: 'missing' }
    if (e.code === 'EINVAL') return { kind: 'real' }
    throw e
  }
}

async function ensureSymlink(sharedHomePath, shadowHomePath, name) {
  const target = join(sharedHomePath, name)
  const link = join(shadowHomePath, name)
  const state = await linkState(link)
  if (state.kind === 'real') {
    // Refusing here is the safe half of the trade: a real file at this path holds
    // data that replacing it would delete, and we have no idea whose.
    if (!REPLACEABLE_ENTRIES.has(name)) {
      throw new Error(`${link} already exists and is not a symlink — move it aside, or pick a different shadow home`)
    }
    await rm(link, { recursive: true, force: true })
    return symlink(target, link)
  }
  if (state.kind === 'missing') return symlink(target, link)
  if (resolve(dirname(link), state.target) !== target) {
    await rm(link, { force: true })
    return symlink(target, link)
  }
}

/**
 * Build (or repair) the shadow home for a Codex instance. Idempotent: run it
 * before every spawn so entries added to the shared home since last time show up.
 * Returns the layout it materialized.
 */
export async function materializeCodexShadowHome(instance, home = homedir()) {
  const layout = codexHomeLayout(instance, home)
  if (layout.mode !== 'overlay') return layout
  if (layout.effectiveHomePath === layout.sharedHomePath) {
    throw new Error('the shadow home path must be different from the CODEX_HOME path')
  }

  await Promise.all([
    mkdir(layout.sharedHomePath, { recursive: true }),
    mkdir(layout.effectiveHomePath, { recursive: true }),
    ...SHARED_DIRECTORIES.map((dir) => mkdir(join(layout.sharedHomePath, dir), { recursive: true })),
  ])

  let existing = []
  try { existing = await readdir(layout.sharedHomePath) } catch { existing = [] }
  const entries = new Set(SHARED_DIRECTORIES)
  for (const name of existing) {
    if (!PRIVATE_ENTRIES.has(name) && !SHADOW_LOCAL_ENTRIES.has(name)) entries.add(name)
  }

  for (const name of entries) await ensureSymlink(layout.sharedHomePath, layout.effectiveHomePath, name)

  // A private entry that got linked (by an older build, or by hand) would hand
  // this account the other one's login — and for auth.json, write this account's
  // refreshed token straight into it.
  for (const name of PRIVATE_ENTRIES) {
    const path = join(layout.effectiveHomePath, name)
    const state = await linkState(path)
    if (state.kind !== 'symlink') continue
    if (name === 'auth.json') {
      throw new Error(`${path} is a symlink — an account's auth.json must be its own file`)
    }
    await rm(path, { force: true })
  }

  return layout
}

/**
 * Resolve the configured instances into the ordered list everything else reads:
 * each driver's default instance first, then that driver's extra accounts in the
 * order they were added. A driver with no stored entry still gets its default —
 * the four CLIs are always present, configured or not.
 */
export function resolveInstances(instances, { drivers, defs, home = homedir() } = {}) {
  const stored = instances || {}
  const out = []
  for (const driver of drivers) {
    const def = defs[driver]
    const ids = [driver, ...Object.keys(stored).filter((id) => id !== driver && stored[id].driver === driver)]
    for (const id of ids) {
      const entry = stored[id] || { driver, displayName: '', accentColor: '', config: {}, env: [] }
      const isDefault = id === driver
      out.push({
        id,
        driver,
        isDefault,
        name: entry.displayName || (isDefault ? def.name : id),
        accentColor: entry.accentColor || '',
        config: {
          binaryPath: entry.config?.binaryPath || '',
          homePath: entry.config?.homePath || '',
          shadowHomePath: entry.config?.shadowHomePath || '',
          launchArgs: entry.config?.launchArgs || '',
        },
        env: entry.env || [],
        // What to actually spawn, and where its login lives.
        cli: entry.config?.binaryPath || def.cli,
        authPaths: instanceAuthPaths({ driver, config: entry.config || {} }, def, home),
        usageHome: instanceUsageHome({ driver, config: entry.config || {} }, home),
        configured: Boolean(stored[id]),
      })
    }
  }
  return out
}

// Fields that decide what program runs and with what environment. A browser
// session that can change them can run anything as this user, so the dashboard
// may only change them when TOTEM_ALLOW_UI_EXEC_CONFIG=true; otherwise they are
// edited in data/provider-config.json on the box.
export const EXEC_CONFIG_FIELDS = Object.freeze(['binaryPath', 'homePath', 'shadowHomePath', 'launchArgs'])

/**
 * Merge an incoming account patch onto the stored account, reporting which
 * exec-sensitive fields it would change. A sensitive env value comes back from
 * the dashboard redacted (empty, `valueRedacted`); that means "unchanged", so the
 * stored value is restored rather than wiped.
 */
export function mergeExecFields(known, entry = {}) {
  const changed = []
  const knownConfig = known?.config || {}
  let config = knownConfig
  if (entry.config && typeof entry.config === 'object') {
    config = { ...knownConfig }
    for (const field of EXEC_CONFIG_FIELDS) {
      if (!Object.hasOwn(entry.config, field)) continue
      const next = cleanString(entry.config[field], field === 'launchArgs' ? 1024 : 512)
      if (next !== cleanString(knownConfig[field] || '')) changed.push(field)
      config[field] = next
    }
  }
  const knownEnv = normalizeEnvList(known?.env)
  let env = knownEnv
  if (Array.isArray(entry.env)) {
    const byName = new Map(knownEnv.map((v) => [v.name, v.value]))
    env = normalizeEnvList(entry.env.map((v) => (
      v?.valueRedacted && !v.value && byName.has(String(v.name || '').trim())
        ? { ...v, value: byName.get(String(v.name).trim()) }
        : v
    )))
    if (JSON.stringify(env) !== JSON.stringify(knownEnv)) changed.push('env')
  }
  return { entry: { ...entry, config, env }, changed }
}

// Files under the Totem checkout an agent has no reason to read: the owner's
// password hash and session-signing key, stored API keys and OAuth credentials,
// and the environment file. Claude Code takes these as permission deny rules
// (`Read(//abs/path)`); the other CLIs have no equivalent switch — see AGENTS.md.
export const AGENT_SECRET_PATHS = Object.freeze([
  'data/auth.json', 'data/ai-settings.json', 'data/integrations.json',
  '.env', 'secrets/**',
])

/** Claude Code deny rules keeping its file tools away from AGENT_SECRET_PATHS. */
export function claudeSecretDenyRules(root) {
  const base = String(root).replace(/\/+$/, '')
  return AGENT_SECRET_PATHS.flatMap((rel) => ['Read', 'Edit', 'Write'].map((tool) => `${tool}(/${base}/${rel})`))
}

// API-key variables each CLI accepts instead of a subscription login.
const API_KEY_VARS = Object.freeze({
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
})

/**
 * The API-key variable this account will run with, if any — from the real
 * environment, a key stored in Settings -> AI (already applied to process.env), or
 * the account's own env list. Null when it relies on a login instead.
 */
export function effectiveApiKeyVar(instance, baseEnv = process.env, home = homedir()) {
  const env = instanceEnvironment(instance, baseEnv, home)
  return (API_KEY_VARS[instance?.driver] || []).find((name) => String(env[name] || '').trim()) || null
}
