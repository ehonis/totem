// A task picked in the chats panel starts a chat for it. The chat view, while it
// shows a new chat's composer, takes the pick itself, so what he has typed goes
// with the task (useChatDrafts.startForTask, the same move `$` makes); anywhere
// else the task gets a fresh draft in its folder.
import { startTaskDraft } from '../chat/store'
import { taskHome } from '../work/state'

let picker: ((ref: string) => void) | null = null

/** ChatView's handler while it is on screen; returns the uninstall. */
export function installTaskPicker(fn: (ref: string) => void): () => void {
  picker = fn
  return () => { if (picker === fn) picker = null }
}

export function pickTask(ref: string) {
  if (picker) picker(ref)
  else startTaskDraft(ref, taskHome(ref))
}
