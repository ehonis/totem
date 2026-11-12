// The composer's quick-add hints (#179), moved here from the app with the parser
// (#215). node:assert reads as it did under node's test runner.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { hintKey, parseQuickAdd } from './parse'

// Wednesday 4 November 2026, mid-morning.
const now = new Date(2026, 10, 4, 10, 30)
const parse = (input, options = {}) => parseQuickAdd(input, { now, ...options })

test('plain titles pass through untouched', () => {
  const result = parse('  Renew the passport  ')
  assert.deepEqual(result, { title: 'Renew the passport', hints: [], dueDate: null, priority: null, ventureTag: null })
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
  const trailed = parse('Renew car registration fri p1 #acme', { ventureTags: ['Acme'] })
  assert.equal(trailed.dueDate, '2026-11-06')
  assert.equal(trailed.priority, 4)
  assert.equal(trailed.title, 'Renew car registration')
  assert.equal(parse('Friday lunch with Sam p2').dueDate, null)
  const spaced = parse('Renew registration fri #Acme Labs', { ventureTags: ['Acme Labs'] })
  assert.equal(spaced.dueDate, '2026-11-06')
  assert.equal(spaced.ventureTag, 'Acme Labs')
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

test('venture tags match only names the install has', () => {
  const tags = ['Acme', 'Acme Labs', 'Side']
  assert.equal(parse('Ship pricing page #acme', { ventureTags: tags }).ventureTag, 'Acme')
  assert.equal(parse('Ship pricing page #acme labs', { ventureTags: tags }).ventureTag, 'Acme Labs')
  assert.equal(parse('Ship pricing page #acme labs', { ventureTags: tags }).title, 'Ship pricing page')
  assert.equal(parse('Ship pricing page #acmecorp', { ventureTags: tags }).ventureTag, null)
  assert.equal(parse('Ship pricing page #other', { ventureTags: tags }).title, 'Ship pricing page #other')
  assert.equal(parse('issue#acme', { ventureTags: tags }).ventureTag, null)
  // A tag ends at a space or the end, so a longer hyphenated word is not a shorter tag.
  assert.equal(parse('Ship it #acme-labs', { ventureTags: tags }).ventureTag, null)
  assert.equal(parse('Ship it #acme-labs', { ventureTags: tags }).title, 'Ship it #acme-labs')
  assert.equal(parse('Renew fri #Acme-Labs', { ventureTags: tags }).dueDate, '2026-11-06')
})

test('everything at once, and only the first of each kind', () => {
  const result = parse('p2 Draft the deck tomorrow #side p1 friday', { ventureTags: ['Side'] })
  assert.equal(result.priority, 3)
  assert.equal(result.dueDate, '2026-11-05')
  assert.equal(result.ventureTag, 'Side')
  assert.equal(result.title, 'Draft the deck p1 friday')
  assert.deepEqual(result.hints.map((hint) => hint.kind), ['priority', 'due', 'venture'])
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
