#!/usr/bin/env node
// notify/cli.mjs — see what Totem would say, before it can say anything.
//
//   node notify/cli.mjs preview             today's plan, as the morning run would build it
//   node notify/cli.mjs preview --evening   as the evening run would build it
//   node notify/cli.mjs preview --at "2026-09-11 18:00"
//   node notify/cli.mjs facts               every fact the collectors found, ranked
//   node notify/cli.mjs preview --json
//   node notify/cli.mjs keys               generate a VAPID key pair for .env
//
// This is the development surface for phase 1: the collectors and the planner can
// be built and argued with against real data without a single push being sent, and
// without the bridge being involved at all.
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localParts, zonedToUtc } from '../jobs/schedule.mjs'
import { parsePeople, birthdayFacts, habitFacts, metricFacts, goalFacts, taskFacts } from './signals.mjs'
import { closeTodoDatabase, openTodoDatabase } from '../todos/db.mjs'
import { createGoalService } from '../goals/service.mjs'
import { createTodoService } from '../todos/service.mjs'
import { planDay } from './plan.mjs'
import { generateVapidKeys } from './push.mjs'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const TZ = process.env.MORNING_BRIEFING_TZ || 'America/New_York'
const MEMORY_ROOT = process.env.MEMORY_ROOT || join(HERE, 'data', 'brain')
const HABITS_FILE = process.env.HABITS_FILE || join(HERE, 'data', 'habits.json')
const TODO_DATABASE_FILE = process.env.TODO_DATABASE_FILE || join(HERE, 'data', 'todos.db')

const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}
const readText = async (path) => {
  try { return await readFile(path, 'utf8') } catch { return '' }
}

// Collect every fact from real state. Deliberately the same call the digest runner
// will make, so what this prints is what would actually be planned.
// This week's goals, or null when the database cannot be opened. Null rather than an
// empty array on purpose: `goalFacts` treats null as "nothing was read" and stays
// silent, where an empty array would mean "he set no goals" — and quietly telling him
// he has no goals because a file was locked is worse than saying nothing.
//
// Strava is deliberately not passed. A preview run must not spend an API read, and a
// metric it cannot resolve reports unavailable, which `goalFacts` already skips.
// Goals and todos share data/todos.db, so they are read in one open/close rather
// than opening it twice. Both return null on failure for the same reason: null is
// "nothing was read", where an empty array is the claim that he has nothing, and
// quietly telling him his board is clear because a file was locked is worse than
// saying nothing.
async function readDatabase() {
  let db = null
  try {
    db = openTodoDatabase({ file: TODO_DATABASE_FILE })
    const actionLog = { record() {} }
    const goalService = createGoalService({ db, actionLog, strava: null, timeZone: TZ })
    const todoService = createTodoService({ db, actionLog })
    return {
      goals: await goalService.listGoals({ period: 'this_week', includeCompleted: false }),
      tasks: todoService.list({}),
    }
  } catch {
    return { goals: null, tasks: null }
  } finally {
    if (db) { try { closeTodoDatabase(db) } catch { /* already gone */ } }
  }
}

// Quota facts (notify/usage.mjs) are deliberately absent. They read the poller's
// last snapshot, which lives in the bridge process; collecting them here would
// mean this command hitting Anthropic, OpenAI and Cursor to print a preview.
export async function collectFacts({ now, tz }) {
  const [habitsState, peopleMd, { goals, tasks }] = await Promise.all([
    readJson(HABITS_FILE, { habits: [], entries: {} }),
    readText(join(MEMORY_ROOT, 'people', 'people.md')),
    readDatabase(),
  ])
  const habits = habitsState.habits || []
  const entries = habitsState.entries || {}
  return [
    ...birthdayFacts({ people: parsePeople(peopleMd), now, tz }),
    ...habitFacts({ habits, entries, now, tz }),
    ...metricFacts({ habits, entries, now, tz }),
    ...goalFacts({ goals, now, tz }),
    ...taskFacts({ tasks, now, tz }),
  ]
}

