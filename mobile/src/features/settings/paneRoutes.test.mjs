// Settings on the phone: where a link lands (paneRoutes.ts), that every search
// hit points at a row its pane draws, and that the files ported from the web
// stay byte-for-byte copies. Run with `node --test mobile/src/features/settings/*.test.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appPane, settingsLanding } from './paneRoutes.ts'
import { SETTINGS_SECTIONS } from '../../lib/components/settings/sections.ts'

const here = dirname(fileURLToPath(import.meta.url))
const mobileSrc = resolve(here, '../..')
const repo = resolve(mobileSrc, '../..')
const read = (...p) => readFileSync(join(...p), 'utf8')

test('a link to a pane lands on it, at its row', () => {
  assert.deepEqual(settingsLanding('chat'), { pane: 'chat' })
  assert.deepEqual(settingsLanding('security', 'approval-code'), { pane: 'security', row: 'approval-code' })
  assert.deepEqual(settingsLanding('security', '#approval-code'), { pane: 'security', row: 'approval-code' })
  assert.deepEqual(settingsLanding(null), { list: true })
})

test('retired panes land where their settings went', () => {
  assert.deepEqual(settingsLanding('ai'), { pane: 'providers' })
  assert.deepEqual(settingsLanding('integrations'), { pane: 'general', row: 'public-url' })
  assert.deepEqual(settingsLanding('jobs'), { tab: 'totems' })
  assert.deepEqual(settingsLanding('providers', 'usage'), { pane: 'usage' })
  // A pane the app does not draw, or never had, opens the list.
  assert.deepEqual(settingsLanding('shortcuts'), { list: true })
  assert.deepEqual(settingsLanding('nope'), { list: true })
})

test('the app draws every web section but Keyboard, plus notification history', () => {
  const drawn = SETTINGS_SECTIONS.filter(appPane)
  assert.deepEqual([...SETTINGS_SECTIONS].filter((s) => !drawn.includes(s)), ['shortcuts'])
  assert.ok(appPane('notification-history'))
})

// search.ts imports the web's index without a file extension (Metro resolves it,
// Node does not), so read the ids from the source the way the web's test reads its panes.
function searchEntries() {
  const src = read(mobileSrc, 'lib/components/settings/searchIndex.ts')
  const body = src.slice(src.indexOf('const ENTRIES'), src.indexOf('export const SEARCH_ITEMS'))
  const out = []
  let section = null
  for (const line of body.split('\n')) {
    const head = /^ {2}(\w+): \[/.exec(line)
    if (head) section = head[1]
    const entry = /^ {4}\['([\w-]+)'/.exec(line)
    if (entry && section) out.push({ section, id: entry[1], key: `${section}:${entry[1]}` })
  }
  return out
}

test('every search hit the app keeps is a row its own pane draws', () => {
  const skips = [...read(here, 'search.ts').matchAll(/'(\w+:[\w-]+)'/g)].map((m) => m[1])
  const PANE_FILES = {
    general: ['panes/GeneralPane.tsx'],
    appearance: ['panes/AppearancePane.tsx'],
    chat: ['panes/ChatPane.tsx'],
    voice: ['panes/VoicePane.tsx'],
    notifications: ['panes/NotificationsPane.tsx'],
    providers: ['panes/ProvidersPane.tsx'],
    usage: ['panes/UsagePane.tsx'],
    skills: ['panes/SkillsPane.tsx'],
    connections: ['panes/ConnectionsPane.tsx'],
    tasks: ['panes/TasksPane.tsx'],
    security: ['panes/SecurityPane.tsx'],
    logs: ['panes/ActivityPane.tsx'],
  }
  const entries = searchEntries()
  assert.ok(entries.length > 30, 'parsed the index')
  const missing = entries
    .filter((e) => appPane(e.section) && !skips.includes(e.key) && e.id !== e.section)
    .filter((e) => !(PANE_FILES[e.section] || []).map((f) => read(here, f)).join('\n').includes(`id="${e.id}"`))
    .map((e) => e.key)
  assert.deepEqual(missing, [])
  // A whole-pane hit lands on the pane's first section, which carries the pane's id.
  for (const pane of ['skills', 'logs']) assert.ok(read(here, PANE_FILES[pane][0]).includes(`id="${pane}"`), pane)
  assert.deepEqual(Object.keys(PANE_FILES).sort(), SETTINGS_SECTIONS.filter(appPane).sort())
})

test('the files ported from the web are the web’s, byte for byte', () => {
  for (const [web, app] of [
    ['web/src/components/settings/sections.ts', 'mobile/src/lib/components/settings/sections.ts'],
    ['web/src/components/settings/searchIndex.ts', 'mobile/src/lib/components/settings/searchIndex.ts'],
    ['web/src/sources/plainError.ts', 'mobile/src/lib/sources/plainError.ts'],
    ['web/src/connections/state.ts', 'mobile/src/lib/connections/state.ts'],
  ]) assert.equal(read(repo, app), read(repo, web), app)
  // health.ts carries one line naming where it came from.
  assert.equal(read(repo, 'mobile/src/lib/sources/health.ts').split('\n').slice(1).join('\n'), read(repo, 'web/src/sources/health.ts'))
})

test('the palettes are the web’s', () => {
  const ids = (s) => [...s.matchAll(/\{ id: '([\w-]+)', name: '([^']+)', bg: '(#\w+)', panel: '(#\w+)', raised: '(#\w+)', rail: '(#\w+)', line: '(#\w+)', muted: '(#\w+)' \}/g)].map((m) => m.slice(1).join(' '))
  const web = ids(read(repo, 'web/src/backgrounds.ts'))
  assert.ok(web.length >= 10)
  assert.deepEqual(ids(read(repo, 'mobile/src/lib/backgrounds.ts')), web)
})
