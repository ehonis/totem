// Which service manager runs this bridge, so Deploy Totem can restart it.
//
// Linux: a systemd --user unit (TOTEM_SERVICE_NAME, default assistant-bridge).
// macOS: a launchd agent. launchd hands every job it starts its own label in
// XPC_SERVICE_NAME, so no setting is needed; TOTEM_SERVICE_NAME, when set, wins.
//
// Like INVOCATION_ID, XPC_SERVICE_NAME is inherited by anything the service
// starts, so "I have a label" does not mean "I am the service". The caller must
// still compare the manager's pid for the job with its own (see AGENTS.md ›
// Gotchas).

/** `{ kind: 'systemd', unit }`, `{ kind: 'launchd', label, domain }`, or null. */
export function serviceTarget({ platform = process.platform, env = process.env, uid = process.getuid?.() } = {}) {
  const configured = (env.TOTEM_SERVICE_NAME || '').trim()
  if (platform === 'darwin') {
    const label = configured || (env.XPC_SERVICE_NAME || '').trim()
    // launchd gives one-off processes a placeholder label of "0".
    if (!label || label === '0' || uid == null) return null
    return { kind: 'launchd', label, domain: `gui/${uid}` }
  }
  return { kind: 'systemd', unit: configured || 'assistant-bridge' }
}

/** The running pid from `launchctl print <domain>/<label>`, or 0. */
export function parseLaunchdPid(text) {
  const m = /^\s*pid = (\d+)\s*$/m.exec(String(text || ''))
  return m ? Number(m[1]) : 0
}

/** The command that reports the service's main pid. */
export function pidCommand(target) {
  return target.kind === 'launchd'
    ? ['launchctl', ['print', `${target.domain}/${target.label}`]]
    : ['systemctl', ['--user', 'show', '--property=MainPID', '--value', target.unit]]
}

/** Read the pid out of what pidCommand printed. */
export function parsePid(target, out) {
  return target.kind === 'launchd' ? parseLaunchdPid(out) : Number(String(out || '').trim()) || 0
}

/**
 * The command that restarts the service. `kickstart -k` kills the running job
 * (this process) and starts it again, so it must be spawned detached.
 */
export function restartCommand(target) {
  return target.kind === 'launchd'
    ? ['launchctl', ['kickstart', '-k', `${target.domain}/${target.label}`]]
    : ['systemctl', ['--user', 'restart', '--no-block', target.unit]]
}

export function serviceName(target) {
  return target ? (target.kind === 'launchd' ? target.label : target.unit) : 'the service'
}
