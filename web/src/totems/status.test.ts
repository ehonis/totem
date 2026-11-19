import { describe, expect, it } from 'vitest'
import { isBuiltIn, kindOf, totemBrief, totemState } from './shared'

// The words a totem's page header and its row in the list show, and which
// totems go on the folded "More built in" shelf.

const now = Date.now()
const base = { enabled: true, scheduleLabel: 'Weekdays at 7:00 AM', nextRunAt: now + 3 * 3600e3 }

describe('totemState (a totem page header)', () => {
  it('a run in progress wins over everything', () => {
    expect(totemState({ ...base, enabled: false, lastRun: { status: 'error' } }, true)).toEqual({ tone: 'live', text: 'Running now' })
    expect(totemState({ ...base, lastRun: { status: 'running' } }).tone).toBe('live')
  })
  it('then a pause, then trouble', () => {
    expect(totemState({ ...base, enabled: false, lastRun: { status: 'error' } })).toEqual({ tone: 'idle', text: 'Paused' })
    expect(totemState({ ...base, trigger: {}, watch: { error: 'DNS failed' }, lastRun: { status: 'error' } })).toEqual({ tone: 'bad', text: 'Can’t check: DNS failed' })
    expect(totemState({ ...base, lastRun: { status: 'error' } })).toEqual({ tone: 'bad', text: 'Last run failed' })
  })
  it('a schedule says when it runs next and on what schedule', () => {
    expect(totemState(base)).toEqual({ tone: 'good', text: 'Next in 3h · Weekdays at 7:00 AM' })
    expect(totemState({ enabled: true }).text).toBe('Not scheduled')
  })
  it('a watch says when it last looked', () => {
    expect(totemState({ ...base, trigger: {}, watch: { checkedAt: now - 4 * 60e3 } }).text).toBe('Watching · checked 4m ago')
    expect(totemState({ ...base, trigger: {}, watch: null }).text).toBe('Watching · first check within a minute')
  })
})

describe('totemBrief (a row in the list)', () => {
  it('a healthy totem gets no dot, only its schedule', () => {
    expect(totemBrief(base)).toEqual({ text: 'Weekdays at 7:00 AM' })
    expect(totemBrief({ ...base, trigger: {}, watch: { changedAt: now - 3 * 86400e3 } })).toEqual({ text: 'Watching · changed 3d ago' })
  })
  it('trouble, pauses and runs keep their dot, shortened', () => {
    expect(totemBrief({ ...base, trigger: {}, watch: { error: 'a very long error from the page fetch' } })).toEqual({ tone: 'bad', text: 'Can’t check what it watches' })
    expect(totemBrief({ ...base, enabled: false })).toEqual({ tone: 'idle', text: 'Paused' })
    expect(totemBrief(base, true)).toEqual({ tone: 'live', text: 'Running now' })
  })
})

describe('kindOf (the tag on a totem page)', () => {
  it('names built-ins and skills, and an agent totem by its type', () => {
    expect(kindOf({ runner: 'camera' })).toBe('Built-in')
    expect(kindOf({ kind: 'seeded', prompt: 'x' })).toBe('Built-in')
    expect(kindOf({ kind: 'seeded', skillId: 'morning' })).toBe('Skill')
    expect(kindOf({ kind: 'user', taskType: 'watcher' })).toBe('Watcher')
  })
})

describe('isBuiltIn', () => {
  it('runners, skills and seeded jobs ship with Totem; the builder’s totems do not', () => {
    expect(isBuiltIn({ runner: 'camera' })).toBe(true)
    expect(isBuiltIn({ skillId: 'morning' })).toBe(true)
    expect(isBuiltIn({ kind: 'seeded', prompt: 'x' })).toBe(true)
    expect(isBuiltIn({ kind: 'user', prompt: 'x' })).toBe(false)
  })
})
