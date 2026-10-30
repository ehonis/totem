import { describe, expect, it } from 'vitest'
import {
  contextFileName, contextMarkdown, devRepoContext, fleetDeviceContext, goalContext, habitContext,
  habitsContext, redact, scheduleContext, settingsContext, shippedContext, systemContext, taskLine, tasksContext, todoContext,
} from './context'

const AT = new Date(2026, 9, 30, 9, 5)

describe('contextMarkdown', () => {
  it('says what the card showed, where it lives and which files draw it', () => {
    const md = contextMarkdown({ place: 'goals', title: 'Goal: Run 30 miles', lines: ['- Distance: 12 of 30 mi'] }, AT)
    expect(md).toContain('# Goal: Run 30 miles')
    expect(md).toContain('at 2026-10-30 09:05')
    expect(md).toContain('- Distance: 12 of 30 mi')
    expect(md).toContain('- Page: Goals, /productivity/goals')
    expect(md).toContain('`web/src/goals/GoalCard.tsx`')
    expect(md).toContain('- In the iPhone app: `mobile/src/features/productivity/GoalsView.tsx`')
    expect(md).toContain('- Data: `goals/service.mjs`')
  })

  it('uses a more exact route when the card gives one', () => {
    expect(contextMarkdown({ place: 'fleet', route: '/fleet#mini', title: 'x', lines: [] }, AT)).toContain('Fleet, /fleet#mini')
  })

  it('stays short however much the card holds', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `- item ${i} ${'x'.repeat(80)}`)
    const md = contextMarkdown({ place: 'todos', title: 'Lots', lines }, AT)
    expect(md.length).toBeLessThan(4000)
    expect(md).toMatch(/… \d+ more not shown/)
  })

  it('names the file after the card', () => {
    expect(contextFileName({ place: 'goals', title: 'Goal: Run 30 miles!', lines: [] })).toBe('goal-run-30-miles.md')
    expect(contextFileName({ place: 'dev.repo', title: '…', lines: [] })).toBe('dev-repo.md')
  })
})

