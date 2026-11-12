import { describe, expect, it } from 'vitest'
import type { DevIssue } from '../api'
import { devIssueContext } from '../chat/about/context'
import {
  NO_FILTERS, capNote, contrast, errorNotes, filterIssues, rowDetails, rowName, spokenAgo, stateText, warningNote, hasFilters, initials, labelLook, labelOptions, parseHex,
  repoMarks, repoOptions, shortAgo, summary,
} from './issues'

const issue = (repo: string, number: number, extra: Partial<DevIssue> = {}): DevIssue => ({
  repo, number, title: `Issue ${number}`, state: 'open', stateReason: null,
  url: `https://github.com/${repo}/issues/${number}`, labels: [], assignees: [], author: 'someone',
  comments: 0, createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z', milestone: null,
  ...extra,
})

const ISSUES = [
  issue('acme/app', 12, { title: 'Crash on login screen', labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'P1', color: 'b60205' }], assignees: ['octo'] }),
  issue('acme/app', 123, { title: 'Dark mode toggle', labels: [{ name: 'enhancement', color: 'a2eeef' }] }),
  issue('acme/site', 7, { title: 'Broken footer link', labels: [{ name: 'Bug', color: 'ee0701' }], author: 'jane-doe', milestone: 'Launch' }),
  issue('other/lib', 1, { title: 'Docs typo', assignees: ['octo', 'pat'] }),
]
const nums = (list: DevIssue[]) => list.map((i) => `${i.repo}#${i.number}`)

describe('filterIssues', () => {
  it('leaves everything, in order, with no filters', () => {
    expect(filterIssues(ISSUES, NO_FILTERS)).toEqual(ISSUES)
    expect(hasFilters(NO_FILTERS)).toBe(false)
    expect(hasFilters({ ...NO_FILTERS, search: '   ' })).toBe(false)
  })

  it('filters by repo and by label name across repos, without case', () => {
    expect(nums(filterIssues(ISSUES, { ...NO_FILTERS, repo: 'ACME/app' }))).toEqual(['acme/app#12', 'acme/app#123'])
    expect(nums(filterIssues(ISSUES, { ...NO_FILTERS, label: 'bug' }))).toEqual(['acme/app#12', 'acme/site#7'])
    expect(nums(filterIssues(ISSUES, { ...NO_FILTERS, label: 'bug', repo: 'acme/site' }))).toEqual(['acme/site#7'])
  })

  it('searches every word across title, repo, labels, people and milestone', () => {
    const find = (search: string) => nums(filterIssues(ISSUES, { ...NO_FILTERS, search }))
    expect(find('crash LOGIN')).toEqual(['acme/app#12'])
    expect(find('crash footer'), 'every word must match').toEqual([])
    expect(find('site')).toEqual(['acme/site#7'])
    expect(find('enhancement')).toEqual(['acme/app#123'])
    expect(find('pat')).toEqual(['other/lib#1'])
    expect(find('jane')).toEqual(['acme/site#7'])
    expect(find('launch')).toEqual(['acme/site#7'])
  })

  it('reads #12 as that issue only, and a bare number as a number or text', () => {
    const find = (search: string) => nums(filterIssues(ISSUES, { ...NO_FILTERS, search }))
    expect(find('#12')).toEqual(['acme/app#12'])
    expect(find('#1')).toEqual(['other/lib#1'])
    expect(find('123')).toEqual(['acme/app#123'])
  })
})

describe('filter menus', () => {
  it('lists watched repos even when empty, busiest first', () => {
    expect(repoOptions(ISSUES, ['acme/app', 'acme/empty'])).toEqual([
      { value: 'acme/app', count: 2 }, { value: 'acme/site', count: 1 }, { value: 'other/lib', count: 1 }, { value: 'acme/empty', count: 0 },
    ])
  })

  it('merges labels by name across repos and keeps the first colour', () => {
    expect(labelOptions(ISSUES)).toEqual([
      { value: 'bug', count: 2, color: 'd73a4a' },
      { value: 'enhancement', count: 1, color: 'a2eeef' },
      { value: 'P1', count: 1, color: 'b60205' },
    ])
  })

  it('shows the owner in a repo mark only where two repos share a name', () => {
    const marks = repoMarks(['acme/app', 'other/app', 'acme/site'])
    expect(marks.get('acme/app')).toBe('acme/app')
    expect(marks.get('other/app')).toBe('other/app')
    expect(marks.get('acme/site')).toBe('site')
  })
})

