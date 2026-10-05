// Kill an agent CLI and everything it started.
//
// SIGKILL on the CLI alone leaves its tools running: Cursor starts each shell
// command in a session of its own, so when cursor-agent dies the command is
// reparented to init and carries on (a `sleep 40` outlived a Stop by its full 40
// seconds; a build or a delete would too). Stop and steering both end runs
// mid-tool, so the whole tree goes. The tree is read from /proc before anything
// is killed, since a killed parent's children are reparented at once. Elsewhere
// (no /proc) only the CLI itself is killed.

import { readdirSync, readFileSync } from 'node:fs'

export function descendants(pid, { proc = '/proc' } = {}) {
  let entries
  try { entries = readdirSync(proc) } catch { return [] }
  const children = new Map()
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    let stat
    try { stat = readFileSync(`${proc}/${name}/stat`, 'utf8') } catch { continue }
    // `pid (comm) state ppid …`; comm may contain spaces and parentheses.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(Number(name))
  }
  const out = []
  const queue = [pid]
  while (queue.length) {
    for (const c of children.get(queue.shift()) || []) { out.push(c); queue.push(c) }
  }
  return out
}

export function killTree(child, signal = 'SIGKILL') {
  const below = child?.pid ? descendants(child.pid) : []
  try { child.kill(signal) } catch { /* already gone */ }
  for (const pid of below) {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
}
