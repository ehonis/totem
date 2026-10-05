// Integrity checks on the skills that ship in skills/seeds/.
//
// These are the defaults every install starts from, so a typo in one is a bug
// every user inherits. The variable check is the point: `{{inboxFle}}` renders as
// empty string at run time, which means an agent silently gets a prompt telling it
// to read nothing — exactly the class of failure that is hard to notice and
// expensive when it happens unattended at 08:00.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSkillFile, skillVariables } from './format.mjs'

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), 'seeds')

// Every variable the bridge knows how to supply, and which skill it is for. A
// seed referencing anything outside this set would render as an empty hole.
const KNOWN_VARIABLES = new Set([
  'now',           // formatted local date+time, every prompt
  'weather',       // daily-brief
  'news',          // daily-brief
  'inboxFile',     // daily-brief, journal-ingest, plaud-action-items-ingest
  'since',         // journal-ingest — ISO watermark, may be empty
  'sinceDate',     // journal-ingest — YYYY-MM-DD for Plaud's whole-day filter
  'stateFile',     // plaud-action-items-ingest
  'processedSummary', // plaud-action-items-ingest
])

// Variables only one caller can supply, so they're allowed in that skill alone.
// Mirrors SKILL_CONTEXT_VARS in bridge.mjs — if the two drift, a prompt silently
// renders a hole where its caller's values should be.
const CONTEXT_VARIABLES = {
  'daily-digest': ['facts', 'count'],
  'shortcut-summary': ['request', 'reply'],
  'voice-journal-ingest': ['transcript', 'recordedAt', 'entryDate', 'entryDateLong', 'previousDate', 'previousDateLong', 'journalFile', 'durationMin'],
}

async function seeds() {
  const entries = await readdir(SEED_DIR, { withFileTypes: true })
  return Promise.all(entries.filter((e) => e.isDirectory()).map(async (e) => ({
    id: e.name,
    ...parseSkillFile(await readFile(join(SEED_DIR, e.name, 'SKILL.md'), 'utf8')),
  })))
}

test('every seed parses and has the fields the UI renders', async () => {
  const all = await seeds()
  assert.ok(all.length >= 11, `expected the shipped skills, found ${all.length}`)
  for (const s of all) {
    assert.ok(s.meta.name, `${s.id}: missing name`)
    assert.ok(s.meta.description, `${s.id}: missing description`)
    assert.ok(s.meta.icon, `${s.id}: missing icon`)
    assert.ok(s.body.length > 0, `${s.id}: empty body`)
  }
})

test('no seed references a variable the bridge cannot supply', async () => {
  for (const s of await seeds()) {
    const allowed = new Set([...KNOWN_VARIABLES, ...(CONTEXT_VARIABLES[s.id] || [])])
    for (const name of skillVariables(s.body)) {
      assert.ok(allowed.has(name), `${s.id}: unknown variable {{${name}}}`)
    }
  }
})

test('chat commands are unique across seeds', async () => {
  const seen = new Map()
  for (const s of await seeds()) {
    const cmd = s.meta.command
    if (!cmd) continue
    assert.equal(seen.has(cmd), false, `${s.id} and ${seen.get(cmd)} both claim ${cmd}`)
    seen.set(cmd, s.id)
  }
})

test('every conditional section in a seed is closed', async () => {
  for (const s of await seeds()) {
    const opens = [...s.body.matchAll(/\{\{[#^]\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1])
    const closes = [...s.body.matchAll(/\{\{\/\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1])
    for (const name of new Set(opens)) {
      assert.equal(
        opens.filter((n) => n === name).length,
        closes.filter((n) => n === name).length,
        `${s.id}: unbalanced {{#${name}}} / {{/${name}}}`,
      )
    }
  }
})

// The three ingest prompts are the ones with real behaviour riding on them; if a
// refactor drops their instructions the jobs still "succeed" while doing nothing.
test('the ingest seeds keep the sentinel replies the bridge checks for', async () => {
  const byId = Object.fromEntries((await seeds()).map((s) => [s.id, s.body]))
  assert.match(byId['journal-ingest'], /NO_NEW_RECORDINGS/)
  assert.match(byId['journal-ingest'], /NO_JOURNAL/)
  assert.match(byId['plaud-action-items-ingest'], /NO_NEW_MEETINGS/)
})