describe('serializers', () => {
  it('tasks: priority, due date and overdue', () => {
    expect(taskLine({ content: 'Pay rent', priority: 4, due: '2000-01-01' })).toBe('- Pay rent (P1; due 2000-01-01, overdue)')
    expect(taskLine({ title: 'Read', priority: 1, dueDate: null, status: 'doing' })).toBe('- Read (doing)')
    const c = tasksContext([{ content: 'A' }], { open: 5, overdue: 1 })
    expect(c.place).toBe('overview.tasks')
    expect(c.lines[0]).toBe('5 open, 1 overdue. Shown:')
  })

  it('a board task carries its id, notes and links', () => {
    const c = todoContext({
      id: 't1', title: 'Ship it', description: 'the thing', area: 'Ventures', ventureTag: 'Acme', status: 'doing', priority: 3,
      dueDate: '2099-05-01', recurrence: null, tags: [{ name: 'work' }],
      notes: [{ body: 'old', createdAt: '2026-01-01T00:00:00Z' }, { body: 'n2', createdAt: '2026-02-01T00:00:00Z' }, { body: 'n3', createdAt: '2026-03-01T00:00:00Z' }, { body: 'n4', createdAt: '2026-04-01T00:00:00Z' }],
      externalLinks: [{ connector: 'github', externalUrl: 'https://github.com/o/r/issues/1' }],
    })
    expect(c.lines[0]).toBe('Task id t1. Status doing, Ventures · Acme, P2.')
    expect(c.lines).toContain('Due 2099-05-01.')
    expect(c.lines.join('\n')).not.toContain('old')
    expect(c.lines).toContain('Note (2026-04-01): n4')
    expect(c.lines).toContain('Linked: github https://github.com/o/r/issues/1')
  })

  it('a goal: progress, steps and an unreadable number that is not zero', () => {
    const c = goalContext({
      id: 'g1', title: 'Run 30 miles', period: { label: 'Week of Oct 26' }, periodState: 'active', daysLeft: 3, postponedCount: 2,
      progress: { percent: 40 },
      metrics: [
        { label: 'Distance', unit: 'mi', targetValue: 30, value: 12 },
        { label: 'Rides', unit: null, targetValue: 3, value: null, available: false, unavailableReason: 'Strava is not connected' },
      ],
      subGoals: [{ title: 'Long run', complete: true }, { title: 'Hills', complete: false, abandoned: true }],
    })
    expect(c.title).toBe('Goal: Run 30 miles')
    expect(c.lines).toEqual([
      'Goal id g1. Week of Oct 26, 40%, 3 days left.',
      'Postponed 2 times.',
      '- Distance: 12 of 30 mi',
      '- Rides: unreadable (Strava is not connected), target 3',
      '- [x] Long run',
      '- [-] Hills',
    ])
  })

  it('habits: today on the Overview, two weeks on the card', () => {
    const h = { id: 'h1', name: 'Read', cadence: 'daily', target: 1, metric: { label: 'Pages', unit: 'pages' } }
    const entries = { '2026-10-30': { h1: { count: 1, value: 20, note: 'Dune' } }, '2026-10-28': { h1: { skipped: true } } }
    const o = habitsContext([h], entries, '2026-10-30', () => 1)
    expect(o.lines).toEqual(['Today is 2026-10-30.', '- Read: 1 of 1 this day (done), Pages 20. Note: Dune'])
    const c = habitContext(h, entries, '2026-10-30', { streak: 4, periodCount: 1 })
    expect(c.lines[0]).toBe('Habit id h1. Target 1 per day, 1 so far this day, streak 4.')
    expect(c.lines.join('\n')).toContain('Last 14 days, newest first: 10-30 1 (20), 10-29 0, 10-28 no,')
    expect(c.lines).toContain('Note 2026-10-30: Dune')
  })

  it('a machine: state, power and cost, and its route', () => {
    const d = {
      id: 'mini', name: 'Mac mini', os: 'macOS 26', online: true, lastSeen: null, bootedAt: 3600000,
      uptime: { pct24h: 100, pct7d: 99.4, pct30d: null },
      health: { level: 'warn', issues: [{ text: 'Disk / is 91% full' }] },
      now: { cpu: 12.3, load: [1.5, 1.2, 1], mem: { used: 8e9, total: 16e9 }, temps: { cpu: 51 }, watts: 9.6, measured: 'measured' },
      energy: { todayCost: 0.04, monthCost: 1.2, projectedMonthCost: 1.5 },
    }
    const c = fleetDeviceContext(d, 3600000 * 6)
    expect(c.place).toBe('fleet')
    expect(c.route).toBe('/fleet#mini')
    expect(c.lines).toEqual([
      'macOS 26. Health warn.',
      'Online, booted 5 h ago.',
      'Uptime 100% 24h, 99% 7d, – 30d.',
      'CPU 12%, load 1.5 1.2 1; memory 8 GB of 16 GB.',
      'Power 9.6 W (measured); cpu 51°C.',
      'Energy cost $0.04 today, $1.20 this month, $1.50 projected.',
      'Issue: Disk / is 91% full',
    ])
    const page = fleetDeviceContext({ ...d, detail: { disks: [{ mount: '/', size: 100e9, used: 91e9 }], gpu: null, processes: [{ name: 'node', cpu: 3, mem: 1 }, { name: 'claude', cpu: 40, mem: 2 }] } })
    expect(page.place).toBe('fleet.device')
    expect(page.lines.slice(-2)).toEqual(['Disk /: 91 GB of 100 GB (91%).', 'Top processes: claude 40% CPU, node 3% CPU.'])
  })

  it('a repository: CI, pull requests and runners', () => {
    const c = devRepoContext({
      repo: 'o/r', defaultBranch: 'main', aiReview: 'on',
      ci: [{ workflow: 'CI', state: 'failure', conclusion: 'failure', url: 'https://x/1' }],
      prs: [{ number: 7, title: 'Fix', draft: true, checks: 'passing', claude: 'success', url: 'https://x/7' }],
      runners: [{ name: 'box', status: 'online', busy: true }],
    })
    expect(c.lines).toEqual([
      'github.com/o/r, default branch main, AI review on.',
      'CI CI: failure https://x/1',
      'Open pull requests:',
      '- #7 Fix (draft): checks passing, AI review success https://x/7',
      'Runner box: online, busy',
    ])
  })

  it('shipped: counts per repo, without hidden repos, newest first', () => {
    const c = shippedContext({
      days: 30, hidden: ['o/hidden'],
      pulls: [
        { repo: 'o/a', number: 1, title: 'one', mergedAt: '2026-10-01T00:00:00Z' },
        { repo: 'o/a', number: 2, title: 'two', mergedAt: '2026-10-20T00:00:00Z' },
        { repo: 'o/b', number: 3, title: 'three', mergedAt: '2026-10-10T00:00:00Z' },
        { repo: 'o/hidden', number: 4, title: 'four', mergedAt: '2026-10-25T00:00:00Z' },
      ],
    })
    expect(c.lines).toEqual([
      '3 merged pull requests in the last 30 days.',
      'By repository: o/a 2, o/b 1.',
      'Latest:',
      '- 2026-10-20 o/a#2 two',
      '- 2026-10-10 o/b#3 three',
      '- 2026-10-01 o/a#1 one',
    ])
  })

  it('a settings pane: its outline, on its own place', () => {
    const c = settingsContext('voice', { items: [{ heading: 'Voice' }, { label: 'Dictation', state: 'on' }, { label: 'Voice', state: null }] })!
    expect(c.place).toBe('settings.voice')
    expect(c.title).toBe('Settings › Voice')
    expect(c.lines).toEqual(['Voice:', '- Dictation: on', '- Voice'])
    expect(settingsContext('nope', { items: [] })).toBeNull()
  })

  it('schedule: today in order, what is over or on now, and tomorrow', () => {
    const now = new Date(2026, 9, 30, 10, 30)
    const at = (h: number, m = 0) => new Date(2026, 9, 30, h, m).toISOString()
    const c = scheduleContext({
      allDay: [{ title: 'Holiday', start: '2026-10-30', allDay: true }],
      timed: [
        { title: 'Standup', start: at(9), end: at(9, 15) },
        { title: 'Review', start: at(10), end: at(11), location: 'Room 4, floor 2' },
      ],
      tomorrow: [{ title: 'Dentist', start: new Date(2026, 9, 31, 8).toISOString(), end: new Date(2026, 9, 31, 9).toISOString() }],
    }, now)
    expect(c.lines).toEqual([
      'Today, 2026-10-30, at 10:30:',
      '- All day: Holiday',
      '- 09:00–09:15 Standup (over)',
      '- 10:00–11:00 Review @ Room 4, floor 2 (now)',
      'Tomorrow:',
      '- 08:00–09:00 Dentist',
    ])
    expect(scheduleContext({ allDay: [], timed: [], tomorrow: [] }, now).lines[1]).toBe('Nothing on the calendar today.')
  })

  it('system tiles: quotas, failing jobs and activity', () => {
    const c = systemContext({
      quotas: [{ name: 'Claude', label: 'Weekly', remainingPct: 12.4 }, { name: 'Codex', remainingPct: null }],
      jobsOn: 3, jobsTotal: 5, failing: [{ name: 'Digest', error: 'timeout' }],
      nextJob: { name: 'Sync', nextRunAt: new Date(2026, 9, 30, 12, 0).getTime() }, requestsToday: 7,
    })
    expect(c.lines).toEqual([
      'AI limits, tightest window per account:',
      '- Claude: 12% of weekly left',
      '- Codex: no reading',
      'Jobs: 3 of 5 on, 1 failing.',
      '- Failing: Digest: timeout',
      'Next job: Sync at 2026-10-30 12:00.',
      'AI requests today: 7.',
    ])
  })
})

