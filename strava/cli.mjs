#!/usr/bin/env node
// strava/cli.mjs — Strava through the bridge, from a shell.
//
// This exists for the agent CLIs (cursor-agent, codex, claude, opencode) that
// Totem runs: they have a shell on this box and no MCP client we control, so
// "look at my rides" needs a command they can run. It talks to the BRIDGE, not
// to Strava — the bridge holds the only copy of the refresh token, so this never
// needs credentials of its own — and prints the JSON the bridge returns.
//
//   node strava/cli.mjs status
//   node strava/cli.mjs athlete
//   node strava/cli.mjs stats
//   node strava/cli.mjs activities [--days 30] [--sport ride|run|…] [--limit 50] [--after 2026-08-01] [--before 2026-09-01] [--source live|cache]
//   node strava/cli.mjs activity <id> [--laps] [--zones] [--efforts] [--streams heartrate,watts,altitude]
//   node strava/cli.mjs gear [id]
//   node strava/cli.mjs mileage [--group week|month|year|day|sport|family|gear|all] [--days 365] [--sport ride] [--gear b1234] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//   node strava/cli.mjs zones
//   node strava/cli.mjs routes [id]
//   node strava/cli.mjs segments [starred|detail|efforts|effort|explore] [--id N] [--bounds swLat,swLng,neLat,neLng]
//   node strava/cli.mjs clubs [id]
//   node strava/cli.mjs sync [--full] [--pages N]
//   node strava/cli.mjs update-activity <id> [--name …] [--description …] [--sport-type Ride] [--gear-id b1] [--commute true|false] [--trainer true|false]
//
// Config: BRIDGE_SECRET and BRIDGE_PORT from the environment, else from the
// repo's .env next to this file. --compact prints one-line JSON.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = join(import.meta.dirname, '..')

function envFrom(file) {
  const out = {}
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* no .env */ }
  return out
}

const fileEnv = envFrom(join(HERE, '.env'))
const SECRET = process.env.BRIDGE_SECRET || fileEnv.BRIDGE_SECRET
const PORT = process.env.BRIDGE_PORT || fileEnv.BRIDGE_PORT || '8787'
const BASE = process.env.BRIDGE_URL || `http://127.0.0.1:${PORT}`

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else { flags[key] = next; i++ }
    } else positional.push(a)
  }
  return { flags, positional }
}

async function call(path, { method = 'GET', body = null } = {}) {
  if (!SECRET) throw new Error('no BRIDGE_SECRET in the environment or .env')
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${SECRET}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

const qs = (obj) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, v === true ? '1' : String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

const USAGE = `usage: node strava/cli.mjs <command> [options]
commands: status | athlete | stats | zones | activities | activity <id> | gear [id] | mileage | routes [id]
          segments [mode] | clubs [id] | sync | update-activity <id>
run with --help for the option list in the file header.`

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const [cmd, arg] = positional
  if (!cmd || flags.help) { console.log(USAGE); process.exit(cmd ? 0 : 1) }
  let out
  switch (cmd) {
    case 'status': out = await call('/api/strava/status'); break
    case 'athlete': out = await call(`/api/strava/athlete${qs({ zones: flags.zones })}`); break
    case 'stats': out = await call('/api/strava/stats'); break
    case 'zones': out = await call('/api/strava/zones'); break
    case 'activities':
      out = await call(`/api/strava/activities${qs({ days: flags.days, sport: flags.sport, limit: flags.limit, after: flags.after, before: flags.before, source: flags.source, gear: flags.gear })}`)
      break
    case 'activity':
      if (!arg) throw new Error('activity needs an id')
      out = await call(`/api/strava/activity${qs({ id: arg, laps: flags.laps, zones: flags.zones, efforts: flags.efforts, streams: flags.streams, comments: flags.comments, kudos: flags.kudos })}`)
      break
    case 'gear': out = await call(`/api/strava/gear${qs({ id: arg })}`); break
    case 'mileage':
      out = await call(`/api/strava/mileage${qs({ group: flags.group, days: flags.days, sport: flags.sport, gear: flags.gear, from: flags.from, to: flags.to, sync: flags['no-sync'] ? '0' : undefined })}`)
      break
    case 'routes': out = await call(`/api/strava/routes${qs({ id: arg, streams: flags.streams })}`); break
    case 'segments':
      out = await call(`/api/strava/segments${qs({ mode: arg || flags.mode || 'starred', id: flags.id, bounds: flags.bounds, activityType: flags['activity-type'], page: flags.page, perPage: flags['per-page'] })}`)
      break
    case 'clubs': out = await call(`/api/strava/clubs${qs({ id: arg })}`); break
    case 'sync': out = await call('/api/strava/sync', { method: 'POST', body: { full: Boolean(flags.full), pages: flags.pages ? Number(flags.pages) : undefined } }); break
    case 'update-activity': {
      if (!arg) throw new Error('update-activity needs an id')
      const bool = (v) => (v === undefined ? undefined : String(v) === 'true')
      out = await call('/api/strava/activity', { method: 'PUT', body: { id: arg, name: flags.name, description: flags.description, sportType: flags['sport-type'], gearId: flags['gear-id'], commute: bool(flags.commute), trainer: bool(flags.trainer), hideFromHome: bool(flags['hide-from-home']) } })
      break
    }
    default:
      console.error(`unknown command "${cmd}"\n${USAGE}`)
      process.exit(1)
  }
  process.stdout.write(flags.compact ? `${JSON.stringify(out)}\n` : `${JSON.stringify(out, null, 2)}\n`)
}

main().catch((e) => { console.error(`strava: ${e.message || e}`); process.exit(1) })
