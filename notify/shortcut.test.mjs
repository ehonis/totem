import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  flatten, receivedNotification, parseSummary, fallbackSummary, failedNotification,
  RECEIVED_TITLE, ANSWERED_TITLE, FAILED_TITLE,
} from './shortcut.mjs'
import { TITLE_MAX } from './text.mjs'

test('the receipt is the request, flattened, and nothing else', () => {
  const n = receivedNotification('  add buy milk\nto my tasks  ')
  assert.equal(n.title, RECEIVED_TITLE)
  assert.equal(n.body, 'add buy milk to my tasks')
})

test('a request with nothing in it still says something', () => {
  assert.match(receivedNotification('   ').body, /no text/)
})

test('markdown is stripped, not rendered — a lock screen shows the asterisks', () => {
  const md = '## Done\n\n- Added **buy milk** to [Personal](https://example.com/list)\n\n`todo add`'
  assert.equal(flatten(md), 'Done Added buy milk to Personal todo add')
})

test('a long body is cut at a word and marked as cut', () => {
  const body = flatten(`${'alpha '.repeat(80)}omega`, 40)
  assert.ok(body.length <= 41, body)
  assert.match(body, /…$/)
  assert.doesNotMatch(body, /alph…$/)
})

test('the model summary is used when it comes back usable', () => {
  const s = parseSummary('{"title": "Task added", "body": "Buy milk is on your Personal list, due today."}')
  assert.deepEqual(s, { title: 'Task added', body: 'Buy milk is on your Personal list, due today.' })
})

test('a fence, a preamble, and pretty-printing are all survivable', () => {
  const raw = 'Here you go:\n```json\n{\n  "title": "Task added",\n  "body": "Buy milk, due today."\n}\n```'
  assert.deepEqual(parseSummary(raw), { title: 'Task added', body: 'Buy milk, due today.' })
})

test('a title over the lock-screen budget is dropped for the label, not truncated', () => {
  const long = 'Added buy milk to the Personal list due today'
  assert.ok(long.length > TITLE_MAX)
  const s = parseSummary(JSON.stringify({ title: long, body: 'Due today.' }))
  assert.equal(s.title, ANSWERED_TITLE)
  assert.equal(s.body, 'Due today.')
})

test('an unusable summary is null so the caller can fall back rather than send nothing', () => {
  assert.equal(parseSummary(''), null)
  assert.equal(parseSummary('I could not summarize that.'), null)
  assert.equal(parseSummary('{"title": "Task added", "body": ""}'), null)
})

test('a failed request says so rather than leaving the receipt as the last word', () => {
  const n = failedNotification('claude timed out after 180s without answering.')
  assert.equal(n.title, FAILED_TITLE)
  assert.match(n.body, /didn't finish: claude timed out/)
  assert.match(failedNotification('').body, /said nothing about why/)
})

test('the fallback summary needs no model and never comes back empty', () => {
  const s = fallbackSummary('Added "buy milk" to your Personal list.\n\nIt is due today.')
  assert.equal(s.title, ANSWERED_TITLE)
  assert.equal(s.body, 'Added "buy milk" to your Personal list. It is due today.')
  assert.ok(fallbackSummary('').body.length > 0)
})
