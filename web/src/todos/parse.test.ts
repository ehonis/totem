// The composer's quick-add hints (#179), moved here from the app with the parser
// (#215). node:assert reads as it did under node's test runner.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { hintKey, parseQuickAdd } from './parse'

// Wednesday 4 November 2026, mid-morning.
const now = new Date(2026, 10, 4, 10, 30)
const parse = (input, options = {}) => parseQuickAdd(input, { now, ...options })
const f = (id, name, parentId = null) => ({ id, name, parentId })
const ACME = [f('acme', 'Acme'), f('labs', 'Acme Labs'), f('side', 'Side')]

test('plain titles pass through untouched', () => {
  const result = parse('  Renew the passport  ')
  assert.deepEqual(result, { title: 'Renew the passport', hints: [], dueDate: null, priority: null, folderId: null })
})

test('relative days and the board’s “next week”', () => {
  assert.equal(parse('Call the bank today').dueDate, '2026-11-04')
  assert.equal(parse('Call the bank tonight').dueDate, '2026-11-04')
  assert.equal(parse('Call the bank tomorrow').dueDate, '2026-11-05')
  assert.equal(parse('Call the bank tmrw').dueDate, '2026-11-05')
  assert.equal(parse('Call the bank next week').dueDate, '2026-11-09')
  assert.equal(parse('Call the bank in 3 days').dueDate, '2026-11-07')
  assert.equal(parse('Call the bank in 2 weeks').dueDate, '2026-11-18')
  assert.equal(parse('Call the bank in a week').dueDate, '2026-11-11')
  assert.equal(parse('Call the bank tomorrow').title, 'Call the bank')
})

test('a lead-in word goes with the date', () => {
  const result = parse('Pay rent by tomorrow')
  assert.equal(result.title, 'Pay rent')
  assert.equal(result.hints[0].text, 'by tomorrow')
  assert.equal(parse('File taxes due today').title, 'File taxes')
})

test('weekdays: "this" may be today, "on" and "next" are the coming one', () => {
  assert.equal(parse('Standup this wednesday').dueDate, '2026-11-04')
  assert.equal(parse('Standup on wednesday').dueDate, '2026-11-11')
  assert.equal(parse('Standup next wed').dueDate, '2026-11-11')
  assert.equal(parse('Send invoice on fri please').dueDate, '2026-11-06')
  assert.equal(parse('Send invoice on fri please').title, 'Send invoice please')
  assert.equal(parse('Haircut saturday').dueDate, '2026-11-07')
})

test('a bare weekday counts only at the end, where a priority or tag may follow it', () => {
  const result = parse('Monday standup notes')
  assert.equal(result.dueDate, null)
  assert.equal(result.title, 'Monday standup notes')
  const trailed = parse('Renew car registration fri p1 #acme', { folders: [f('acme', 'Acme')] })
  assert.equal(trailed.dueDate, '2026-11-06')
  assert.equal(trailed.priority, 4)
  assert.equal(trailed.title, 'Renew car registration')
  assert.equal(parse('Friday lunch with Sam p2').dueDate, null)
  const spaced = parse('Renew registration fri #Acme Labs', { folders: [f('labs', 'Acme Labs')] })
  assert.equal(spaced.dueDate, '2026-11-06')
  assert.equal(spaced.folderId, 'labs')
  assert.equal(spaced.title, 'Renew registration')
  assert.equal(parse('Pay rent fri p1 and call').dueDate, null)
})

test('month and day, rolling to next year once the day has gone', () => {
  assert.equal(parse('Dentist nov 20').dueDate, '2026-11-20')
  assert.equal(parse('Dentist 20 November').dueDate, '2026-11-20')
  assert.equal(parse('Dentist Mar 3rd').dueDate, '2027-03-03')
  assert.equal(parse('Dentist nov 4').dueDate, '2026-11-04')
  assert.equal(parse('Dentist feb 30').dueDate, null)
})

test('priority words map onto the bridge’s numbers (p1 is 4)', () => {
  assert.equal(parse('Fix the leak p1').priority, 4)
  assert.equal(parse('Fix the leak P2').priority, 3)
  assert.equal(parse('Fix the leak p3').priority, 2)
  assert.equal(parse('Fix the leak p4').priority, 1)
  assert.equal(parse('Fix the leak p5').priority, null)
  assert.equal(parse('Order the mp3 player').priority, null)
})

