// Sub-habits (web/src/habits/groups.ts, mirrored byte for byte here). Behaviour is
// tested on the app's copy, which node loads with its types stripped.
// Run with `node --test mobile/src/lib/habits/groups.test.mjs` (also in the root test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flattenTree, foldGroups, groupProgress, groupToggle, groupWords, habitTree, handLogged, isGroup, rowDone, subHabitDone } from './groups.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path) => readFileSync(join(repo, path), 'utf8')

test('the app’s copy is the web’s, byte for byte, and imports nothing', () => {
  const web = read('web/src/habits/groups.ts')
  assert.equal(read('mobile/src/lib/habits/groups.ts'), web, 'mobile/src/lib/habits/groups.ts has drifted from web/src/habits/groups.ts')
  assert.doesNotMatch(web, /^\s*import\b/m)
})

const h = (id, over = {}) => ({ id, archived: false, cadence: 'daily', target: 1, parentId: null, ...over })
const HABITS = [
  h('night'),
  h('sleep', { parentId: 'night' }),
  h('screens', { parentId: 'night' }),
  h('read'),
  h('water', { parentId: 'night', target: 4 }),
  h('old', { parentId: 'night', archived: true }),
  h('orphan', { parentId: 'gone' }),
]

test('habitTree: groups hold their sub-habits in list order; archived and orphaned ones are handled', () => {
  const rows = habitTree(HABITS)
  assert.deepEqual(rows.map((r) => [r.habit.id, r.children.map((c) => c.id)]), [
    ['night', ['sleep', 'screens', 'water']],
    ['read', []],
    ['orphan', []],
  ])
  assert.deepEqual(flattenTree(rows), ['night', 'sleep', 'screens', 'water', 'read', 'orphan'])
  assert.equal(isGroup(HABITS, 'night'), true)
  assert.equal(isGroup(HABITS, 'read'), false)
  assert.equal(isGroup([h('a'), h('b', { parentId: 'a', archived: true })], 'a'), false, 'only archived sub-habits: not a group')
})

test('foldGroups: a group reads as a daily habit counting its sub-habits done', () => {
  const entries = {
    '2026-11-24': { sleep: { count: 1 }, screens: { count: 1 }, water: { count: 4 }, night: { count: 9 } },
    '2026-11-25': { sleep: { count: 1 }, water: { count: 2 } },
    '2026-11-26': { sleep: { count: 0, skipped: true }, screens: { count: 0, skipped: true }, water: { count: 0, skipped: true } },
    '2026-11-27': { read: { count: 1 } },
  }
  const { habits, entries: folded } = foldGroups(HABITS, entries)
  const night = habits.find((x) => x.id === 'night')
  assert.equal(night.target, 3)
  assert.equal(night.cadence, 'daily')
  assert.deepEqual(folded['2026-11-24'].night, { count: 3 }, 'its own old entry is replaced')
  assert.deepEqual(folded['2026-11-25'].night, { count: 1 }, 'water at 2 of 4 is not done')
  assert.deepEqual(folded['2026-11-26'].night, { count: 0, skipped: true })
  assert.equal(folded['2026-11-27'].night, undefined)
  assert.deepEqual(groupProgress(HABITS, 'night', entries, '2026-11-25'), { done: 1, total: 3 })
  assert.strictEqual(foldGroups([h('a')], entries).entries, entries, 'nothing to fold: same object')
})

test('subHabitDone: a weekly sub-habit is done on a logged day or once its quota is met', () => {
  const gym = h('gym', { cadence: 'weekly', target: 2 })
  const entries = { '2026-11-23': { gym: { count: 1 } }, '2026-11-25': { gym: { count: 1 } } }
  assert.equal(subHabitDone(gym, entries, '2026-11-23'), true)
  assert.equal(subHabitDone(gym, {}, '2026-11-24'), false)
  assert.equal(subHabitDone(gym, entries, '2026-11-26'), true, 'quota met for the week')
})

test('groupToggle: marks every hand-logged sub-habit while any is open, clears them once all are done', () => {
  const habits = [h('g'), h('a', { parentId: 'g' }), h('b', { parentId: 'g', target: 3 }), h('app', { parentId: 'g', linkedApp: 'krakatoa' })]
  let t = groupToggle(habits, 'g', { d: { a: { count: 1 } } }, 'd')
  assert.equal(t.complete, true)
  assert.deepEqual(t.next, { a: 1, b: 3 })
  assert.deepEqual(t.undo, { id: 'g', date: 'd', counts: { a: 1, b: 0 } })
  t = groupToggle(habits, 'g', { d: { a: { count: 1 }, b: { count: 3 } } }, 'd')
  assert.equal(t.complete, false)
  assert.deepEqual(t.next, { a: 0, b: 0 })
})

