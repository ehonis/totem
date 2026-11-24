// How a task's due day reads on the phone, wherever a chat names its task (the
// drawer's task badges, a chat's task strip, the link sheet): the Tasks page's words
// (TodoCard: "Overdue · Nov 16", "Today", "Tomorrow", "Nov 22") and colours.
import { colors } from '../../theme'
import { dueText } from '../todos/format'
import { dueLabel } from '../../lib/work/groups'

export const DUE_COLOR = { overdue: '#ff7f95', today: '#efc765', soon: colors.muted, later: colors.muted } as const

/**
 * The words, colour and weight for a due day, or null without one. `short` gives the
 * web panel's one word ("Overdue", "Fri") for a line that has no room for a date.
 */
export function dueLook(dueDate: string | null, now: Date, short = false): { text: string; color: string; strong: boolean } | null {
  const label = dueLabel(dueDate, now)
  if (!dueDate || !label) return null
  return { text: short ? label.text : dueText(dueDate.slice(0, 10), now), color: DUE_COLOR[label.tone], strong: label.tone === 'overdue' || label.tone === 'today' }
}