test('#folder matches only folders the owner has', () => {
  const folders = ACME
  assert.equal(parse('Ship pricing page #acme', { folders }).folderId, 'acme')
  assert.equal(parse('Ship pricing page #acme labs', { folders }).folderId, 'labs')
  assert.equal(parse('Ship pricing page #acme labs', { folders }).title, 'Ship pricing page')
  assert.equal(parse('Ship pricing page #acmelabs', { folders }).folderId, 'labs', 'a name run together')
  assert.equal(parse('Ship pricing page #acmecorp', { folders }).folderId, null)
  assert.equal(parse('Ship pricing page #other', { folders }).title, 'Ship pricing page #other')
  assert.equal(parse('issue#acme', { folders }).folderId, null)
  // A name ends at a space or the end, so a longer hyphenated word is not a shorter name.
  assert.equal(parse('Ship it #acme-corp', { folders }).folderId, null)
  assert.equal(parse('Ship it #acme-corp', { folders }).title, 'Ship it #acme-corp')
  assert.equal(parse('Renew fri #Acme-Corp', { folders }).dueDate, '2026-11-06')
})

test('#folder takes a folder inside a project, a path, or a word of a project name', () => {
  const folders = [f('north', 'Work - Northwind'), f('mn', 'r+d', 'north'), f('globex', 'globex', 'north'), f('wp', 'Gizmo Labs'), f('wpc', 'globex', 'wp')]
  assert.equal(parse('Send report #r+d', { folders }).folderId, 'mn')
  assert.equal(parse('Send report #r+d', { folders }).title, 'Send report')
  assert.equal(parse('Timesheets #northwind tomorrow', { folders }).folderId, 'north')
  assert.equal(parse('Timesheets #worknorthwind', { folders }).folderId, 'north')
  assert.equal(parse('Timesheets #Work - Northwind', { folders }).folderId, 'north')
  assert.equal(parse('Timesheets #Work - Northwind', { folders }).title, 'Timesheets')
  assert.equal(parse('Gym listing #gizmolabs', { folders }).folderId, 'wp')
  // "globex" is a folder in two projects: left as text until the path says which.
  assert.equal(parse('Invoice #globex', { folders }).folderId, null)
  assert.equal(parse('Invoice #globex', { folders }).title, 'Invoice #globex')
  assert.equal(parse('Invoice #Gizmo Labs / globex', { folders }).folderId, 'wpc')
})

test('everything at once, and only the first of each kind', () => {
  const result = parse('p2 Draft the deck tomorrow #side p1 friday', { folders: [f('side', 'Side')] })
  assert.equal(result.priority, 3)
  assert.equal(result.dueDate, '2026-11-05')
  assert.equal(result.folderId, 'side')
  assert.equal(result.title, 'Draft the deck p1 friday')
  assert.deepEqual(result.hints.map((hint) => hint.kind), ['priority', 'due', 'folder'])
})

test('a dismissed hint stays text, and the next match can take its place', () => {
  const first = parse('Read chapter today p1')
  const keyOf = hintKey(first.hints.find((hint) => hint.kind === 'due'))
  assert.equal(keyOf, 'today')
  const kept = parse('Read chapter today p1', { ignore: [keyOf] })
  assert.equal(kept.dueDate, null)
  assert.equal(kept.priority, 4)
  assert.equal(kept.title, 'Read chapter today')
})

test('words inside other words never match', () => {
  for (const input of ['Todays agenda', 'Tomorrowland tickets', 'Fridays club', 'Pin the 1p coin']) {
    assert.deepEqual(parse(input).hints, [], input)
  }
})

test('a title that is only hints is kept whole', () => {
  const result = parse('Tomorrow')
  assert.equal(result.title, 'Tomorrow')
  assert.equal(result.dueDate, null)
})

test('a kind left out stays in the title (its chip was set by hand)', () => {
  const result = parse('Review p2 bug list tomorrow', { kinds: ['due'] })
  assert.equal(result.title, 'Review p2 bug list')
  assert.equal(result.priority, null)
  assert.equal(result.dueDate, '2026-11-05')
  assert.deepEqual(parse('Review p2 bug list', { kinds: [] }).hints, [])
})
