// The `git-sync` runner: keep one repo's checkout current on several hosts.
//
// A watch on the repo wakes the job; each host then fetches the ref, fast-forwards
// (never merges, never touches uncommitted work a pull can leave alone) and runs an
// optional install script from the checkout. No agent is involved, so no sandbox or
// permission prompt can stop it, and the same steps run the same way every time.
//
// The host list is data, not code: the job's `gitSync` field in data/jobs.json, e.g.
//   { "hosts": [ { "name": "here" },
//                { "name": "laptop", "ssh": "laptop", "dir": "~/repo" } ],
//     "install": "scripts/install.sh" }
// A host without `ssh` runs on this machine, in `dir` or else the watched repo.

import { execFile } from 'node:child_process'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
// An ssh destination that can't be read as an option (`-oProxyCommand=…`).
const SSH_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/
const DIR_RE = /^(~|~\/[A-Za-z0-9._/-]*|\/[A-Za-z0-9._/-]*)$/
const INSTALL_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/
const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/
const MAX_HOSTS = 8

/** The saved config with anything unusable dropped, or null when nothing is left. */
export function cleanGitSync(raw) {
  if (!raw || typeof raw !== 'object') return null
  const seen = new Set()
  const hosts = []
  for (const h of Array.isArray(raw.hosts) ? raw.hosts : []) {
    const name = String(h?.name || '').trim()
    if (!NAME_RE.test(name) || seen.has(name)) continue
    const ssh = h.ssh ? String(h.ssh).trim() : null
    if (ssh && !SSH_RE.test(ssh)) continue
    const dir = h.dir ? String(h.dir).trim() : null
    if (dir && (!DIR_RE.test(dir) || dir.split('/').includes('..'))) continue
    // A remote host has no watched repo to fall back on.
    if (ssh && !dir) continue
    seen.add(name)
    hosts.push({ name, ssh, dir })
    if (hosts.length >= MAX_HOSTS) break
  }
  if (!hosts.length) return null
  const install = raw.install ? String(raw.install).trim() : null
  return {
    hosts,
    install: install && INSTALL_RE.test(install) && !install.split('/').includes('..') ? install : null,
  }
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const cdTarget = (dir) => (dir === '~' ? '"$HOME"' : dir.startsWith('~/') ? `"$HOME"/${shq(dir.slice(2))}` : shq(dir))

/**
 * The bash script one host runs. It prints `key=value` lines the parser reads,
 * and the installer's output (stderr too, which is where skips go) prefixed
 * `install: `. Fails on the first step that fails, so the error names it.
 */
export function hostScript({ dir, ref, install }) {
  if (!REF_RE.test(ref) || ref.split('/').includes('..')) throw new Error(`unusable ref "${ref}"`)
  return [
    'set -euo pipefail',
    'export GIT_TERMINAL_PROMPT=0',
    `cd ${cdTarget(dir)}`,
    'branch=$(git symbolic-ref --quiet --short HEAD || echo "(detached)")',
    `if [ "$branch" != ${shq(ref)} ]; then echo "the checkout is on $branch, not ${ref.replace(/[^A-Za-z0-9._/-]/g, '')}" >&2; exit 3; fi`,
    'echo "before=$(git rev-parse HEAD)"',
    `git -c protocol.ext.allow=never fetch --quiet origin ${shq(ref)}`,
    'echo "origin=$(git rev-parse FETCH_HEAD)"',
    'git merge --ff-only --quiet FETCH_HEAD',
    'echo "after=$(git rev-parse HEAD)"',
    ...(install ? [`bash ${shq(install)} 2>&1 | sed 's/^/install: /'`] : []),
  ].join('\n')
}

/** argv for one host: bash locally, or the same script through ssh. */
export function hostCommand(host, { repo, ref, install }) {
  const script = hostScript({ dir: host.dir || repo, ref, install })
  if (!host.ssh) return ['bash', ['-c', script]]
  return ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host.ssh, `bash -c ${shq(script)}`]]
}

/** Run one host's sync. Never throws: a failure is a result like any other. */
export function syncHost(host, { repo, ref, install, timeoutMs = 3 * 60_000 }) {
  return new Promise((resolve) => {
    let cmd, args
    try { [cmd, args] = hostCommand(host, { repo, ref, install }) } catch (e) { return resolve({ name: host.name, ok: false, error: e.message }) }
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ name: host.name, ok: true, out: parseHostOutput(stdout) })
      const tail = String(stderr || stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 300)
      resolve({ name: host.name, ok: false, error: err.killed ? 'timed out' : tail || err.message })
    })
  })
}

/** What one host's output says happened. */
export function parseHostOutput(stdout) {
  const out = { before: null, origin: null, after: null, linked: [], skipped: [] }
  for (const line of String(stdout).split('\n')) {
    const kv = /^(before|origin|after)=([0-9a-f]{7,64})$/.exec(line.trim())
    if (kv) { out[kv[1]] = kv[2]; continue }
    const inst = /^install: .*?(linking|relinking|skipping) '([^']+)'/.exec(line)
    if (!inst) continue
    if (inst[1] === 'skipping') out.skipped.push(inst[2])
    else out.linked.push(inst[2])
  }
  return out
}

const short = (sha) => (sha ? sha.slice(0, 7) : '?')

/**
 * One line per host plus the run's status. `results` is [{ name, ok, out?, error? }].
 * error: a host failed, skipped a skill, or ended somewhere other than the tip the
 * others fetched. ok: something moved or was linked. skipped: every host was
 * already current, which is most runs.
 */
export function summarizeGitSync(results) {
  const tips = new Set(results.filter((r) => r.ok && r.out.origin).map((r) => r.out.origin))
  const tip = tips.size === 1 ? [...tips][0] : null
  let failed = false
  let changed = false
  const lines = results.map((r) => {
    if (!r.ok) { failed = true; return `${r.name}: failed — ${r.error}` }
    const { before, after, linked, skipped } = r.out
    const bits = [before === after ? `already on ${short(after)}` : `${short(before)} → ${short(after)}`]
    if (before !== after) changed = true
    if (linked.length) { changed = true; bits.push(`linked ${linked.join(', ')}`) }
    if (skipped.length) { failed = true; bits.push(`skipped ${skipped.join(', ')} (a real file is in the way)`) }
    if (tip && after !== tip) { failed = true; bits.push(`not at the tip ${short(tip)}`) }
    return `${r.name}: ${bits.join(', ')}`
  })
  if (tips.size > 1) { failed = true; lines.push(`hosts fetched different tips: ${[...tips].map(short).join(', ')}`) }
  return { status: failed ? 'error' : changed ? 'ok' : 'skipped', tip, text: lines.join('\n') }
}
