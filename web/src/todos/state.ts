// Search and sort over the task list, for the web's Tasks page (the list's grouping
// is todos/board.ts buildList, shared with the iPhone app).
import type { Todo, TodoDueFilter, TodoQuery, TodoSort, TodoSortOrder } from './types'
import { todoSource } from './types'

function githubIdentifiers(todo: Todo): string[] {
  return todo.externalLinks.flatMap(link => {
    if (link.connector !== 'github') return []
    const match = link.externalUrl?.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i)
    if (!match) return [link.externalId]
    const [, owner, repo, issue] = match
    return [link.externalId, `${repo}#${issue}`, `${owner}/${repo}#${issue}`]
  })
}

function matchesDue(todo: Todo, due: TodoDueFilter, today: string): boolean {
  if (due === 'none') return todo.dueDate === null
  if (!todo.dueDate) return false
  if (due === 'today') return todo.dueDate === today
  if (due === 'overdue') return todo.dueDate < today
  return todo.dueDate > today
}

export function filterTodos(todos: readonly Todo[], query: TodoQuery = {}, now = new Date()): Todo[] {
  const needle = query.search?.trim().toLocaleLowerCase()
  const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
  return todos.filter(todo => {
    if (query.area && todo.area !== query.area) return false
    if (query.ventureTag && todo.ventureTag !== query.ventureTag) return false
    if (query.priority && todo.priority !== query.priority) return false
    if (query.due && !matchesDue(todo, query.due, today)) return false
    if (query.source && todoSource(todo) !== query.source) return false
    if (query.status && todo.status !== query.status) return false
    if (query.snoozed !== undefined && Boolean(todo.snoozedUntil) !== query.snoozed) return false
    if (!needle) return true
    const haystack = [
      todo.title, todo.description, todo.area, todo.ventureTag,
      ...todo.tags.map(tag => tag.name), ...githubIdentifiers(todo),
    ].filter(Boolean).join('\n').toLocaleLowerCase()
    return haystack.includes(needle)
  })
}

function compareBy(a: Todo, b: Todo, sort: TodoSort): number {
  if (sort === 'priority') return b.priority - a.priority
  if (sort === 'due') {
    if (a.dueDate === b.dueDate) return 0
    if (a.dueDate === null) return 1
    if (b.dueDate === null) return -1
    return a.dueDate.localeCompare(b.dueDate)
  }
  if (sort === 'created') return b.createdAt.localeCompare(a.createdAt)
  if (sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt)
  return a.position - b.position
}

export function sortTodos(todos: readonly Todo[], sort: TodoSort | TodoSortOrder = 'manual'): Todo[] {
  const criteria = Array.isArray(sort) ? sort : [sort]
  const result = [...todos]
  return result.sort((a, b) => {
    for (const criterion of criteria) {
      const compared = compareBy(a, b, criterion)
      if (compared) return compared
    }
    return a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  })
}
