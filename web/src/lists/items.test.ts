import { describe, expect, it } from 'vitest'
import { cleanItemText, listProgress, splitItems, withChecked, withText, withoutItem } from './items'
import type { ListItem, TotemList } from './types'

const item = (id: string, position: number, checked = false): ListItem => ({
  id, listId: 'l', text: id, checked, position, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
})
const list = (items: ListItem[]): TotemList => ({
  id: 'l', title: 'L', position: 0, createdAt: '', updatedAt: '', items, linkedTodos: [],
  itemCount: items.length, checkedCount: items.filter((i) => i.checked).length,
})

describe('lists/items', () => {
  it('puts open items first, then checked ones, each in position order', () => {
    const { open, checked } = splitItems([item('c', 2, true), item('b', 1), item('a', 0, true), item('d', 3)])
    expect(open.map((i) => i.id)).toEqual(['b', 'd'])
    expect(checked.map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('recounts after a check, an edit and a removal', () => {
    const l = list([item('a', 0), item('b', 1)])
    expect(withChecked(l, 'a', true).checkedCount).toBe(1)
    expect(withText(l, 'b', 'Bread').items[1].text).toBe('Bread')
    const gone = withoutItem(withChecked(l, 'a', true), 'a')
    expect([gone.itemCount, gone.checkedCount]).toEqual([1, 0])
  })

  it('says how far along a list is', () => {
    expect(listProgress({ itemCount: 5, checkedCount: 1 })).toEqual({ label: '1 of 5', ratio: 0.2, done: false })
    expect(listProgress({ itemCount: 0, checkedCount: 0 })).toEqual({ label: 'Empty', ratio: 0, done: false })
    expect(listProgress({ itemCount: 2, checkedCount: 2 }).done).toBe(true)
  })

  it('cleans typed text', () => {
    expect(cleanItemText('  oat   milk ')).toBe('oat milk')
    expect(cleanItemText('   ')).toBeNull()
  })
})
