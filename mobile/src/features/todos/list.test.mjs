// The Tasks page's rows (list.ts over the shared buildList), the swipe, the inline
// Undo line's words (undo.ts), the issue-link field (issueLink.ts), and the rules the
// screens must keep: no Doing anywhere, sheet rows read-only, no success toasts.
// node strips the modules' types; they import nothing from React Native.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DONE_BEAT_MS, isFiltering, leftToday, linkParts, listRows, sheetAsTaskPriority, nextDue, orderNeighbours, sheetName, sheetNote, sheetOnlyEmpty, spokenState, swipeRight, taskQuery, visibleSheet,
} from './list.ts'
import { UNDO_MS, UNDO_READER_MS, once, undoLineTimeout, undoText } from './undo.ts'
import { freshRead } from './freshRead.ts'
import { askOncePerKey, createIssueStatesLoader, readIssueLink, sameStates, shouldAskIssueState } from './issueLink.ts'
import {
  afterDone, byWake, doneToday, morningSnooze, moveBeside, nextWake, rolledOccurrence, rollsOnCompletion, wakeLabel,
} from './board.ts'

const NOW = new Date(2026, 10, 4, 10, 0, 0) // Wed 4 Nov 2026, 10:00 local
const here = dirname(fileURLToPath(import.meta.url))
const features = join(here, '..')
const app = join(features, '..', 'app', 'todo')

let seq = 0
function todo(fields = {}) {
  seq += 1
  return {
    id: fields.id ?? `t${seq}`, title: `Task ${seq}`, description: '', area: 'Personal', ventureTag: null,
    status: 'todo', priority: 1, dueDate: null, recurrence: null, snoozedUntil: null, position: seq * 1024,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', completedAt: null, outcome: null,
    archivedAt: null, deletedAt: null, tags: [], notes: [], relations: [], lists: [], externalLinks: [], issueLink: null,
    syncState: { status: 'idle', pending: 0, conflicts: 0, exhausted: 0, missing: false, lastSuccessAt: null, lastError: null },
    ...fields,
  }
}
function row(fields = {}) {
  seq += 1
  return { id: `sheet:0:${seq}:0000abcd`, row: seq, title: `Row ${seq}`, who: 'Alex', priority: null, status: 'Not Started', dueDate: null, notes: '', url: `https://sheets.example/x#gid=0&range=B${seq}`, ...fields }
}
const opts = (over = {}) => ({ now: NOW, completedOpen: false, showAllDone: false, archiveCount: 0, ...over })
const shape = (rows) => rows.map((r) => r.kind === 'card' ? `${r.section}:${r.todo.id}` : r.kind === 'sheet' ? `${r.section}:${r.item.title}` : r.kind === 'header' ? `[${r.title} ${r.count}]` : `<${r.kind}${r.scope ? ` ${r.scope}` : ''}${r.count !== undefined ? ` ${r.count}` : ''}>`)

/* ------------------------------------------------------------------ */
/* The groups                                                          */
/* ------------------------------------------------------------------ */

test('one set of due groups, with the sheet’s rows mixed in by the same rules, and Completed folded', () => {
  const tasks = [
    todo({ id: 'none' }), todo({ id: 'late', dueDate: '2026-11-01' }), todo({ id: 'soon', dueDate: '2026-11-09' }),
    todo({ id: 'now', dueDate: '2026-11-04' }),
    todo({ id: 'fin', status: 'done', completedAt: '2026-11-04T09:00:00.000Z' }),
  ]
  const sheet = [row({ title: 'HQ late', dueDate: '2026-11-02' }), row({ title: 'HQ today', dueDate: '2026-11-04', priority: 1 }), row({ title: 'HQ undated' })]
  assert.deepEqual(shape(listRows(tasks, sheet, opts())), [
    '[Overdue 2]', 'overdue:late', 'overdue:HQ late',
    '[Today 2]', 'today:HQ today', 'today:now',
    '[Upcoming 1]', 'upcoming:soon',
    '[No date 2]', 'nodate:none', 'nodate:HQ undated',
    '[Completed 1]',
  ])
})

