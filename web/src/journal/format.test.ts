import { describe, expect, it } from 'vitest'
import { audioLabel, audioTitle, cardState, dayLabel, entryTitle, fmtBytes, fmtClock, groupByDay, pickMimeType, pollIntervalMs } from './format'
import type { JournalEntry } from './types'

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  id: 'j1', createdAt: '2026-09-16T11:00:00.000Z', updatedAt: '2026-09-16T11:00:00.000Z',
  recordedAt: '2026-09-16T11:00:00.000Z', date: '2026-09-16', durationSec: 240, source: 'voice',
  title: null, audio: null, status: 'transcribed', error: null,
  transcript: { text: 'Went to the gym. Then work.', segments: [], language: 'en', model: 'small', ms: 1, completedAt: '2026-09-16T11:01:00.000Z' },
  ingest: { state: 'queued', at: '2026-09-16T11:10:00.000Z', startedAt: null, completedAt: null, error: null, result: null, journalFile: null },
  ...over,
})

describe('fmtClock', () => {
  it('reads like a stopwatch', () => {
    expect(fmtClock(7)).toBe('0:07')
    expect(fmtClock(754)).toBe('12:34')
    expect(fmtClock(3723)).toBe('1:02:03')
  })
})

describe('cardState', () => {
  const T = Date.parse('2026-09-16T11:05:00.000Z')
  it('follows transcription first, then the grace window', () => {
    expect(cardState(entry({ status: 'transcribing' }), T)).toBe('transcribing')
    expect(cardState(entry({ status: 'failed' }), T)).toBe('transcribe-failed')
    expect(cardState(entry(), T)).toBe('waiting')
    expect(cardState(entry(), T + 6 * 60_000)).toBe('due')
    expect(cardState(entry({ ingest: { ...entry().ingest, state: 'done' } }), T)).toBe('digested')
    expect(cardState(entry({ ingest: { ...entry().ingest, state: 'skipped' } }), T)).toBe('skipped')
  })
  it('polls fast while something is moving, slowly when nothing is', () => {
    expect(pollIntervalMs([entry({ status: 'transcribing' })], T)).toBe(4_000)
    expect(pollIntervalMs([entry()], T)).toBe(20_000)
    expect(pollIntervalMs([entry({ ingest: { ...entry().ingest, state: 'done' } })], T)).toBe(90_000)
  })
})

describe('entryTitle', () => {
  it('prefers the title, then the first sentence, then a generic name', () => {
    expect(entryTitle(entry({ title: 'Gym day' }))).toBe('Gym day')
    expect(entryTitle(entry())).toBe('Went to the gym.')
    expect(entryTitle(entry({ transcript: null, status: 'transcribing' }))).toBe('Recording')
    expect(entryTitle(entry({ transcript: null, source: 'text' }))).toBe('Typed entry')
  })
})

describe('groupByDay', () => {
  const today = new Date(2026, 8, 16)
  it('names today and yesterday and orders newest first', () => {
    const groups = groupByDay([
      entry({ id: 'a', date: '2026-09-15', recordedAt: '2026-09-15T11:00:00.000Z' }),
      entry({ id: 'b', date: '2026-09-16', recordedAt: '2026-09-16T11:00:00.000Z' }),
      entry({ id: 'c', date: '2026-09-16', recordedAt: '2026-09-16T12:00:00.000Z' }),
      entry({ id: 'd', date: '2026-09-01', recordedAt: '2026-09-01T12:00:00.000Z' }),
    ], today)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Tuesday, September 1'])
    expect(groups[0].entries.map((e) => e.id)).toEqual(['c', 'b'])
  })
  it('adds the year for another year', () => {
    expect(dayLabel('2025-12-31', today)).toMatch(/2025/)
  })
})

describe('pickMimeType', () => {
  it('takes the first container the browser can record', () => {
    expect(pickMimeType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus')
    expect(pickMimeType(() => false)).toBeUndefined()
    expect(pickMimeType(() => { throw new Error('no MediaRecorder') })).toBeUndefined()
  })
})

describe('audio retention labels', () => {
  const NOW = Date.parse('2026-09-17T12:00:00.000Z')
  const audio = (over = {}) => ({ mime: 'audio/mp4', bytes: 1_800_000, kept: true, pinned: false, keepUntil: null, deletedAt: null, ...over })

  it('counts the days left rather than printing a raw date on the card', () => {
    expect(audioLabel(audio({ keepUntil: '2026-09-30T12:00:00.000Z' }), NOW)).toBe('audio 13d')
    expect(audioLabel(audio({ keepUntil: '2026-09-17T13:00:00.000Z' }), NOW)).toBe('audio 1d')
  })

  it('names deleted, pinned and expiring as states of their own', () => {
    expect(audioLabel(audio({ kept: false, deletedAt: '…' }), NOW)).toBe('audio deleted')
    expect(audioLabel(audio({ pinned: true }), NOW)).toBe('audio kept')
    expect(audioLabel(audio({ keepUntil: '2026-09-16T12:00:00.000Z' }), NOW)).toBe('audio expiring')
    expect(audioLabel(null, NOW)).toBe('')
  })

  it('spells the deadline out in the tooltip', () => {
    expect(audioTitle(audio({ keepUntil: '2026-09-30T12:00:00.000Z' }), NOW)).toMatch(/kept until September 30 \(13 days\)/)
    expect(audioTitle(audio({ pinned: true }), NOW)).toMatch(/Kept indefinitely/)
    expect(audioTitle(audio({ kept: false }), NOW)).toMatch(/transcript is the record/)
  })
})

describe('fmtBytes', () => {
  it('reads as a file size', () => {
    expect(fmtBytes(812_000)).toBe('812 kB')
    expect(fmtBytes(1_800_000)).toBe('1.8 MB')
    expect(fmtBytes(24_000_000)).toBe('24 MB')
    expect(fmtBytes(0)).toBe('0 B')
  })
})
