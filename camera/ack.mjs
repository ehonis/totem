#!/usr/bin/env node
// Retire photos the Mac has confirmed are in Apple Photos.
//
// Runs on the Linux box, over ssh, as the owner — not as root and not from udev.
// Reads staging-relative paths on stdin, one per line, and moves each out of
// staging into the archive.
//
// Moving rather than deleting is the point. Staging means "not yet in iCloud",
// so what's left in it is exactly the backlog Totem reports on, and the archive
// is a second copy of every photo that isn't the memory card.

import { mkdir, rename, stat, appendFile } from 'node:fs/promises'
import { dirname, join, normalize, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stagingDir, archiveDir, stateDir } from './paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const STAGING = stagingDir()
const ARCHIVE = archiveDir()
const STATE_DIR = stateDir(ROOT)
const ACK_LOG = join(STATE_DIR, 'camera-acks.jsonl')

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Keep a path inside staging.
 *
 * This is the one place where input arrives over ssh from another machine, so a
 * path is not trusted to be what it claims. `../../.ssh/authorized_keys` as a
 * "relative path" would otherwise move a file out of the user's home.
 */
function safeTarget(rel) {
  const cleaned = normalize(rel.trim().replace(/^\/+/, ''))
  if (!cleaned || cleaned === '.' || isAbsolute(cleaned)) return null
  const full = join(STAGING, cleaned)
  const back = relative(STAGING, full)
  if (back.startsWith('..') || isAbsolute(back)) return null
  return { rel: cleaned, full }
}

export async function ackPaths(lines) {
  let moved = 0
  let missing = 0
  let rejected = 0

  for (const line of lines) {
    const target = safeTarget(line)
    if (!target) { rejected++; console.error(`refused: ${line}`); continue }
    if (!(await stat(target.full).catch(() => null))) { missing++; continue }
    const dest = join(ARCHIVE, target.rel)
    await mkdir(dirname(dest), { recursive: true })
    try {
      await rename(target.full, dest)
      moved++
    } catch (err) {
      // Staging and archive are siblings, so rename is a same-filesystem move.
      // If that fails it's a real problem and the file stays in staging, which
      // means it stays in the backlog — the safe direction to fail in.
      console.error(`could not archive ${target.rel}: ${err.message}`)
    }
  }

  if (moved) {
    await mkdir(STATE_DIR, { recursive: true })
    await appendFile(ACK_LOG, `${JSON.stringify({ at: new Date().toISOString(), moved, missing, rejected })}\n`)
  }
  return { moved, missing, rejected }
}

async function main() {
  const lines = (await readStdin()).split('\n').map((l) => l.trim()).filter(Boolean)
  const { moved, missing, rejected } = await ackPaths(lines)
  console.log(`archived ${moved}, already gone ${missing}, refused ${rejected}`)
  if (rejected) process.exitCode = 1
}

// Importable for tests, executable over ssh.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}

export { safeTarget, STAGING, ARCHIVE }