describe('size and secrets', () => {
  const LONG = 'L'.repeat(20000)

  it('a huge route is clipped', () => {
    const d = {
      id: LONG, name: 'm', os: null, online: false, lastSeen: null, bootedAt: null,
      uptime: { pct24h: null, pct7d: null, pct30d: null }, health: { level: 'ok', issues: [] }, now: null,
      energy: { todayCost: null, monthCost: null, projectedMonthCost: null },
    }
    expect(contextMarkdown(fleetDeviceContext(d), AT).length).toBeLessThan(4000)
  })

  it('one long line does not push out the facts after it', () => {
    const t = {
      id: 't', title: 'Tagged', status: 'todo', area: 'Ventures', ventureTag: LONG, description: 'the description',
      tags: Array.from({ length: 400 }, (_, i) => ({ name: `tag${i}` })),
      notes: [{ body: 'the note', createdAt: '2026-10-01T00:00:00Z' }],
    }
    const md = contextMarkdown(todoContext(t), AT)
    expect(md.length).toBeLessThan(4000)
    expect(md).toContain('Description: the description')
    expect(md).toContain('Note (2026-10-01): the note')
    expect(md).not.toContain('more not shown')
  })

  it('tokens in a card never reach the text', () => {
    const notes = [
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'ya29.a0AfH6SMBxyzxyzxyzxyzxyzxyzxyz',
      'Authorization: Bearer abc.def.ghi',
      'https://x.test/cb?code=1&token=SEKRIT123&key=SEKRIT456',
      'OPENAI_API_KEY=SEKRIT789',
    ]
    const md = contextMarkdown(todoContext({ id: 't', title: 'Rotate keys', notes: notes.map((body) => ({ body, createdAt: '2026-10-01' })) }), AT)
    for (const leak of ['ABCDEFGHIJKLMNOP', 'abcdefghijklmnop', 'a0AfH6SMB', 'abc.def.ghi', 'SEKRIT']) expect(md).not.toContain(leak)
    expect(redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toBe('[redacted github token]')
    expect(contextFileName({ place: 'todos', title: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', lines: [] })).not.toContain('abcdefghij')
  })
})
