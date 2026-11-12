#!/usr/bin/env node
// Set or rotate the approval code from a terminal on the server:
//
//   npm run approval-code          (or: node auth/approval-code-cli.mjs)
//
// Refuses to run without a terminal on both ends, so an agent's shell (a pipe)
// cannot mint a code. A terminal alone is a speed bump (`script` makes one), so
// whenever an owner account exists it asks for the owner's password, which no
// agent holds, whatever TOTEM_AUTH the caller's environment says. Only an install
// with no owner that the bridge itself recorded as running behind an auth proxy
// (`authMode` in data/auth.json) skips it; the terminal is then the only check.
//
// Reads the same files as the bridge: AUTH_FILE and APPROVAL_CODE_FILE from the
// checkout's .env (what `npm start` loads), or their defaults under data/. Never
// from the caller's environment: pointing AUTH_FILE at a file with no owner would
// otherwise decide whether the password is asked. The running bridge loads the new
// code when it next starts; until then it sees a file it did not write and refuses
// approvals as tampered.

import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parseEnv } from 'node:util'
import { createOwnerAuth } from './owner.mjs'
import { createApprovalCode } from './approval-code.mjs'
import { isEntry } from '../scripts/is-entry.mjs'

const ROOT = join(import.meta.dirname, '..')

/** The bridge's own paths: the checkout's .env, then the defaults. */
export function configuredPaths(envFile = join(ROOT, '.env')) {
  let env = {}
  try { env = parseEnv(readFileSync(envFile, 'utf8')) } catch { /* no .env: the defaults */ }
  const at = (value, fallback) => (value ? (isAbsolute(value) ? value : join(ROOT, value)) : fallback)
  return {
    authFile: at(env.AUTH_FILE, join(ROOT, 'data', 'auth.json')),
    codeFile: at(env.APPROVAL_CODE_FILE, join(ROOT, 'data', 'approval-code.json')),
  }
}

export function hasTerminal(stdin = process.stdin, stdout = process.stdout) {
  return Boolean(stdin?.isTTY && stdout?.isTTY)
}

/** Read a line without echoing it. */
function askHidden(prompt, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    stdout.write(prompt)
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done()
        if (ch === '\u0003') return done(new Error('cancelled'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    const done = (error) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    stdin.on('data', onData)
  })
}

export async function runApprovalCodeCli({
  envFile = join(ROOT, '.env'),
  stdin = process.stdin,
  stdout = process.stdout,
  ask = (prompt) => askHidden(prompt, { stdin, stdout }),
} = {}) {
  if (!hasTerminal(stdin, stdout)) {
    throw new Error('approval-code needs an interactive terminal: run it yourself in a shell on the server, not from a script or an agent.')
  }
  const { authFile, codeFile } = configuredPaths(envFile)
  const auth = createOwnerAuth({ file: authFile })
  await auth.load()
  if (auth.hasOwner()) {
    const password = await ask('Owner password: ')
    await auth.confirmPassword({ headers: {}, socket: { remoteAddress: 'cli' } }, password)
  } else if (auth.approvalPolicy()?.authMode !== 'proxy') {
    throw new Error('There is no owner account yet. Create it with the setup link the bridge prints, then set the code.')
  }
  const code = createApprovalCode({
    file: codeFile,
    policy: { read: () => auth.approvalPolicy(), write: (patch) => auth.updateApprovalPolicy(patch) },
  })
  const { code: value } = await code.set()
  stdout.write([
    '',
    `  Approval code: ${value}`,
    '',
    '  Shown once. Restart Totem to load it: until then the running bridge sees a',
    '  file it did not write, refuses approvals and tells you so. Then enter it on',
    '  each device that approves (Settings → Security → Approval code). Any code set',
    '  before this one no longer works.',
    '',
  ].join('\n'))
  return value
}

if (isEntry(import.meta.url)) {
  runApprovalCodeCli().catch((e) => {
    console.error(e.message || String(e))
    process.exit(1)
  })
}
