// Kill an agent CLI and everything it started.
//
// SIGKILL on the CLI alone leaves its tools running: Cursor starts each shell
// command in a session of its own, so when cursor-agent dies the command is
// reparented to init and carries on (a `sleep 40` outlived a Stop by its full 40
// seconds; a build or a delete would too). Stop and steering both end runs
// mid-tool, so the whole tree goes. The tree is read before anything is killed,
// since a killed parent's children are reparented at once: from /proc, or from
// `ps` where there is none (macOS).
//
// The CLI we spawn is often a launcher, not the agent: npm's `codex` is a Node
// script that starts the native binary with inherited stdio. SIGKILL cannot be
// forwarded, so killing the launcher left the real codex running, holding our
// pipes open; the run never closed and Stop did nothing. Agent CLIs therefore
// start in a process group of their own (AGENT_SPAWN, then trackAgent), and the whole group is
// killed. A group outlives its leader, so this still reaches a binary whose
// launcher has already died and which is no longer anyone's descendant.

import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/** Spawn options for an agent CLI: its own process group, so killTree can take all of it. */
export const AGENT_SPAWN = process.platform === 'win32' ? {} : { detached: true }

// After a kill, how long to wait for the child's pipes to close before letting go
// of them, so a run always settles even if something holding them survived.
const RELEASE_MS = 5000

// [pid, ppid] for every process.
function parentPairs(proc) {
  let entries = null
  try { entries = readdirSync(proc) } catch { /* no /proc */ }
  if (entries) {
    const pairs = []
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue
      let stat
      try { stat = readFileSync(`${proc}/${name}/stat`, 'utf8') } catch { continue }
      // `pid (comm) state ppid …`; comm may contain spaces and parentheses.
      pairs.push([Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])])
    }
    return pairs
  }
  if (process.platform === 'win32') return []
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 })
      .split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([a, b]) => a > 0 && b >= 0)
  } catch { return [] }
}

export function descendants(pid, { proc = '/proc' } = {}) {
  const children = new Map()
  for (const [p, ppid] of parentPairs(proc)) {
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(p)
  }
  const out = []
  const queue = [pid]
  while (queue.length) {
    for (const c of children.get(queue.shift()) || []) { out.push(c); queue.push(c) }
  }
  return out
}

// A group of its own also means the agent no longer dies with the bridge: launchd
// and a terminal's Ctrl-C signal the bridge's group, not this one. So agents are
// tracked until their pipes close (not until the launcher exits: the binary may
// outlive it) and killed when the bridge goes.
const live = new Set()
let hooked = false
const killAll = () => { for (const child of live) killTree(child) }

export function trackAgent(child) {
  live.add(child)
  child.once('close', () => live.delete(child))
  if (hooked) return
  hooked = true
  process.once('exit', killAll)
  // Not SIGHUP: under nohup it is ignored, and a handler would make it fatal.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    // Re-raised once the handler is gone, so the bridge still dies of it as before.
    process.once(sig, () => { killAll(); process.kill(process.pid, sig) })
  }
}

export function killTree(child, signal = 'SIGKILL') {
  const pid = child?.pid
  const below = pid ? descendants(pid) : []
  // The CLI's process group (AGENT_SPAWN). For a child spawned without one there
  // is no such group and this throws, harmlessly.
  if (pid && process.platform !== 'win32') {
    try { process.kill(-pid, signal) } catch { /* no group, or already gone */ }
  }
  try { child.kill(signal) } catch { /* already gone */ }
  for (const p of below) {
    try { process.kill(p, signal) } catch { /* already gone */ }
  }
  if (child?.stdout || child?.stderr) {
    setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy() }, RELEASE_MS).unref?.()
  }
}
