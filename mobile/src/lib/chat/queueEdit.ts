// A queued message being edited in the chat screen's composer: its own words and
// files, apart from the chat's draft. The phone's box is plain text, so a file
// reference shows as `[name]` and `restore` puts the reference back (refs.ts),
// both when the edit is saved and when it is kept as the draft. No React Native here.
import { editableRefs } from './refs.ts'
import type { Attachment, QueuedMessage } from './types'

export interface QueueEdit {
  id: string
  threadId: string
  /** What the box shows. */
  text: string
  files: Attachment[]
  restore: (shown: string) => string
}

export function startQueueEdit(q: Pick<QueuedMessage, 'id' | 'text' | 'attachments'>, threadId: string): QueueEdit {
  const editable = editableRefs(q.text)
  return { id: q.id, threadId, text: editable.text, files: q.attachments || [], restore: editable.restore }
}