test('inside a group: due day, then priority, then tasks before sheet rows, then manual position', () => {
  const tasks = [
    todo({ id: 'p4-first', dueDate: '2026-11-04', priority: 1, position: 0 }),
    todo({ id: 'p1', dueDate: '2026-11-04', priority: 4, position: 9000 }),
    todo({ id: 'p4-second', dueDate: '2026-11-04', priority: 1, position: 100 }),
  ]
  const sheet = [row({ title: 'HQ high', dueDate: '2026-11-04', priority: 1 }), row({ title: 'HQ blank', dueDate: '2026-11-04' })]
  // A P1 due today no longer sits under a P4 placed above it by hand.
  assert.deepEqual(shape(listRows(tasks, sheet, opts())).slice(1), ['today:p1', 'today:HQ high', 'today:p4-first', 'today:p4-second', 'today:HQ blank'])
})

test('no Doing group: a "doing" task from an old cached answer is an open task where its date puts it', () => {
  const rows = listRows([todo({ id: 'busy', status: 'doing', dueDate: '2026-11-09' }), todo({ id: 'x', dueDate: '2026-11-01' })], [], opts())
  assert.deepEqual(shape(rows), ['[Overdue 1]', 'overdue:x', '[Upcoming 1]', 'upcoming:busy'])
  assert.ok(!rows.some((r) => r.kind === 'header' && /doing/i.test(r.title)))
})

test('snoozed, binned and archived tasks are not drawn even from a stale copy', () => {
  const rows = listRows([
    todo({ id: 'asleep', snoozedUntil: new Date(2026, 10, 5).toISOString() }), todo({ id: 'bin', deletedAt: '2026-11-03T00:00:00Z' }),
    todo({ id: 'arch', archivedAt: '2026-11-03T00:00:00Z' }), todo({ id: 'woke', snoozedUntil: new Date(2026, 10, 3).toISOString() }),
  ], [], opts())
  assert.deepEqual(shape(rows), ['<clear today>', '[No date 1]', 'nodate:woke'])
})

test('Completed opens newest first, capped with a "more" row and the archive below', () => {
  const tasks = [
    todo({ id: 'old', status: 'done', completedAt: '2026-11-01T09:00:00.000Z' }),
    todo({ id: 'new', status: 'done', completedAt: '2026-11-04T09:00:00.000Z' }),
    todo({ id: 'mid', status: 'done', completedAt: '2026-11-02T09:00:00.000Z' }),
    todo({ id: 'open' }),
  ]
  const rows = listRows(tasks, [], opts({ completedOpen: true, doneLimit: 2, archiveCount: 40 }))
  assert.deepEqual(shape(rows), ['<clear today>', '[No date 1]', 'nodate:open', '[Completed 3]', 'done:new', 'done:mid', '<more 1>', '<archive 40>'])
  assert.deepEqual(shape(listRows(tasks, [], opts({ completedOpen: true, doneLimit: 2, showAllDone: true }))).slice(4, 7), ['done:new', 'done:mid', 'done:old'])
})

test('all clear: nothing open, or nothing due today; a sheet row due today counts as work', () => {
  const finished = [todo({ status: 'done', completedAt: '2026-11-04T09:00:00.000Z' })]
  assert.deepEqual(shape(listRows(finished, [], opts())), ['<clear all>', '[Completed 1]'])
  assert.deepEqual(shape(listRows([todo({ id: 'later', dueDate: '2026-11-10' })], [], opts())), ['<clear today>', '[Upcoming 1]', 'upcoming:later'])
  assert.equal(listRows([], [row({ dueDate: '2026-11-04' })], opts())[0].kind, 'header')
  assert.equal(listRows([], [row({ dueDate: '2026-11-03' })], opts())[0].kind, 'header')
  // A filtered view never claims the day is clear.
  assert.equal(listRows(finished, [], opts({ filtered: true }))[0].kind, 'header')
  assert.deepEqual(listRows([], [], opts()), [])
})

