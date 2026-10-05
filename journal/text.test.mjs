import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeDuration, describeIngestResult, ingestFailure, journalBlock, localDate, localTime, longDate,
  paragraphs, parseIngestResult, previousDate,
} from './text.mjs'

const TZ = 'America/New_York'

test('local date and time follow the timezone, not the box clock', () => {
  // 03:30Z on the 17th is still the evening of the 16th in New York.
  assert.equal(localDate('2026-09-17T03:30:00.000Z', TZ), '2026-09-16')
  assert.equal(localTime('2026-09-17T03:30:00.000Z', TZ), '23:30 EDT')
  assert.equal(localDate('2026-09-17T03:30:00.000Z', 'UTC'), '2026-09-17')
})

test('long and previous dates never drift across a month boundary', () => {
  assert.equal(longDate('2026-09-16'), 'Wednesday, September 16, 2026')
  assert.equal(previousDate('2026-09-01'), '2026-08-31')
  assert.equal(previousDate('2026-01-01'), '2025-12-31')
})

test('paragraphs break on long pauses between segments, only at sentence ends', () => {
  const segs = [
    { start: 0, end: 4, text: 'Woke up at six.' },
    { start: 4.2, end: 8, text: 'Went to the gym' },
    { start: 10.5, end: 14, text: 'and did legs.' },   // long gap, but mid-sentence: no break
    { start: 16.5, end: 20, text: 'Then work.' },      // long gap after a full stop: break
  ]
  assert.deepEqual(paragraphs({ segments: segs }), [
    'Woke up at six. Went to the gym and did legs.',
    'Then work.',
  ])
})

test('paragraphs without segments chunk sentences by size', () => {
  const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ')
  const out = paragraphs({ text }, { maxChars: 120 })
  assert.ok(out.length > 3)
  for (const p of out) assert.ok(p.length <= 130, p)
  assert.equal(out.join(' '), text)
})

test('sentence splitting never breaks a dotted word', () => {
  const text = 'Last night I built whisper.cpp on the box. It ran at 3.5x realtime. Done!'
  const out = paragraphs({ text }, { maxChars: 40 })
  assert.equal(out.join(' '), text)
  assert.ok(out.every((p) => !/whisper\. cpp|3\. 5/.test(p)), out.join(' | '))
})

test('describeDuration reads like a person', () => {
  assert.equal(describeDuration(45), '45 s')
  assert.equal(describeDuration(250), '4 min')
  assert.equal(describeDuration(4320), '1 h 12 min')
})

test('journalBlock has a timestamped heading and the transcript in paragraphs', () => {
  const block = journalBlock({
    recordedAt: '2026-09-16T11:12:00.000Z', timeZone: TZ, source: 'voice', durationSec: 240,
    text: 'Hello there. It was a good day.', segments: [], title: 'Good day',
  })
  assert.match(block, /^## 07:12 EDT · voice · 4 min · — Good day\n\nHello there\. It was a good day\.\n$/)
})

test('parseIngestResult finds the last marker and tolerates braces in the prose', () => {
  const reply = `Filed the {gym} line and two proposals.
Notes: {"not": "this one"}
JOURNAL_RESULT: {"title": "Gym and Acme", "summary": "Legs day, then a demo.", "memory": ["events/2026-09.md"], "habits": ["gym"], "proposals": ["p41", "P42", "junk"], "goals": [], "mood": "tired"}`
  const r = parseIngestResult(reply)
  assert.equal(r.parsed, true)
  assert.equal(r.title, 'Gym and Acme')
  assert.deepEqual(r.memory, ['events/2026-09.md'])
  assert.deepEqual(r.proposals, ['P41', 'P42'])
  assert.deepEqual(r.habits, ['gym'])
  assert.equal(r.mood, 'tired')
})

test('parseIngestResult falls back to the prose when the marker is missing or broken', () => {
  const plain = parseIngestResult('I added two lines to events and staged nothing.')
  assert.equal(plain.parsed, false)
  assert.equal(plain.summary, 'I added two lines to events and staged nothing.')
  assert.deepEqual(plain.proposals, [])
  const broken = parseIngestResult('JOURNAL_RESULT: {"title": "unterminated')
  assert.equal(broken.parsed, false)
})

test('describeIngestResult counts what changed, or says nothing did', () => {
  assert.equal(describeIngestResult({ memory: ['a', 'b'], proposals: ['P1'], habits: [] }), '2 memory updates · 1 proposal in the inbox')
  assert.equal(describeIngestResult({ memory: [], proposals: [], habits: [], summary: 'Quiet day.' }), 'Quiet day.')
  assert.equal(describeIngestResult({ memory: [], proposals: [], habits: [] }), 'Digested — nothing new to file.')
})

test('a killed or silent agent run is a failure, not a quiet digest', () => {
  // The exact strings the cursor/codex/opencode backends return for a run that
  // did not answer. Each of these used to be filed as a successful digest.
  assert.match(ingestFailure('Agent timed out after 180 seconds. Try a narrower request.'), /ran out of time after 180s/)
  assert.match(ingestFailure('codex timed out after 180s without answering. Try a narrower request.'), /ran out of time/)
  assert.match(ingestFailure('Agent finished without a final response.'), /without saying anything/)
  assert.match(ingestFailure('Stopped the running request.'), /stopped before it finished/)
  assert.match(ingestFailure('(no output)'), /no output/)
  assert.match(ingestFailure('   '), /nothing at all/)
})

test('a real answer passes, with or without the result marker', () => {
  assert.equal(ingestFailure('Filed two events.\nJOURNAL_RESULT: {"title":"x"}'), null)
  // A digest that did the work and forgot the marker is still a digest.
  assert.equal(ingestFailure('I added two lines to events and staged nothing.'), null)
  // Not a false positive just because the word "timed out" appears mid-sentence.
  assert.equal(ingestFailure('He said the run timed out after his shift, so I logged it.'), null)
})