describe('row bits', () => {
  it('makes initials from logins', () => {
    expect(initials('octo')).toBe('OC')
    expect(initials('jane-doe')).toBe('JD')
    expect(initials('dependabot[bot]')).toBe('DE')
    expect(initials('')).toBe('?')
  })

  it('says how long ago briefly, then the date', () => {
    const now = Date.parse('2026-11-09T12:00:00Z')
    expect(shortAgo('2026-11-09T11:59:30Z', now)).toBe('now')
    expect(shortAgo('2026-11-09T11:15:00Z', now)).toBe('45m')
    expect(shortAgo('2026-11-09T07:00:00Z', now)).toBe('5h')
    expect(shortAgo('2026-11-02T12:00:00Z', now)).toBe('7d')
    expect(shortAgo('2026-03-04T12:00:00Z', now)).toBe('Mar 4')
    expect(shortAgo('2025-03-04T12:00:00Z', now)).toBe('Mar 2025')
    expect(shortAgo(null, now)).toBe('')
  })

  it('sums up the list for the card head', () => {
    expect(summary(ISSUES, 'open', 'octo')).toBe('4 open issues · 2 assigned to you')
    expect(summary(ISSUES.slice(1, 2), 'closed', 'octo')).toBe('1 closed issue')
    expect(summary([], 'all', null)).toBe('0 issues')
  })
})

describe('labelLook', () => {
  const rgb = (css: string) => css.match(/\d+/g)!.map(Number) as [number, number, number]
  const dark = '#141415'
  const light = '#ffffff'
  // Navy and black vanish on a dark card; pale yellow and white on a light one.
  const colours = ['0e2a6e', '000000', 'fef2c0', 'ffffff', 'd73a4a', 'a2eeef', '7057ff', '008672']

  it.each([dark, light])('keeps every label readable at 4.5:1 on %s', (surface) => {
    for (const hex of colours) {
      const look = labelLook(hex, surface)!
      expect(contrast(rgb(look.color), rgb(look.background)), `${hex} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('tints toward the label colour and keeps its hue in the text', () => {
    const look = labelLook('d73a4a', dark)!
    const [r, g, b] = rgb(look.color)
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
    expect(rgb(look.background)).not.toEqual(parseHex(dark))
  })

  it('has no look for a label without a colour, and copes with an unreadable surface', () => {
    expect(labelLook('', dark)).toBeNull()
    expect(labelLook('zzz', dark)).toBeNull()
    expect(labelLook('d73a4a', 'var(--nope)')).not.toBeNull()
  })
})

describe('Chat about an issue', () => {
  it('names the issue, its state, labels and people, and how to read the body', () => {
    const c = devIssueContext({ ...ISSUES[2], state: 'closed', stateReason: 'not_planned', comments: 1 })
    expect(c.place).toBe('dev.issue')
    expect(c.title).toBe('Issue: acme/site#7 Broken footer link')
    expect(c.lines).toEqual([
      'https://github.com/acme/site/issues/7 (closed as not planned).',
      'Labels: Bug.',
      'Assigned to: nobody. Opened by jane-doe on 2026-10-01.',
      '1 comment, last updated 2026-11-01.',
      'Milestone: Launch.',
      'Read the body and comments with: gh issue view 7 -R acme/site --comments',
    ])
  })
})

describe('notes and names', () => {
  it('names a cap exactly: how many, which state, which source', () => {
    expect(capNote({ source: 'acme/app', shown: 1000, total: 1240 }, 'closed')).toBe('Showing the 1,000 most recently updated closed issues in acme/app (of 1,240).')
    expect(capNote({ source: 'Assigned to you', shown: 1000, total: 1000 }, 'all')).toBe('Showing the 1,000 most recently updated issues assigned to you.')
  })

  it('tells a source never read apart from one shown from its last good read', () => {
    expect(errorNotes([])).toEqual({ unread: null, stale: null })
    expect(errorNotes([
      { source: 'acme/app', error: 'HTTP 500', stale: false },
      { source: 'Assigned to you', error: 'timeout', stale: true },
    ])).toEqual({
      unread: 'Couldn’t read acme/app: HTTP 500',
      stale: 'Showing the last good list of issues assigned to you: timeout',
    })
    expect(errorNotes([
      { source: 'Assigned to you', error: 'gh is not signed in', stale: false },
      { source: 'acme/app', error: 'HTTP 500', stale: false },
    ]).unread).toBe('Couldn’t read issues assigned to you (gh is not signed in); acme/app (HTTP 500)')
    expect(warningNote({ source: 'Assigned to you', warning: 'SAML' })).toBe('Some issues assigned to you could not be read: SAML')
  })

  it('puts the state into a row’s name', () => {
    expect(stateText({ state: 'open', stateReason: null })).toBe('open')
    expect(stateText({ state: 'closed', stateReason: 'completed' })).toBe('closed')
    expect(stateText({ state: 'closed', stateReason: 'not_planned' })).toBe('closed as not planned')
    expect(rowName(ISSUES[0])).toBe('acme/app #12: Crash on login screen (open)')
  })

  it('describes the rest of a row in words', () => {
    const now = Date.parse('2026-11-09T12:00:00Z')
    expect(spokenAgo('2026-11-09T11:59:00Z', now)).toBe('1 minute ago')
    expect(spokenAgo('2026-11-09T07:00:00Z', now)).toBe('5 hours ago')
    expect(spokenAgo('2026-03-04T12:00:00Z', now)).toBe('on Mar 4')
    expect(rowDetails({ ...ISSUES[3], comments: 1, updatedAt: '2026-11-08T12:00:00Z' }, 'octo', now))
      .toBe('Assigned to octo (you), pat. 1 comment. Updated 1 day ago.')
  })
})
