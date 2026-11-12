// How a list draws on the phone, and the optimistic copies it shows while the
// bridge answers. Pure (no React Native), so `node --test` runs it directly.
import type { ListItem, TotemList } from '../../lib/lists/types'

const byPosition = (a: ListItem, b: ListItem) => a.position - b.position || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)

/**
 * The items still to do, then the checked ones, each in the list's own order.
 * Only the drawing changes: positions on the bridge stay as they are.
 */
export function splitItems(items: ListItem[]): { open: ListItem[]; checked: ListItem[] } {
  const sorted = [...items].sort(byPosition)
  return { open: sorted.filter((i) => !i.checked), checked: sorted.filter((i) => i.checked) }
}

/** The counts the bridge would send for these items. */
function recount(list: TotemList, items: ListItem[]): TotemList {
  return { ...list, items, itemCount: items.length, checkedCount: items.filter((i) => i.checked).length }
}

/** The list with one item checked or unchecked. */
export function withChecked(list: TotemList, itemId: string, checked: boolean): TotemList {
  return recount(list, list.items.map((i) => (i.id === itemId ? { ...i, checked } : i)))
}

/** The list with one item's text changed. */
export function withText(list: TotemList, itemId: string, text: string): TotemList {
  return recount(list, list.items.map((i) => (i.id === itemId ? { ...i, text } : i)))
}

/** The list without the items in `hidden` (removals waiting out their undo window). */
export function withoutItems(list: TotemList, hidden: ReadonlySet<string>): TotemList {
  if (!hidden.size) return list
  return recount(list, list.items.filter((i) => !hidden.has(i.id)))
}

export const PENDING_PREFIX = 'pending:'

/** An item the phone shows at once, at the end, while the bridge adds it. */
export function pendingItem(listId: string, text: string, seq: number, after: ListItem[], now = new Date()): ListItem {
  const last = after.reduce((max, i) => Math.max(max, i.position), -1)
  const at = now.toISOString()
  return { id: `${PENDING_PREFIX}${seq}`, listId, text, checked: false, position: last + 1, createdAt: at, updatedAt: at }
}

export const isPending = (item: Pick<ListItem, 'id'>) => item.id.startsWith(PENDING_PREFIX)

/** The list with the drafts still on their way appended. */
export function withPending(list: TotemList, drafts: ListItem[]): TotemList {
  const mine = drafts.filter((d) => d.listId === list.id)
  return mine.length ? recount(list, [...list.items, ...mine]) : list
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