test('"N left today" counts open tasks and sheet rows due today or late, nothing else', () => {
  const tasks = [
    todo({ dueDate: '2026-11-04' }), todo({ dueDate: '2026-10-30' }), todo({ dueDate: '2026-11-05' }), todo(),
    todo({ dueDate: '2026-11-04', status: 'done', completedAt: '2026-11-04T09:00:00Z' }),
    todo({ dueDate: '2026-11-04', snoozedUntil: new Date(2026, 10, 4, 18).toISOString() }),
  ]
  assert.equal(leftToday(tasks, [row({ dueDate: '2026-11-04' }), row({ dueDate: '2026-11-08' })], NOW), 3)
  assert.equal(leftToday([], [], NOW), 0)
})

test('next due is the earliest upcoming date, a sheet row’s included', () => {
  const rows = listRows([todo({ dueDate: '2026-11-30', priority: 4 }), todo({ dueDate: '2026-11-12' })], [row({ dueDate: '2026-11-08' })], opts())
  assert.equal(nextDue(rows), '2026-11-08')
  assert.equal(nextDue(listRows([todo()], [], opts())), null)
})

/* ------------------------------------------------------------------ */
/* Filters and the sheet                                               */
/* ------------------------------------------------------------------ */

test('the task filter a list query stands for; the sheet alone shows no tasks', () => {
  assert.deepEqual(taskQuery({ search: 'bank', scope: 'Ventures', priority: 4, due: 'today' }), { search: 'bank', area: 'Ventures', ventureTag: '', priority: 4, due: 'today' })
  assert.equal(taskQuery({ scope: 'sheet' }), null)
  assert.equal(isFiltering({}), false)
  assert.equal(isFiltering({ scope: 'sheet' }), true)
})

test('sheet rows follow search, priority and due, and leave when an area or venture is chosen', () => {
  const rows = [row({ title: 'Order chalk', priority: 1, dueDate: '2026-11-04' }), row({ title: 'Call the landlord', notes: 'lease', dueDate: null }), row({ title: 'Late', dueDate: '2026-11-01', priority: 3 })]
  assert.deepEqual(visibleSheet(rows, { search: 'LEASE' }, NOW).map((r) => r.title), ['Call the landlord'])
  // By meaning: nothing on the sheet is P1 Urgent; High is P2 High; Medium and Low are found under P3; blank is P4.
  assert.deepEqual(visibleSheet(rows, { priority: 4 }, NOW), [])
  assert.deepEqual(visibleSheet(rows, { priority: 3 }, NOW).map((r) => r.title), ['Order chalk'])
  assert.deepEqual(visibleSheet(rows, { priority: 2 }, NOW).map((r) => r.title), ['Late'])
  assert.deepEqual(visibleSheet(rows, { priority: 1 }, NOW).map((r) => r.title), ['Call the landlord'])
  assert.deepEqual([1, 2, 3, null].map(sheetAsTaskPriority), [3, 2, 2, 1])
  assert.deepEqual(visibleSheet(rows, { due: 'none' }, NOW).map((r) => r.title), ['Call the landlord'])
  assert.deepEqual(visibleSheet(rows, { due: 'overdue' }, NOW).map((r) => r.title), ['Late'])
  assert.deepEqual(visibleSheet(rows, { scope: 'Personal' }, NOW), [])
  assert.deepEqual(visibleSheet(rows, { ventureTag: 'Anything' }, NOW), [])
  assert.equal(visibleSheet(rows, { scope: 'sheet' }, NOW).length, 3)
})

test('one name for the source: the feed’s title, else "Task sheet"', () => {
  assert.equal(sheetName({ configured: true, title: 'Ops Board', url: 'x', fetchedAt: null, stale: false, error: null, items: [] }), 'Ops Board')
  assert.equal(sheetName({ configured: true, url: 'x', fetchedAt: null, stale: false, error: 'boom', items: [] }), 'Task sheet')
  assert.equal(sheetName({ configured: false, items: [], reason: 'Set TASK_SHEET_ID' }), 'Task sheet')
  assert.equal(sheetName(null), 'Task sheet')
  // No screen spells another name for it.
  for (const file of sources()) assert.doesNotMatch(read(file), new RegExp(['Action Items', 'Wall' + 'Pass'].join('|')), `${file} names the sheet itself`)
})

