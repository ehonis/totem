// "Is this an existing install?" — judged once at startup, before anything is
// written, from data a previous version of Totem would have left behind. Defaults
// that are off on a fresh install but were on before they became settings stay on
// when this says yes (see ensureUsageOptIns in ai-usage/registry.mjs).
//
// Each file is looked for where this install keeps it: an env override when set
// (TODO_DATABASE_FILE, PROVIDER_CONFIG_FILE, …), otherwise the default under data/.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const MARKERS = [
  ['JOBS_FILE', 'jobs.json'],
  ['PROVIDER_CONFIG_FILE', 'provider-config.json'],
  ['TODO_DATABASE_FILE', 'todos.db'],
  ['AI_USAGE_CONFIG', 'ai-usage.json'],
  ['HABITS_FILE', 'habits.json'],
  ['MCP_MANIFEST_FILE', 'mcp-manifest.json'],
  ['STUDIO_STATE_FILE', 'studio-state.json'],
]

/** The paths to check, with env overrides applied. */
export function installMarkerPaths(root, env = process.env) {
  return MARKERS.map(([name, file]) => (env[name] ? env[name] : join(root, 'data', file)))
}

export function isExistingInstall(root, { env = process.env, exists = existsSync } = {}) {
  return installMarkerPaths(root, env).some((path) => exists(path))
}