function parseAt(value, tz) {
  if (!value) return Date.now()
  const m = String(value).match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)$/)
  if (!m) {
    const ts = Date.parse(value)
    if (Number.isFinite(ts)) return ts
    throw new Error(`could not read --at "${value}" — use "YYYY-MM-DD HH:MM"`)
  }
  return zonedToUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, tz)
}

const clock = (ts) => {
  const p = localParts(ts, TZ)
  const suffix = p.hour < 12 ? 'am' : 'pm'
  const hour = p.hour % 12 === 0 ? 12 : p.hour % 12
  return `${hour}:${String(p.minute).padStart(2, '0')}${suffix}`
}
const date = (ts) => {
  const p = localParts(ts, TZ)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

async function main() {
  const args = process.argv.slice(2)
  const command = args.find((a) => !a.startsWith('-')) || 'preview'
  const flag = (name) => args.includes(`--${name}`)
  const value = (name) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : null
  }

  if (command === 'keys') {
    const { publicKey, privateKey } = generateVapidKeys()
    console.log('\nAdd these to .env. Rotating the private key later invalidates every')
    console.log('existing subscription and every device has to re-subscribe — the symptom')
    console.log('is silence, not an error.\n')
    console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
    console.log(`VAPID_PRIVATE_KEY=${privateKey}`)
    console.log('VAPID_SUBJECT=mailto:you@example.com\n')
    return
  }

  const now = parseAt(value('at'), TZ)
  const source = flag('evening') ? 'evening-digest' : 'daily-digest'
  const facts = await collectFacts({ now, tz: TZ })

  if (command === 'facts') {
    if (flag('json')) return console.log(JSON.stringify(facts, null, 2))
    console.log(`\n${facts.length} fact(s) at ${clock(now)} on ${date(now)} (${TZ})\n`)
    for (const f of [...facts].sort((a, b) => b.salience - a.salience)) {
      console.log(`  ${String(f.salience).padStart(3)}  ${f.category.padEnd(18)} ${f.title}`)
      if (f.body) console.log(`       ${f.body}`)
    }
    console.log('')
    return
  }

  if (command !== 'preview') {
    console.error('usage: node notify/cli.mjs [preview|facts|keys] [--evening] [--at "YYYY-MM-DD HH:MM"] [--json]')
    process.exitCode = 64
    return
  }

  const plan = planDay({ facts, now, tz: TZ, settings: {}, source })
  if (flag('json')) return console.log(JSON.stringify(plan, null, 2))

  console.log(`\n  ${source} · planned at ${clock(now)} on ${plan.planDate} (${TZ})`)
  console.log(`  cap ${plan.settings.cap}, min gap ${plan.settings.minGapMinutes}m, quiet ${plan.settings.quietHours ? `${plan.settings.quietHours.start}–${plan.settings.quietHours.end}` : 'off'}\n`)

  if (!plan.entries.length) {
    console.log('  Nothing worth sending. No digest, no push — a quiet day is a skipped run.\n')
  }
  for (const e of plan.entries) {
    const when = date(e.deliverAt) === plan.planDate ? clock(e.deliverAt) : `${clock(e.deliverAt)} +1d`
    const pin = e.pinned ? ' [pinned]' : ''
    console.log(`  ${when.padStart(9)}  ${e.title}${pin}`)
    if (e.body) console.log(`             ${e.body}`)
    console.log(`             ${e.category} · ${e.slot} · salience ${e.salience}${e.weight !== 1 ? ` × ${e.weight}` : ''}${e.revalidate ? ` · revalidate ${e.revalidate.factKey}` : ''}`)
    console.log('')
  }
  if (plan.dropped.length) {
    console.log(`  Not sent (${plan.dropped.length}) — visible in the notification centre only:`)
    for (const d of plan.dropped) console.log(`    ${d.reason.padEnd(12)} ${d.fact.title}`)
    console.log('')
  }
}

main().catch((e) => {
  console.error(e.message || e)
  process.exitCode = 1
})
