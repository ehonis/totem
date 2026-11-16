import { describe, expect, it } from 'vitest'
import type { Project } from '../chat/types'
import { groupByFolder, inScope, itemFolder, projectChips, subfolderChips } from './byFolder'
import type { ListItem, ListSection } from './board'
import type { SheetItem, Todo } from './types'

const project = (id: string, name: string, parentId?: string) => ({ id, name, ...(parentId ? { parentId } : {}) } as Project)
const PROJECTS = [project('north', 'Work - Northwind'), project('mn', 'r+d', 'north'), project('wp', 'Gizmo Labs')]
const t = (id: string, folderId: string | null = null): ListItem => ({ kind: 'task', todo: { id, title: id, folderId } as Todo })
const s = (id: string, folderId: string | null = null): ListItem => ({ kind: 'sheet', item: { id, title: id, folderId } as SheetItem })

describe('tasks by folder', () => {
  const items = [t('a', 'north'), t('b', 'mn'), t('c'), t('d', 'gone'), s('row', 'wp'), s('row2')]

  it('reads a deleted folder as Personal', () => {
    expect(itemFolder(t('x', 'gone'), PROJECTS)).toBeNull()
    expect(itemFolder(t('x', 'mn'), PROJECTS)).toBe('mn')
  })

  it('a project chip shows its own tasks, its folders’ tasks and sheet rows filed there', () => {
    const shown = (scope: Parameters<typeof inScope>[1], sub: string | null = null) => items.filter((i) => inScope(i, scope, sub, PROJECTS)).map((i) => (i.kind === 'task' ? i.todo.id : i.item.id))
    expect(shown('folder:north')).toEqual(['a', 'b'])
    expect(shown('folder:north', 'mn')).toEqual(['b'])
    expect(shown('folder:wp')).toEqual(['row'])
    expect(shown('personal')).toEqual(['c', 'd', 'row2'])
    expect(shown('sheet')).toEqual(['row', 'row2'])
    expect(shown('all')).toHaveLength(6)
  })

  it('chips: projects with something open (and the picked one), folders inside the picked project', () => {
    expect(projectChips(items, PROJECTS, 'all').map((c) => [c.label, c.count])).toEqual([['Work - Northwind', 2], ['Gizmo Labs', 1]])
    expect(projectChips([t('c')], PROJECTS, 'folder:wp').map((c) => [c.label, c.count])).toEqual([['Gizmo Labs', 0]])
    expect(subfolderChips(items, PROJECTS, 'north').map((c) => [c.id, c.count])).toEqual([['mn', 1]])
    expect(subfolderChips(items, PROJECTS, null)).toEqual([])
  })

  it('groups the day sections by folder, each folder after its project, Personal last, day order kept', () => {
    const sections: ListSection[] = [
      { key: 'overdue', items: [t('late', 'mn'), t('loose')] },
      { key: 'today', items: [t('now', 'north'), s('row', 'wp'), t('also', 'mn')] },
    ]
    const groups = groupByFolder(sections, PROJECTS)
    expect(groups.map((g) => [g.key, g.items.map((i) => (i.kind === 'task' ? i.todo.id : i.item.id))])).toEqual([
      ['north', ['now']], ['mn', ['late', 'also']], ['wp', ['row']], ['', ['loose']],
    ])
    expect(groups[1].parent?.id).toBe('north')
  })
})
