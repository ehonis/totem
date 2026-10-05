// Settings stored on this box that behave like environment variables.
//
// createEnvBackedSettings() is the general store: named values entered in the
// dashboard, kept in a 0600 JSON file, and put into this process's environment
// unless the real environment already sets them. createAiSettings() is the
// Settings -> AI instance (agent CLI API keys); Settings -> Integrations uses the
// same store for OAuth client ids and secrets.
//
// Settings -> AI: API keys for the agent CLIs.
// Totem's AI is whichever agent CLI is configured (Codex, Claude Code, OpenCode,
// Cursor). Each can run on a subscription login, which lives in the CLI's own
// config, or on an API key read from its environment. This module holds the keys
// entered in the dashboard and puts them into this process's environment, which
// every spawned CLI inherits.
//
// Rules:
//   - A key set in the real environment (.env, systemd, docker) always wins; the
//     dashboard shows it as "from env" and cannot change it.
//   - Stored keys live in data/ai-settings.json, mode 0600.
//   - Values never leave the server. describe() returns a mask.

import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'

export const AI_KEYS = Object.freeze([
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', providers: ['claude', 'opencode'] },
  { name: 'OPENAI_API_KEY', label: 'OpenAI API key', providers: ['codex', 'opencode'] },
  { name: 'CURSOR_API_KEY', label: 'Cursor API key', providers: ['cursor'] },
])

export function maskSecret(value) {
  const v = String(value || '')
  if (!v) return null
  return v.length <= 8 ? '••••' : `••••${v.slice(-4)}`
}

/** Settings -> AI: the agent CLI API keys. */
export function createAiSettings(options) {
  return createEnvBackedSettings({ ...options, keys: AI_KEYS.map((k) => ({ ...k, secret: true })) })
}

/**
 * @param {object} options
 * @param {string} options.file  e.g. data/ai-settings.json
 * @param {Array<{name: string, label: string, secret?: boolean}>} options.keys
 *        The names this store may hold. `secret: false` values are shown in full.
 * @param {object} [options.env] The environment to read overrides from and write values into.
 */
export function createEnvBackedSettings({ file, keys, env = process.env, log = () => {} }) {
  const KEYS = keys
  const KEY_NAMES = new Set(KEYS.map((k) => k.name))
  const isSecret = (name) => KEYS.find((k) => k.name === name)?.secret !== false
  // Snapshot of what the real environment set before anything here touched it.
  const fromEnv = new Set(KEYS.map((k) => k.name).filter((name) => env[name]))
  let stored = { keys: {} }

  function apply() {
    for (const name of KEY_NAMES) {
      if (fromEnv.has(name)) continue
      if (stored.keys[name]) env[name] = stored.keys[name]
      else delete env[name]
    }
  }

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      stored = { keys: {} }
      for (const [name, value] of Object.entries(parsed?.keys || {})) {
        if (KEY_NAMES.has(name) && typeof value === 'string' && value) stored.keys[name] = value
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log(`ai settings: could not read ${file}: ${e.message}`)
    }
    apply()
    return describe()
  }

  async function save() {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, file)
    await chmod(file, 0o600).catch(() => {})
  }

  function describe() {
    return KEYS.map((k) => {
      const source = fromEnv.has(k.name) ? 'env' : stored.keys[k.name] ? 'settings' : null
      const value = source ? env[k.name] : ''
      return { ...k, secret: isSecret(k.name), source, masked: isSecret(k.name) ? maskSecret(value) : (value || null) }
    })
  }

  /** `keys`: name -> string to store, or null/'' to remove the stored value. */
  async function updateKeys(keys = {}) {
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('keys must be an object')
    for (const [name, value] of Object.entries(keys)) {
      if (!KEY_NAMES.has(name)) throw new Error(`unknown key ${name}`)
      if (fromEnv.has(name)) throw new Error(`${name} is set in the server environment; change it there`)
      const v = typeof value === 'string' ? value.trim() : ''
      if (v.length > 4096) throw new Error(`${name} is too long`)
      if (v) stored.keys[name] = v
      else delete stored.keys[name]
    }
    await save()
    apply()
    return describe()
  }

  /** Names to keep out of interactive shells (the web terminal). */
  const secretNames = () => [...KEY_NAMES]

  return { load, describe, updateKeys, secretNames }
}

const AUTH_FAILURE = /\b(401|403|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|authentication (?:failed|error)|missing bearer|not logged ?in|no codex credentials|please (?:run )?\S* ?login|invalid x-api-key)\b/i

/**
 * If a CLI's output says its credentials were rejected, a sentence that says so
 * plainly; otherwise null. Used by the Settings -> AI Test button so a bad key
 * reads as a key problem rather than as "no output".
 */
export function authFailureMessage(text, { provider = 'This provider', fix = null } = {}) {
  const detail = String(text || '')
  if (!AUTH_FAILURE.test(detail)) return null
  const how = fix ? ` or run \`${fix}\` on the server` : ''
  return `${provider} rejected its credentials. Check the API key in Settings -> AI${how}.`
}
