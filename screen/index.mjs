// The Screen: the desktop of the machine Totem runs on, in the dashboard and to
// agents. Off unless SCREEN_ENABLED=true.
//
// Two halves with different needs:
// - The viewer (relay.mjs) only needs a VNC server, which on a Mac is Screen
//   Sharing (System Settings → General → Sharing). No grant on Totem's side.
// - Screenshots for agents use macOS's `screencapture`, which needs Screen
//   Recording for the node binary running Totem. Like Apple data's Full Disk
//   Access, the grant belongs to the binary's real path, so a Homebrew node
//   upgrade silently drops it; status() names the path.

import { execFile as execFileCb } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const SHOT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_SIZE = 1600

function nodePath() {
  try { return realpathSync(process.execPath) } catch { return process.execPath }
}

const run = (file, args, opts = {}) => new Promise((resolve, reject) => {
  execFileCb(file, args, { timeout: 20_000, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stderr = String(stderr || ''); return reject(err) }
    resolve({ stdout: String(stdout), stderr: String(stderr) })
  })
})

/** Is something listening on host:port? */
function probePort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (ok) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

// `screencapture` without Screen Recording fails with "could not create image
// from display" (and exits 1), not a permission error.
const isPermissionError = (e) => /could not create image|not authorized|not permitted|declined/i.test(`${e?.stderr || ''} ${e?.message || ''}`)

export class ScreenError extends Error {
  constructor(message, status = 500, code = null) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function createScreen({
  enabled,
  platform = process.platform,
  host = '127.0.0.1',
  port = 5900,
  shotsDir = join(tmpdir(), 'totem-screen'),
  exec = run,
  probe = probePort,
  now = () => Date.now(),
} = {}) {
  const on = !!enabled
  const grantFix = () => `Give Screen Recording to ${nodePath()} (System Settings → Privacy & Security → Screen & System Audio Recording → +, then ⌘⇧G and paste the path), then restart Totem.`

  async function capture({ display = null, maxSize = DEFAULT_MAX_SIZE } = {}) {
    if (!on) throw new ScreenError('The screen is off. Set SCREEN_ENABLED=true.', 404, 'off')
    if (platform !== 'darwin') throw new ScreenError('Screenshots need Totem to run on a Mac.', 501, 'unsupported')
    await mkdir(shotsDir, { recursive: true })
    await prune()
    const file = join(shotsDir, `screen-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.png`)
    const args = ['-x', '-t', 'png']
    if (Number.isInteger(display) && display > 0) args.push('-D', String(display))
    try {
      await exec('/usr/sbin/screencapture', [...args, file])
    } catch (e) {
      if (isPermissionError(e)) throw new ScreenError(`Totem cannot capture the screen. ${grantFix()}`, 403, 'no-access')
      throw new ScreenError(`screencapture failed: ${(e?.stderr || e?.message || String(e)).trim()}`)
    }
    // Retina screens are 5K+ wide; a model reads a 1600px one just as well for a
    // fraction of the tokens. sips -Z caps the longest side and keeps the ratio.
    const size = Number(maxSize) > 0 ? Math.min(Math.max(Math.round(Number(maxSize)), 400), 6000) : null
    if (size) await exec('/usr/bin/sips', ['-Z', String(size), file]).catch(() => {})
    const dims = await exec('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).catch(() => null)
    const width = Number(/pixelWidth:\s*(\d+)/.exec(dims?.stdout || '')?.[1]) || null
    const height = Number(/pixelHeight:\s*(\d+)/.exec(dims?.stdout || '')?.[1]) || null
    return { imagePath: file, width, height, display: Number.isInteger(display) && display > 0 ? display : 1, takenAt: new Date(now()).toISOString() }
  }

  /** Delete screenshots older than a day, so the folder never grows without bound. */
  async function prune() {
    let names = []
    try { names = await readdir(shotsDir) } catch { return }
    await Promise.all(names.filter((n) => n.startsWith('screen-')).map(async (n) => {
      const p = join(shotsDir, n)
      try { if (now() - (await stat(p)).mtimeMs > SHOT_TTL_MS) await rm(p, { force: true }) } catch {}
    }))
  }

  /**
   * What works right now. `viewer` is the VNC server answering; `screenshots`
   * is a real throwaway capture, because the only reliable test for the grant
   * is trying.
   */
  async function status() {
    if (!on) return { enabled: false, state: 'off', detail: 'Set SCREEN_ENABLED=true to see and control this machine\'s screen from Totem.' }
    const listening = await probe(host, port)
    const viewer = listening
      ? { state: 'ready' }
      : { state: 'no-vnc', detail: platform === 'darwin'
          ? `Nothing is listening on ${host}:${port}. Turn on Screen Sharing (System Settings → General → Sharing).`
          : `Nothing is listening on ${host}:${port}. Start a VNC server there, or point SCREEN_VNC_PORT at one.` }
    let screenshots
    if (platform !== 'darwin') screenshots = { state: 'unsupported', detail: 'Screenshots need Totem to run on a Mac.' }
    else {
      try {
        const shot = await capture({ maxSize: 400 })
        await rm(shot.imagePath, { force: true })
        screenshots = { state: 'ready' }
      } catch (e) {
        screenshots = { state: e.code === 'no-access' ? 'no-access' : 'error', detail: e.message }
      }
    }
    const ready = viewer.state === 'ready' && screenshots.state === 'ready'
    return {
      enabled: true,
      state: ready ? 'ready' : (viewer.state === 'ready' || screenshots.state === 'ready') ? 'partial' : 'unavailable',
      platform,
      node: nodePath(),
      viewer,
      screenshots,
    }
  }

  return { enabled: on, host, port, shotsDir, capture, status }
}
