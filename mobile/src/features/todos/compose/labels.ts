// Words and colours the composer and the task page share.
import { colors } from '../../../theme'
import { priorityLabel, type SheetItem } from '../../../lib/todos/types'
import { sheetAsTaskPriority } from '../../../lib/todos/board'
import { tone } from '../ui'

export const PRIORITY_WORD = { P1: 'Urgent', P2: 'High', P3: 'Medium', P4: 'None' } as const
export const PRIORITY_COLOR = { P1: tone.red.color, P2: tone.amber.color, P3: tone.blue.color, P4: colors.muted } as const
/**
 * A sheet row's flag colour: that of the task priority it ranks with
 * (sheetAsTaskPriority: High amber as P2, Medium blue as P3), except Low, which is
 * muted so it reads under Medium.
 */
export function sheetPriorityColor(priority: NonNullable<SheetItem['priority']>): string {
  return priority === 3 ? colors.muted : PRIORITY_COLOR[priorityLabel(sheetAsTaskPriority(priority))]
}
/** A GitHub repository as owner/name, as the web checks it. */
export const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/
