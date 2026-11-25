// How a list draws: the items still to do first, then the checked ones, and the
// "3 of 7" under each title. The same rules as the iPhone app
// (mobile/src/features/lists/items.ts), so both show a list the same way.
import type { ListItem, TotemList } from './types'

const byPosition = (a: ListItem, b: ListItem) => a.position - b.position || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)

/** The items still to do, then the checked ones, each in the list's own order. */
export function splitItems(items: ListItem[]): { open: ListItem[]; checked: ListItem[] } {
  const sorted = [...items].sort(byPosition)
  return { open: sorted.filter((i) => !i.checked), checked: sorted.filter((i) => i.checked) }
}

function recount(list: TotemList, items: ListItem[]): TotemList {
  return { ...list, items, itemCount: items.length, checkedCount: items.filter((i) => i.checked).length }
}

/** The list with one item checked or unchecked, counted as the bridge would. */
export function withChecked(list: TotemList, itemId: string, checked: boolean): TotemList {
  return recount(list, list.items.map((i) => (i.id === itemId ? { ...i, checked } : i)))
}

/** The list with one item's text changed. */
export function withText(list: TotemList, itemId: string, text: string): TotemList {
  return recount(list, list.items.map((i) => (i.id === itemId ? { ...i, text } : i)))
}

/** The list without one item. */
export function withoutItem(list: TotemList, itemId: string): TotemList {
  return recount(list, list.items.filter((i) => i.id !== itemId))
}

/** "3 of 7", the share done (0 for an empty list), and whether it is all done. */
export function listProgress(list: Pick<TotemList, 'itemCount' | 'checkedCount'>): { label: string; ratio: number; done: boolean } {
  const total = Math.max(0, list.itemCount)
  const checked = Math.min(Math.max(0, list.checkedCount), total)
  return {
    label: total ? `${checked} of ${total}` : 'Empty',
    ratio: total ? checked / total : 0,
    done: total > 0 && checked === total,
  }
}

/** The text to send for a typed item, or null when there is nothing to add. */
export function cleanItemText(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim()
  return text ? text : null
}
