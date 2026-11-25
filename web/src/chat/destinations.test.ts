import { describe, it, expect } from 'vitest'
import { matchScore, placeAfter, rankDestinations, slug, stripToken } from './destinations'
import type { Project } from './types'
import type { WorkTask } from '../work/groups'

const project = (id: string, name: string, updatedAt: number, parentId?: string): Project =>
  ({ id, name, instructions: '', createdAt: 0, updatedAt, ...(parentId ? { parentId } : {}) }) as Project
const task = (ref: string, title: string, extra: Partial<WorkTask> = {}): WorkTask =>
  ({ ref, kind: 'local', title, dueDate: null, priority: 1, done: false, status: '', updatedAt: 0, ...extra })

const projects = [
  project('lp', 'Work - Acme', 30),
  project('harbor', 'harbor', 1, 'lp'),
  project('mn', 'm+n', 1, 'lp'),
  project('wp', 'Ballpark', 20),
  project('gb', 'Sam Birthday research', 10),
]
const tasks = [
  task('t1', 'Update expense report', { dueDate: '2026-11-21' }),
  task('t2', 'Harbor site map fix', { dueDate: '2026-11-18' }),
  task('t3', 'Old thing', { done: true }),
  task('t4', 'Snoozed thing', { hidden: true }),
  task('sheet:1:2:abcd', 'Ballpark waiver copy', { kind: 'sheet' }),
]
const keys = (list: ReturnType<typeof rankDestinations>) => list.map((d) => d.key)

describe('slug and matchScore', () => {
  it('reaches names with spaces and punctuation', () => {
    expect(slug('Work - Acme')).toBe('work-acme')
    expect(slug('m+n')).toBe('m-n')
    expect(matchScore('Work - Acme', 'work')).toBe(0)
    expect(matchScore('Work - Acme', 'acm')).toBe(1)
    expect(matchScore('Sam Birthday research', 'birthday-re')).toBe(1)
    expect(matchScore('Ballpark', 'llpa')).toBe(2)
    expect(matchScore('m+n', 'mn')).toBe(2)
    expect(matchScore('harbor', 'acme', 'Work - Acme')).toBe(3)
    expect(matchScore('harbor', 'zzz')).toBe(-1)
    expect(matchScore('anything', '')).toBe(0)
  })
})

describe('rankDestinations', () => {
  const ctx = { projects, tasks, projectId: null, taskId: null }

  it('lists projects most recent first with their folders, then open tasks by due date', () => {
    // A bare `$` keeps to four places, so the tasks are in view under them.
    expect(keys(rankDestinations(ctx, ''))).toEqual([
      'p:lp', 'p:harbor', 'p:mn', 'p:wp',
      'new-task',
      't:t2', 't:t1', 't:sheet:1:2:abcd',
    ])
    expect(keys(rankDestinations(ctx, 'r'))).toContain('p:gb')
  })

  it('offers nothing for a price', () => {
    const withQ4 = { ...ctx, tasks: [...tasks, task('q4', 'Q4 planning')], projects: [...projects, project('y', '2027 plans', 40)] }
    expect(rankDestinations(withQ4, '4')).toEqual([])
    expect(rankDestinations(withQ4, '4.99')).toEqual([])
    expect(rankDestinations(withQ4, '1,000')).toEqual([])
    // A name that starts with a digit is still found once the term is more than a number.
    expect(keys(rankDestinations(withQ4, '2027-p'))).toEqual(['p:y'])
  })

  it('puts the best match first and finds folders by their project', () => {
    expect(keys(rankDestinations(ctx, 'harb'))).toEqual(['p:harbor', 't:t2'])
    expect(keys(rankDestinations(ctx, 'acme'))).toEqual(['p:lp', 'p:harbor', 'p:mn'])
    expect(keys(rankDestinations(ctx, 'ball'))).toEqual(['p:wp', 't:sheet:1:2:abcd'])
  })

  it('offers Home only away from it, and never where the chat already is', () => {
    expect(keys(rankDestinations(ctx, 'ho'))).toEqual([])
    const inFolder = { ...ctx, projectId: 'harbor', taskId: 't2' }
    expect(keys(rankDestinations(inFolder, 'ho'))).toEqual(['home'])
    expect(keys(rankDestinations(inFolder, 'harb'))).toEqual([])
  })

  it('leaves out done and snoozed tasks', () => {
    expect(keys(rankDestinations(ctx, 'thing'))).toEqual([])
  })
})

describe('stripToken', () => {
  it('takes the token out and keeps one space', () => {
    expect(stripToken('fix $cre the map', 4, 8)).toEqual({ value: 'fix the map', caret: 4 })
    expect(stripToken('$cre fix it', 0, 4)).toEqual({ value: 'fix it', caret: 0 })
    expect(stripToken('fix it $cre', 7, 11)).toEqual({ value: 'fix it', caret: 6 })
    expect(stripToken('$', 0, 1)).toEqual({ value: '', caret: 0 })
  })
})

describe('$task', () => {
  const ctx = { projects, tasks, projectId: null, taskId: null }

  it('leads with New task for $task, $new and $ta, and not for one letter or other words', () => {
    for (const term of ['task', 'tas', 'ta', 'new', 'ne', 'newtask', 'new-task']) expect(keys(rankDestinations(ctx, term))[0]).toBe('new-task')
    expect(keys(rankDestinations(ctx, 't'))).not.toContain('new-task')
    expect(keys(rankDestinations(ctx, 'harb'))).not.toContain('new-task')
    expect(keys(rankDestinations(ctx, 'tasks'))).not.toContain('new-task')
  })

  it('moves nothing when picked: the task is made first', () => {
    const now = { taskId: null, projectId: 'harbor' }
    expect(placeAfter(rankDestinations(ctx, 'task')[0], now, () => 'wp')).toEqual(now)
  })
})

describe('placeAfter', () => {
  const home = () => null
  it('a place keeps the task; a task takes its own folder, else stays put', () => {
    const now = { taskId: 't1', projectId: null }
    const folder = rankDestinations({ projects, tasks, projectId: null, taskId: null }, 'harbor')[0]
    expect(placeAfter(folder, now, home)).toEqual({ taskId: 't1', projectId: 'harbor' })
    expect(placeAfter({ kind: 'home', key: 'home', name: 'Home' }, { taskId: 't1', projectId: 'wp' }, home)).toEqual({ taskId: 't1', projectId: null })
    const t2 = { kind: 'task' as const, key: 't:t2', name: 'x', task: tasks[1] }
    expect(placeAfter(t2, { taskId: null, projectId: 'wp' }, home)).toEqual({ taskId: 't2', projectId: 'wp' })
    expect(placeAfter(t2, { taskId: null, projectId: 'wp' }, () => 'harbor')).toEqual({ taskId: 't2', projectId: 'harbor' })
  })
})
