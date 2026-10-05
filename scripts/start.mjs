#!/usr/bin/env node
// `npm start`: build the dashboard if it has not been built, then run the bridge
// in the foreground with .env loaded when there is one.
//
// This is the from-a-clone path. A long-running install uses the systemd unit
// (assistant-bridge.service) or docker compose instead; both run bridge.mjs
// directly.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const WEB = join(ROOT, 'web')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (!process.env.WEB_DIR && !existsSync(join(WEB, 'dist', 'index.html'))) {
  console.log('Building the dashboard (first run)…')
  if (!existsSync(join(WEB, 'node_modules'))) run(npm, ['install', '--no-audit', '--no-fund'], WEB)
  run(npm, ['run', 'build'], WEB)
}

const envFile = join(ROOT, '.env')
const args = [...(existsSync(envFile) ? [`--env-file=${envFile}`] : []), join(ROOT, 'bridge.mjs')]
const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0))