test('groupToggle: leaves a met weekly quota alone, says when a tap would change nothing, skips app- and WHOOP-filled ones', () => {
  const habits = [
    h('g'),
    h('gym', { parentId: 'g', cadence: 'weekly', target: 1 }),
    h('sleep', { parentId: 'g', metric: { source: 'whoop-sleep' } }),
    h('food', { parentId: 'g', linkedApp: 'krakatoa' }),
  ]
  // Gym met on Monday; Wednesday's tap has nothing of its own to clear.
  const met = { '2026-11-23': { gym: { count: 1 } } }
  const t = groupToggle(habits, 'g', met, '2026-11-25')
  assert.equal(t.complete, false)
  assert.equal(t.changes, false)
  assert.deepEqual(t.next, { gym: 0 })
  // Not met yet: marking adds one.
  assert.deepEqual(groupToggle(habits, 'g', {}, '2026-11-25').next, { gym: 1 })
  assert.equal(handLogged(habits[2]), false)
  assert.equal(handLogged(habits[3]), false)
  assert.equal(groupToggle([h('a'), h('b', { parentId: 'a', linkedApp: 'bushido' })], 'a', {}, 'd').loggable, false)
})

test('rowDone: a daily habit at its target, a group once every sub-habit is', () => {
  const habits = [h('g'), h('a', { parentId: 'g' }), h('w', { target: 6 })]
  const rows = habitTree(habits)
  assert.equal(rowDone(habits, rows[0], { d: { a: { count: 1 } } }, 'd'), true)
  assert.equal(rowDone(habits, rows[1], { d: { w: { count: 3 } } }, 'd'), false)
  assert.equal(rowDone(habits, rows[1], { d: { w: { count: 6 } } }, 'd'), true)
})

test('groupToggle: the undo puts back a check-in "No"', () => {
  const habits = [h('g'), h('a', { parentId: 'g' }), h('b', { parentId: 'g' })]
  const t = groupToggle(habits, 'g', { d: { a: { count: 0, skipped: true } } }, 'd')
  assert.deepEqual(t.undo, { id: 'g', date: 'd', counts: { a: 0, b: 0 }, skips: ['a'] })
})

test('foldGroups: a day done only by a met weekly quota shows on the group, through today', () => {
  const habits = [h('g'), h('gym', { parentId: 'g', cadence: 'weekly', target: 1 }), h('walk', { parentId: 'g', cadence: 'weekly', target: 1 })]
  const entries = { '2026-11-23': { gym: { count: 1 } }, '2026-11-24': { walk: { count: 1 } } }
  const { entries: folded } = foldGroups(habits, entries, '2026-11-26')
  assert.deepEqual(folded['2026-11-26'].g, { count: 2 }, 'Thursday: both quotas met, no entry of its own')
  assert.deepEqual(folded['2026-11-23'].g, { count: 2 }, 'a met quota counts on every day of its week, as doneOn does')
  assert.equal(folded['2026-11-27'], undefined, 'nothing past today')
  // The first entry is Tuesday the 24th; its week starts Monday the 23rd.
  const late = foldGroups(habits, { '2026-11-25': { gym: { count: 1 } }, '2026-11-24': { walk: { count: 1 } } }, '2026-11-26').entries
  assert.deepEqual(late['2026-11-23'].g, { count: 2 }, 'Monday, before either log: the week quotas are met')
  assert.equal(foldGroups(habits, entries).entries['2026-11-26'], undefined, 'without today, entry days only')
})

test('handLogged: the bridge’s autoFilled mark wins', () => {
  assert.equal(handLogged(h('x', { autoFilled: true })), false)
})

test('groupWords: never promises "done" when an app still fills a sub-habit', () => {
  const habits = [h('g'), h('a', { parentId: 'g' }), h('app', { parentId: 'g', linkedApp: 'krakatoa' })]
  const t = groupToggle(habits, 'g', {}, 'd')
  assert.equal(t.others, 1)
  const w = groupWords('Morning', t, 0, 2)
  assert.match(w.action, /^Tick the rest of Morning, 0 of 2 so far; 1 fills in from its app$/)
  assert.doesNotMatch(w.result, /done/)
  assert.equal(groupWords('Morning', { complete: true, others: 0 }, 1, 2).result, 'Marked Morning done.')
  assert.equal(groupWords('Morning', { complete: false, others: 0 }, 2, 2).result, 'Cleared Morning.')
})
