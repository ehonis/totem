// Run with: node --test jobs/defaults.test.mjs
//
// A fresh install is a blank canvas: nothing scheduled runs until its owner turns
// it on, and nothing shipped encodes one particular person's life. These checks
// read the shipped defaults (the seed job table in bridge.mjs, the skill seeds and
// .env.example) the same way todos/prompt-surfaces.test.mjs reads prompt text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createJobStore } from './store.mjs'

const ROOT = join(import.meta.dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

function seedJobBlock() {
  const bridge = read('bridge.mjs')
  const start = bridge.indexOf('const SEED_JOB_DEFS = {')
  const end = bridge.indexOf('\n}\n', start)
  assert.notEqual(start, -1, 'SEED_JOB_DEFS not found in bridge.mjs')
  return bridge.slice(start, end)
}

// Local housekeeping for the task board. Both only apply the owner's own saved
// archive/retention preferences, which are off until set, and touch nothing
// outside the local database.
const ALWAYS_ON = new Set(['todo-maintenance', 'todo-archive'])

test('every shipped job is off unless an env flag or deliberate setup turns it on', () => {
  const block = seedJobBlock()
  const jobs = [...block.matchAll(/\n  '?([a-z-]+)'?: \{[\s\S]*?\n    enabled: ([^\n]+),/g)]
  assert.ok(jobs.length >= 10, `expected the seed jobs, found ${jobs.length}`)
  for (const [, id, enabled] of jobs) {
    if (ALWAYS_ON.has(id)) {
      assert.equal(enabled.trim(), 'true', id)
      continue
    }
    assert.match(
      enabled,
      /^(isTruthyFlag\([A-Z_.a-z]+\)|GITHUB_APP_CONFIGURED \|\| isTruthyFlag\(process\.env\.GITHUB_TODOS_SYNC_ENABLED\)|TASK_SHEET_CONFIGURED)$/,
      `${id} must default to off on a fresh install (enabled: ${enabled})`,
    )
  }
})

test('.env.example switches no scheduled job on', () => {
  const env = read('.env.example')
  const on = env.split('\n').filter((l) => /^[A-Z_]+_(ENABLED|SYNC_ENABLED)=\s*(true|1|yes)\b/i.test(l))
  // Weather and news are data sources the brief reads, not schedules.
  assert.deepEqual(on.filter((l) => !/^(WEATHER|NEWS)_ENABLED=/.test(l)), [])
})

test('a fresh job store, given env-off seeds, has nothing enabled but housekeeping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totem-jobs-'))
  const seedDefs = {
    'daily-brief': { name: 'Daily brief', runner: 'morning-brief', enabled: false, schedule: { type: 'daily', time: '07:30' } },
    'todo-archive': { name: 'Archive', runner: 'todo-archive', enabled: true, schedule: { type: 'interval', everyMinutes: 15 } },
  }
  const store = createJobStore({
    file: join(dir, 'jobs.json'), runsFile: join(dir, 'runs.jsonl'), notificationsFile: join(dir, 'n.json'),
    seedDefs, runners: { 'morning-brief': {}, 'todo-archive': { agentless: true } }, tz: 'UTC',
  })
  const jobs = await store.list()
  assert.deepEqual(jobs.filter((j) => j.enabled).map((j) => j.id), ['todo-archive'])
})

test('shipped skill seeds name no particular person, venture or employer', () => {
  const dir = join(ROOT, 'skills', 'seeds')
  for (const id of readdirSync(dir)) {
    const text = readFileSync(join(dir, id, 'SKILL.md'), 'utf8')
    assert.doesNotMatch(text, /\bEthan\b|venture: [A-Z]/i, `skills/seeds/${id}`)
  }
})