test('the sheet line: stale or failed says so once; not set up says nothing; set up and empty says nothing is assigned', () => {
  const base = { configured: true, title: 'Ops Board', url: 'x', fetchedAt: '2026-11-04T09:00:00Z', stale: false, error: null }
  assert.equal(sheetNote({ ...base, items: [row()] }, ''), null)
  assert.deepEqual(sheetNote({ ...base, items: [] }, ''), { tone: 'quiet', text: 'Nothing open in Ops Board is assigned to you.' })
  assert.equal(sheetNote({ ...base, items: [row()], stale: true, error: 'quota' }, '').tone, 'problem')
  assert.match(sheetNote({ ...base, items: [row()], stale: true, error: 'quota' }, '').text, /could not refresh; last read /)
  // A sheet read once and now failing says "could not refresh" even when that read found nothing.
  assert.match(sheetNote({ ...base, items: [], stale: true, error: 'quota' }, '').text, /could not refresh/)
  assert.match(sheetNote({ ...base, fetchedAt: null, items: [], error: 'denied' }, '').text, /could not load/)
  assert.equal(sheetNote({ configured: false, items: [], reason: 'Set it' }, ''), null)
  assert.match(sheetNote(null, 'Network request failed').text, /^Task sheet could not load/)
  assert.equal(sheetNote(null, ''), null)
})

test('the sheet alone, with nothing to draw: set up, not set up, failed and still reading each say their own thing', () => {
  assert.match(sheetOnlyEmpty('Ops Board', true, '').title, /^Nothing in Ops Board for you/)
  assert.equal(sheetOnlyEmpty('Task sheet', false, '').title, 'The task sheet is not set up')
  // No feed yet is not "not set up": a failed read says so, with its error; a read still out says it is reading.
  const failed = sheetOnlyEmpty('Task sheet', null, 'Network request failed')
  assert.equal(failed.title, 'Task sheet could not be read')
  assert.match(failed.body, /Network request failed/)
  assert.doesNotMatch(failed.title + failed.body, /not set up|Settings/)
  assert.match(sheetOnlyEmpty('Task sheet', null, '').title, /^Reading Task sheet/)
})

test('sheet rows are read-only: no check circle, no swipe, nothing that writes', () => {
  const card = read(join(features, 'todos/SheetCard.tsx'))
  assert.doesNotMatch(card, /CheckCircle|Swipeable|onMove|moveBoardTodo|updateBoardTodo|lib\/api/)
  const detail = read(join(features, 'todos/SheetItemPage.tsx'))
  assert.match(detail, /Open in/)
  assert.doesNotMatch(detail, /\b(updateBoardTodo|moveBoardTodo|createBoardTodo|sendJSON|TextInput)\b/)
  // The page hands a sheet row to SheetCard, never to TodoCard, and the task route sends a sheet id to the read-only page.
  const view = read(join(features, 'productivity/TodosView.tsx'))
  assert.match(view, /row\.kind === 'sheet'[\s\S]{0,200}<SheetCard/)
  const route = read(join(features, 'todos/TodoDetailScreen.tsx'))
  assert.match(route, /if \(isSheetId\(id\)\) return <SheetRow\b/)
  assert.match(route, /function SheetRow[\s\S]{0,2500}<SheetItemPage\b/)
})

/* ------------------------------------------------------------------ */
/* Gestures, order, Undo                                               */
/* ------------------------------------------------------------------ */

