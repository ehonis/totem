#!/usr/bin/env node
// Runs pnpm with the given arguments: the `pnpm` on PATH if there is one, otherwise
// Corepack's (`corepack pnpm`, which ships with Node 22 and 24 and fetches the version
// package.json pins). The root package.json scripts go through this so that an install
// still driven by npm (an older self-update pulling the move to pnpm) can finish it.
//
//   node scripts/pnpm.mjs --dir web install

import { execFile, spawnSync } from 'node:child_process'
import { isEntry } from './is-entry.mjs'

const WIN = process.platform === 'win32'

function works(cmd, args) {
  const r = spawnSync(cmd, [...args, '--version'], { stdio: 'ignore', shell: WIN, env: corepackEnv() })
  return !r.error && r.status === 0
}

// Corepack asks before downloading a package manager when it has a terminal; a script
// has nobody to answer.
function corepackEnv() {
  return { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }
}

/** `{ cmd, args }` to run pnpm with (prepend `args`), or null when there is no pnpm. */
export function resolvePnpm() {
  if (works('pnpm', [])) return { cmd: 'pnpm', args: [] }
  if (works('corepack', ['pnpm'])) return { cmd: 'corepack', args: ['pnpm'] }
  return null
}

/** resolvePnpm without blocking: for the bridge, which must keep serving while it looks. */
export async function resolvePnpmAsync() {
  const works = (cmd, args) => new Promise((done) => {
    execFile(cmd, [...args, '--version'], { shell: WIN, env: corepackEnv(), timeout: 60_000 }, (err) => done(!err))
  })
  if (await works('pnpm', [])) return { cmd: 'pnpm', args: [] }
  if (await works('corepack', ['pnpm'])) return { cmd: 'corepack', args: ['pnpm'] }
  return null
}

export const NO_PNPM = 'pnpm was not found, and neither was Corepack to supply it. Install pnpm (`corepack enable pnpm`, or https://pnpm.io/installation) and put it on this PATH.'

if (isEntry(import.meta.url)) {
  const pnpm = resolvePnpm()
  if (!pnpm) {
    console.error(NO_PNPM)
    process.exit(1)
  }
  const r = spawnSync(pnpm.cmd, [...pnpm.args, ...process.argv.slice(2)], { stdio: 'inherit', shell: WIN, env: corepackEnv() })
  if (r.error) console.error(r.error.message)
  process.exit(r.status ?? 1)
}
