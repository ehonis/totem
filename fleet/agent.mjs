#!/usr/bin/env node
// fleet/agent.mjs — reports this machine to a Totem's Fleet tab.
//
//   node fleet/agent.mjs --url https://totem.example --token <token>   run in the foreground
//   node fleet/agent.mjs --install --url … --token … [--name "Desk PC"] install as a service (Linux, systemd --user)
//   node fleet/agent.mjs --uninstall
//   node fleet/agent.mjs --rapl-rule        print the one-time root rule that lets it measure CPU power
//
// The URL and token are shown in the Fleet tab under "Add a machine". The machine
// Totem itself runs on needs no agent. Needs only node 20+; the installer copies
// this file, collect.mjs and power.mjs to ~/.local/share/totem-fleet so the
// service does not depend on a checkout that changes branch.
import { createCollector } from './collect.mjs'
import { copyFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { homedir, hostname, userInfo } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name, env) => {
  const i = args.indexOf(`--${name}`)
  return (i >= 0 ? args[i + 1] : '') || process.env[env] || ''
}

const INSTALL_DIR = join(homedir(), '.local/share/totem-fleet')
const ENV_FILE = join(homedir(), '.config/totem-fleet/agent.env')
const UNIT = 'totem-fleet-agent.service'
const UNIT_FILE = join(homedir(), '.config/systemd/user', UNIT)

function raplRule() {
  const group = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim()
  const rule = `z /sys/class/powercap/intel-rapl:*/energy_uj 0440 root ${group} - -`
  console.log(`# Lets members of "${group}" read the CPU energy counter (RAPL), so the Fleet tab
# measures CPU power instead of estimating it. Kept across reboots by systemd-tmpfiles.
# (RAPL is root-only by default because power readings can leak information to
# other local users; on a single-user machine that does not apply.)
echo '${rule}' | sudo tee /etc/tmpfiles.d/totem-fleet-rapl.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/totem-fleet-rapl.conf`)
}

async function install() {
  if (process.platform !== 'linux') {
    console.error('--install sets up a systemd user service and is Linux-only. On macOS, run the agent from a LaunchAgent.')
    process.exit(1)
  }
  const url = opt('url', 'FLEET_URL')
  const token = opt('token', 'FLEET_TOKEN')
  if (!url || !token) { console.error('--install needs --url and --token (from the Fleet tab)'); process.exit(1) }
  await mkdir(INSTALL_DIR, { recursive: true })
  for (const f of ['agent.mjs', 'collect.mjs', 'power.mjs']) await copyFile(join(HERE, f), join(INSTALL_DIR, f))
  await writeFile(join(INSTALL_DIR, 'package.json'), '{"type":"module"}\n')
  await mkdir(dirname(ENV_FILE), { recursive: true })
  const lines = [`FLEET_URL=${url}`, `FLEET_TOKEN=${token}`]
  if (opt('name', 'FLEET_NAME')) lines.push(`FLEET_NAME=${opt('name', 'FLEET_NAME')}`)
  if (opt('id', 'FLEET_ID')) lines.push(`FLEET_ID=${opt('id', 'FLEET_ID')}`)
  await writeFile(ENV_FILE, `${lines.join('\n')}\n`, { mode: 0o600 })
  await mkdir(dirname(UNIT_FILE), { recursive: true })
  await writeFile(UNIT_FILE, `[Unit]
Description=Totem Fleet agent (reports this machine to Totem)
After=network-online.target

[Service]
ExecStart=${process.execPath} ${join(INSTALL_DIR, 'agent.mjs')}
EnvironmentFile=${ENV_FILE}
Restart=always
RestartSec=10
Nice=10

[Install]
WantedBy=default.target
`)
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
  execFileSync('systemctl', ['--user', 'enable', '--now', UNIT], { stdio: 'inherit' })
  execFileSync('systemctl', ['--user', 'restart', UNIT], { stdio: 'inherit' })
  let linger = ''
  try { linger = execFileSync('loginctl', ['show-user', userInfo().username, '-p', 'Linger', '--value'], { encoding: 'utf8' }).trim() } catch {}
  console.log(`Installed ${UNIT}. Logs: journalctl --user -u ${UNIT} -f`)
  if (linger !== 'yes') console.log(`To keep it running while logged out: sudo loginctl enable-linger ${userInfo().username}`)
}

async function uninstall() {
  try { execFileSync('systemctl', ['--user', 'disable', '--now', UNIT], { stdio: 'inherit' }) } catch {}
  await rm(UNIT_FILE, { force: true })
  await rm(INSTALL_DIR, { recursive: true, force: true })
  await rm(dirname(ENV_FILE), { recursive: true, force: true })
  try { execFileSync('systemctl', ['--user', 'daemon-reload']) } catch {}
  console.log('Removed the Fleet agent.')
}

async function run() {
  const url = opt('url', 'FLEET_URL').replace(/\/+$/, '')
  const token = opt('token', 'FLEET_TOKEN')
  if (!url || !token) { console.error('Needs --url and --token (or FLEET_URL / FLEET_TOKEN). See the Fleet tab, "Add a machine".'); process.exit(1) }
  const collector = createCollector({ id: opt('id', 'FLEET_ID') || hostname().replace(/\.local$/, ''), name: opt('name', 'FLEET_NAME') || null })
  let processes = false
  let failures = 0
  const stop = () => { collector.stop(); process.exit(0) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  for (;;) {
    let wait = 15_000
    try {
      const snap = await collector.sample({ processes })
      const res = await fetch(`${url}/api/fleet/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(snap),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status === 401) { console.error('Totem refused the token; get a new one from the Fleet tab.'); wait = 5 * 60_000 }
      else if (res.status === 404) { wait = 60_000 } // Fleet is switched off
      else if (!res.ok) throw new Error(`HTTP ${res.status}`)
      else {
        const reply = await res.json()
        processes = !!reply.processes
        wait = Math.max(1000, Math.min(120_000, Number(reply.next) || 15_000))
        if (failures) console.log('Reporting again.')
        failures = 0
      }
    } catch (e) {
      if (!failures++) console.error(`Could not reach Totem: ${e.message}`)
      wait = Math.min(60_000, 5000 * failures)
    }
    await new Promise((r) => setTimeout(r, wait))
  }
}

if (flag('rapl-rule')) raplRule()
else if (flag('install')) await install()
else if (flag('uninstall')) await uninstall()
else await run()
