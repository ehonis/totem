import { describe, it, expect } from 'vitest'
import { ghostDestinations, matchScore, nameFromTerm, placeAfter, rankDestinations, slug, stripToken } from './destinations'
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
      'new-task', 'ghost',
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
    expect(keys(rankDestinations(ctx, 'thing')).filter((k) => k.startsWith('t:'))).toEqual([])
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

describe('$ghost', () => {
  const ctx = { projects, tasks, projectId: null, taskId: null }

  it('leads with Ghost chat for $gh…, $temp… and $inco…, and not for shorter or other words', () => {
    for (const term of ['gh', 'ghost', 'temp', 'temporary', 'inco', 'incognito']) expect(keys(rankDestinations(ctx, term))[0]).toBe('ghost')
    for (const term of ['g', 'te', 'tem', 'in', 'ghosts', 'harb']) expect(keys(rankDestinations(ctx, term))).not.toContain('ghost')
  })

  it('moves the chat to Home, out of its project and task', () => {
    const ghost = rankDestinations(ctx, 'ghost')[0]
    expect(placeAfter(ghost, { taskId: 't1', projectId: 'harbor' }, () => 'wp')).toEqual({ taskId: null, projectId: null })
  })
})

describe('new folder from a name nothing has', () => {
  const ctx = { projects, tasks, projectId: null, taskId: null }
  const folders = (list: ReturnType<typeof rankDestinations>) => list.filter((d) => d.kind === 'new-folder')

  it('offers a new project at Home, last, named as typed', () => {
    const list = rankDestinations(ctx, 'tax-returns', 'tax-returns')
    expect(keys(list)).toEqual(['new-project'])
    expect(list[0].name).toBe('Tax returns')
    expect(rankDestinations(ctx, 'q4-plans', 'Q4-Plans')[0].name).toBe('Q4 Plans')
    // After any task it matches, so Enter still picks the task.
    expect(keys(rankDestinations(ctx, 'expense'))).toEqual(['t:t1', 'new-project'])
  })

  it('in a project or one of its folders, offers a folder in the project first', () => {
    const inFolder = { ...ctx, projectId: 'harbor' }
    const list = folders(rankDestinations(inFolder, 'receipts'))
    expect(list.map((d) => d.key)).toEqual(['new-folder:lp', 'new-project'])
    expect(list[0].kind === 'new-folder' && list[0].parent?.id).toBe('lp')
  })

  it('never for a name a place already has, a short term, a price or a word `$` keeps', () => {
    expect(folders(rankDestinations(ctx, 'harb'))).toEqual([])
    expect(folders(rankDestinations({ ...ctx, projectId: 'harbor' }, 'harbor'))).toEqual([])
    expect(folders(rankDestinations(ctx, 'zz'))).toEqual([])
    expect(folders(rankDestinations(ctx, '400'))).toEqual([])
    for (const term of ['task', 'ghost', 'temporary', 'hom', 'folder', 'project']) expect(folders(rankDestinations(ctx, term))).toEqual([])
  })

  it('moves nothing when picked: the folder is made first', () => {
    const now = { taskId: 't1', projectId: null }
    expect(placeAfter(rankDestinations(ctx, 'tax-returns')[0], now, () => null)).toEqual(now)
  })

  it('names keep his capitals', () => {
    expect(nameFromTerm('tax-returns')).toBe('Tax returns')
    expect(nameFromTerm('NYC-trip')).toBe('NYC trip')
  })
})