test('swipe right is the circle: an open task is done, a finished one reopens; never "Start"', () => {
  assert.deepEqual(swipeRight({ status: 'todo' }), { to: 'done', label: 'Done' })
  assert.deepEqual(swipeRight({ status: 'doing' }), { to: 'done', label: 'Done' })
  assert.deepEqual(swipeRight({ status: 'done' }), { to: 'todo', label: 'Reopen' })
  const card = read(join(features, 'todos/TodoCard.tsx'))
  // The swipe goes through check(), so it gets the circle's buzz and its 650 ms beat.
  assert.match(card, /onSwipeableOpen=\{[\s\S]{0,500}check\(\)/)
  assert.equal(DONE_BEAT_MS, 650)
  assert.doesNotMatch(card, /'Start'|label: 'Start'/)
})

test('move up/down passes only a task its manual position put there: same group, day and priority', () => {
  const tasks = [
    todo({ id: 'a', dueDate: '2026-11-04' }), todo({ id: 'b', dueDate: '2026-11-04' }),
    todo({ id: 'p1', dueDate: '2026-11-04', priority: 4 }), todo({ id: 'c' }), todo({ id: 'd' }),
    todo({ id: 'e', dueDate: '2026-11-10' }), todo({ id: 'f', dueDate: '2026-11-11' }),
  ]
  const near = orderNeighbours(listRows(tasks, [row({ dueDate: '2026-11-04' })], opts()))
  assert.deepEqual(near.get('p1'), { up: null, down: null })
  assert.deepEqual(near.get('a'), { up: null, down: 'b' })
  assert.deepEqual(near.get('b'), { up: 'a', down: null })
  assert.deepEqual(near.get('c'), { up: null, down: 'd' })
  assert.deepEqual(near.get('e'), { up: null, down: null }, 'a different due day is the date’s order, not the owner’s')
})

test('moveBeside puts a task just before or after the card it passes, across hidden ones', () => {
  const ids = ['a', 'hidden', 'b', 'c']
  assert.deepEqual(moveBeside(ids, 'b', 'a', -1), ['b', 'a', 'hidden', 'c'])
  assert.deepEqual(moveBeside(ids, 'a', 'b', 1), ['hidden', 'b', 'a', 'c'])
  assert.equal(moveBeside(ids, 'a', 'a', 1), null)
})

test('the inline Undo line: words for complete, snooze, not doing and delete, and no Undo for a rolled repeat', () => {
  assert.deepEqual(undoText('done', { title: 'Call the bank' }, { followUp: { kind: 'undo' } }), { text: 'Done: “Call the bank”', undoable: true })
  assert.deepEqual(undoText('done', { title: 'Weekly review' }, { followUp: { kind: 'next', dueDate: null } }), { text: 'Done: “Weekly review”', undoable: false })
  assert.equal(undoText('done', { title: 'Weekly review' }, { followUp: { kind: 'next', dueDate: '2026-11-15' } }).undoable, false)
  assert.deepEqual(undoText('snooze', { title: 'x' }, { until: 'tomorrow 9:00 AM' }), { text: 'Snoozed until tomorrow 9:00 AM', undoable: true })
  assert.deepEqual(undoText('notDoing', { title: 'x' }), { text: 'Not doing “x”', undoable: true })
  assert.deepEqual(undoText('delete', { title: 'x' }), { text: '“x” moved to the recycle bin', undoable: true })
  assert.match(undoText('done', { title: 'y'.repeat(60) }).text, /…”$/)
  assert.equal(UNDO_MS, 8000)
})

test('a sheet High ranks with a task P2, below a task P1 Urgent, in the app’s list too', () => {
  const rows = listRows([
    todo({ id: 'urgent', dueDate: '2026-11-04', priority: 4 }), todo({ id: 'high', dueDate: '2026-11-04', priority: 3 }),
    todo({ id: 'medium', dueDate: '2026-11-04', priority: 2 }),
  ], [row({ title: 'HQ High', dueDate: '2026-11-04', priority: 1 }), row({ title: 'HQ Medium', dueDate: '2026-11-04', priority: 2 }), row({ title: 'HQ Low', dueDate: '2026-11-04', priority: 3 })], opts())
  assert.deepEqual(shape(rows).slice(1), ['today:urgent', 'today:high', 'today:HQ High', 'today:medium', 'today:HQ Medium', 'today:HQ Low'])
})

test('a sheet note’s links can be tapped; the words around them stay text', () => {
  assert.deepEqual(linkParts('See https://docs.example/waiver. Then call.'), [
    { text: 'See ' }, { text: 'https://docs.example/waiver', url: 'https://docs.example/waiver' }, { text: '. Then call.' },
  ])
  assert.deepEqual(linkParts('(http://a.example/x?y=1)'), [{ text: '(' }, { text: 'http://a.example/x?y=1', url: 'http://a.example/x?y=1' }, { text: ')' }])
  assert.deepEqual(linkParts('no links here'), [{ text: 'no links here' }])
  // A balanced bracket is the URL's own; an unbalanced one and sentence punctuation are not.
  assert.deepEqual(linkParts('See https://en.wikipedia.org/wiki/Foo_(bar).'), [
    { text: 'See ' }, { text: 'https://en.wikipedia.org/wiki/Foo_(bar)', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' }, { text: '.' },
  ])
  assert.deepEqual(linkParts('(see https://en.wikipedia.org/wiki/Foo_(bar))'), [
    { text: '(see ' }, { text: 'https://en.wikipedia.org/wiki/Foo_(bar)', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' }, { text: ')' },
  ])
  assert.equal(linkParts('https://a.example/x],').find((part) => part.url).url, 'https://a.example/x')
  assert.deepEqual(linkParts(''), [])
  assert.match(read(join(features, 'todos/SheetItemPage.tsx')), /linkParts\(item\.notes\)\.map\(\(\{ text, url \}[\s\S]{0,300}openUrl\(url\)/)
})

test('the Undo line runs once, however fast it is tapped, and stays up as long as UNDO_MS', () => {
  let runs = 0
  const press = once(() => { runs += 1 })
  assert.equal(press(), true)
  assert.equal(press(), false)
  assert.equal(press(), false)
  assert.equal(runs, 1)
  assert.equal(undoLineTimeout(false), UNDO_MS)
})

test('with a screen reader on, the Undo line stays two minutes, so VoiceOver can reach it, but not for ever', () => {
  assert.equal(undoLineTimeout(true), UNDO_READER_MS)
  assert.equal(UNDO_READER_MS, 120_000)
  assert.ok(undoLineTimeout(true) > undoLineTimeout(false))
})

test('the swipe’s Done label is dark ink on the green, not white', () => {
  const card = read(join(features, 'todos/TodoCard.tsx'))
  assert.match(card, /icon: CheckIcon, color: colors\.green, ink: SWIPE_DONE_INK/)
})

test('the phone shows error toasts only: Undo is the inline line, never a toast', () => {
  for (const file of sources()) {
    const source = read(file)
    assert.doesNotMatch(source, /pushToast\(/, `${file} pushes a toast; use the inline UndoLine (errors go through pushError)`)
  }
  const view = read(join(features, 'productivity/TodosView.tsx'))
  assert.match(view, /<UndoLine\b/)
})

test('no Doing anywhere in the Tasks screens', () => {
  for (const file of sources()) {
    const source = read(file)
    assert.doesNotMatch(source, /'doing'|"doing"|\bDoing\b|in progress'|Start now|moveBoardTodo\([^)]*'doing'/, `${file} still speaks of Doing`)
  }
})

test('VoiceOver: a card’s status says only what is not the default', () => {
  assert.equal(spokenState({ status: 'todo', outcome: null }), null)
  assert.equal(spokenState({ status: 'doing', outcome: null }), null)
  assert.equal(spokenState({ status: 'done', outcome: 'completed' }), 'done')
  assert.equal(spokenState({ status: 'done', outcome: 'not_doing' }), 'not doing')
})

test('the issue field takes an issue link or owner/repo#n, and refuses a pull request', () => {
  assert.deepEqual(readIssueLink(' https://github.com/acme/site/issues/12?x=1 '), { url: 'https://github.com/acme/site/issues/12' })
  assert.deepEqual(readIssueLink('acme/site#7'), { url: 'https://github.com/acme/site/issues/7' })
  assert.match(readIssueLink('https://github.com/acme/site/pull/3').error, /pull request/)
  assert.match(readIssueLink('http://github.com/acme/site/issues/3').error, /Paste a GitHub issue link/)
  assert.match(readIssueLink('acme/site#0').error, /starts at 1/)
})

test('an empty issue-states answer causes no second request from an open task page', async () => {
  // The task page's effect (TodoDetailScreen TaskPage): it runs again whenever the stored
  // states change, and asks when this task's state is unknown, once per issue.
  let stored = {}
  let changes = 0
  let requests = 0
  const load = createIssueStatesLoader(async () => { requests += 1; return { fetchedAt: null, states: {} } }, () => stored, (next) => { stored = next; changes += 1 })
  const askOnce = askOncePerKey()
  const key = 'acme/site#7'
  let seen = null
  for (let render = 0; render < 5 && seen !== stored; render += 1) {
    seen = stored
    if (!stored[key] && askOnce(key)) await load()
  }
  assert.equal(requests, 1)
  assert.equal(changes, 0, 'an answer equal to what is stored is not stored again')
  // Even if the store did change, the page asks for one issue once.
  assert.equal(askOnce(key), false)
  assert.equal(askOnce('acme/site#8'), true)
})

test('a task page asks for its issue state only when it links one the states do not know, and only once', () => {
  const askOnce = askOncePerKey()
  assert.equal(shouldAskIssueState('', {}, askOnce), false)
  assert.equal(shouldAskIssueState('acme/site#7', { 'acme/site#7': { state: 'open' } }, askOnce), false)
  assert.equal(shouldAskIssueState('acme/site#7', {}, askOnce), true)
  assert.equal(shouldAskIssueState('acme/site#7', {}, askOnce), false)
})

test('issue states are read through freshRead: a call made while a read is out gets a read of its own after it', async () => {
  // A link set while a read is out must be answered for, so the store's loader is freshRead over the states loader.
  let stored = {}
  let requests = 0
  const answers = [{ 'a/b#1': { state: 'open', title: 'T', url: 'u' } }, { 'a/b#1': { state: 'open', title: 'T', url: 'u' }, 'a/b#2': { state: 'closed', title: 'U', url: 'v' } }]
  let finish
  const load = freshRead(createIssueStatesLoader(() => { const states = answers[requests++]; return new Promise((resolve) => { finish = () => resolve({ states }) }) }, () => stored, (next) => { stored = next }))
  const first = load()
  const second = load()
  finish()
  await first
  await new Promise((resolve) => setImmediate(resolve))
  finish()
  await second
  assert.equal(requests, 2)
  assert.ok(stored['a/b#2'], 'the second read answered for the link set while the first was out')
  const store = read(join(features, 'todos/store.ts'))
  assert.match(store, /export const loadIssueStates: \(\) => Promise<void> = freshRead\(createIssueStatesLoader\(/)
})

test('the Tasks screens never say "Todos"', () => {
  for (const file of sources()) assert.doesNotMatch(read(file), /["'`>]Todos\b/, `${file} says Todos`)
})

test('issue states: equal answers are the same; an error with nothing keeps the dots; a new answer is stored', async () => {
  const open = { 'a/b#1': { state: 'open', title: 'T', url: 'u' } }
  assert.equal(sameStates(open, { 'a/b#1': { state: 'open', title: 'T', url: 'u' } }), true)
  assert.equal(sameStates(open, { 'a/b#1': { state: 'closed', title: 'T', url: 'u' } }), false)
  assert.equal(sameStates(open, {}), false)
  let stored = open
  const set = (next) => { stored = next }
  await createIssueStatesLoader(async () => ({ states: {}, error: 'gh failed' }), () => stored, set)()
  assert.equal(stored, open)
  await createIssueStatesLoader(async () => { throw new Error('offline') }, () => stored, set)()
  assert.equal(stored, open)
  const closed = { 'a/b#1': { state: 'closed', title: 'T', url: 'u' } }
  await createIssueStatesLoader(async () => ({ states: closed }), () => stored, set)()
  assert.equal(stored, closed)
})

/* ------------------------------------------------------------------ */
/* Shared helpers the page uses, through features/todos/board.ts       */
/* ------------------------------------------------------------------ */

test('done today counts finished work from today only, and not "not doing"', () => {
  const tasks = [
    todo({ status: 'done', completedAt: new Date(2026, 10, 4, 8, 30).toISOString() }),
    todo({ status: 'done', completedAt: new Date(2026, 10, 4, 9, 45).toISOString(), outcome: 'not_doing' }),
    todo({ status: 'done', completedAt: new Date(2026, 10, 3, 23, 59).toISOString() }),
  ]
  assert.equal(doneToday(tasks, NOW), 1)
})

test('next wake and wake labels', () => {
  const a = { id: 'a', snoozedUntil: new Date(2026, 10, 5, 9).toISOString() }
  const b = { id: 'b', snoozedUntil: new Date(2026, 10, 4, 18).toISOString() }
  assert.equal(nextWake([a, b], NOW)?.getTime(), new Date(2026, 10, 4, 18).getTime())
  assert.deepEqual(byWake([a, b]).map((t) => t.id), ['b', 'a'])
  assert.match(wakeLabel(new Date(2026, 10, 5, 9), NOW), /^tomorrow /)
})

test('after Done: Undo for a plain task, the next due date for one that rolled', () => {
  const weekly = todo({ id: 'w', title: 'Weekly review', recurrence: 'weekly', dueDate: '2026-11-08' })
  const next = todo({ id: 'n', title: 'Weekly review', recurrence: 'weekly', dueDate: '2026-11-15' })
  assert.equal(rollsOnCompletion(weekly), true)
  assert.equal(rolledOccurrence(weekly, new Set(['w']), [next])?.id, 'n')
  assert.deepEqual(afterDone(weekly, new Set(['w']), [{ ...weekly, status: 'done' }, next]), { kind: 'next', dueDate: '2026-11-15' })
  assert.deepEqual(afterDone(todo({ id: 'p' }), new Set(['p']), []), { kind: 'undo' })
})

test('an issue-linked weekly task rolls like any other: the next occurrence is read in and no Undo is offered', () => {
  const link = { connector: 'github', externalId: 'acme/site#12', externalUrl: 'https://github.com/acme/site/issues/12', lastSyncedAt: null }
  const weekly = todo({ id: 'w', title: 'Weekly review', recurrence: 'weekly', dueDate: '2026-11-04', externalLinks: [link] })
  const next = todo({ id: 'n', title: 'Weekly review', recurrence: 'weekly', dueDate: '2026-11-11' })
  assert.equal(rollsOnCompletion(weekly), true)
  const followUp = afterDone(weekly, new Set(['w']), [{ ...weekly, status: 'done' }, next])
  assert.deepEqual(followUp, { kind: 'next', dueDate: '2026-11-11' })
  assert.equal(undoText('done', weekly, { followUp }).undoable, false)
})

test('the one-tap morning snooze is tomorrow at nine, or this morning before five', () => {
  assert.equal(morningSnooze(new Date(2026, 10, 4, 22, 30)).label, 'Tomorrow')
  assert.equal(morningSnooze(new Date(2026, 10, 5, 1, 15)).label, 'This morning')
})

/* ------------------------------------------------------------------ */

function read(path) { return readFileSync(path, 'utf8') }
/** The Tasks screens' source files: features/todos/**, the Tasks page, and the task routes. Tests are left out. */
function sources() {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })
  const files = [...walk(join(features, 'todos')), join(features, 'productivity/TodosView.tsx'), ...walk(app)]
  return files.filter((file) => !relative(features, file).includes('.test.'))
}