describe('$opus, $pin and $snooze', () => {
  const provider = (id: string, name: string, driver: string, supportsModelPicker = true) => ({ id, name, driver, supportsModelPicker })
  const models = [
    { provider: provider('claude', 'Claude', 'claude'), models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', favorite: true },
      { id: 'claude-opus-4', name: 'Claude Opus 4', hidden: true },
    ] },
    { provider: provider('codex', 'Codex', 'codex'), models: [{ id: 'gpt-5.5-codex', name: 'GPT-5.5 Codex' }] },
    { provider: provider('cursor', 'Cursor', 'cursor', false), models: [] },
  ]
  const ctx = { projects, tasks, projectId: null, taskId: null, models, startOptions: true, now: new Date(2026, 10, 25, 10, 0) }

  it('finds models by a word of their name or id, never a hidden one, and an account by its name', () => {
    expect(keys(rankDestinations(ctx, 'opus'))).toEqual(['m:claude:claude-opus-5-5'])
    expect(keys(rankDestinations(ctx, 'sonnet'))).toEqual(['m:claude:claude-sonnet-5-5'])
    // The account itself first (its default), then its models; favourites before the rest.
    expect(keys(rankDestinations(ctx, 'claude'))).toEqual(['m:claude:', 'm:claude:claude-sonnet-5-5', 'm:claude:claude-opus-5-5'])
    expect(keys(rankDestinations(ctx, 'codex'))).toEqual(['m:codex:', 'm:codex:gpt-5.5-codex'])
    // An account with no model list is offered as itself.
    expect(keys(rankDestinations(ctx, 'cursor'))).toEqual(['m:cursor:'])
    // A model's name is taken: no New project "Opus".
    expect(rankDestinations(ctx, 'opus').some((d) => d.kind === 'new-folder')).toBe(false)
    expect(keys(rankDestinations(ctx, 'o')).some((k) => k.startsWith('m:'))).toBe(false)
  })

  it('offers Pin it for $pi, unless it is pinned already or the chat view cannot', () => {
    expect(keys(rankDestinations(ctx, 'pi'))[0]).toBe('pin')
    expect(keys(rankDestinations({ ...ctx, pinned: true }, 'pin'))).not.toContain('pin')
    expect(keys(rankDestinations({ ...ctx, startOptions: false }, 'pin'))).not.toContain('pin')
  })

  it('lists the snooze times for $snooze, $later and $remind, and narrows with $snooze-tom', () => {
    for (const term of ['sn', 'snooze', 'later', 'rem']) expect(keys(rankDestinations(ctx, term))).toContain('snooze:tomorrow')
    expect(keys(rankDestinations(ctx, 'snooze-tom'))).toEqual(['snooze:tomorrow'])
    const tomorrow = rankDestinations(ctx, 'snooze-tom')[0]
    expect(tomorrow.kind === 'snooze' && new Date(tomorrow.until).getDate()).toBe(26)
    expect(keys(rankDestinations({ ...ctx, startOptions: false }, 'snooze'))).toEqual([])
    expect(keys(rankDestinations(ctx, 'la'))).not.toContain('snooze:tomorrow')
  })

  it('none of them move the chat', () => {
    const now = { taskId: 't1', projectId: 'harbor' }
    for (const term of ['opus', 'pin', 'snooze-tom']) expect(placeAfter(rankDestinations(ctx, term)[0], now, () => 'wp')).toEqual(now)
  })
})

describe('ghostDestinations', () => {
  it('offers only the way out, for a bare $ or a word that asks for it', () => {
    expect(ghostDestinations('', false)).toEqual([{ kind: 'leave-ghost', key: 'leave-ghost', name: 'Regular chat', started: false }])
    for (const t of ['re', 'regular', 'back', 'ba', 'keep', 'normal', 'exit', 'unghost', 'leave', 'gh', 'off']) {
      expect(ghostDestinations(t, false).map((d) => d.kind)).toEqual(['leave-ghost'])
    }
    expect(ghostDestinations('back', true)[0]).toMatchObject({ name: 'Keep this chat', started: true })
  })

  it('offers nothing for a price or any other word, so Enter sends it', () => {
    expect(ghostDestinations('40', false)).toEqual([])
    expect(ghostDestinations('r', false)).toEqual([])
    expect(ghostDestinations('harbor', false)).toEqual([])
  })

  it('leaves to Home, out of any task', () => {
    expect(placeAfter(ghostDestinations('back', false)[0], { taskId: 't1', projectId: 'wp' }, () => 'wp')).toEqual({ taskId: null, projectId: null })
  })
})
