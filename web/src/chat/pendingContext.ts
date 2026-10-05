// Attachments waiting for the chat composer: Search's "Add to chat" saves a
// result as a text upload, queues it here, opens the chat, and ChatView moves it
// into the composer as an ordinary attachment chip. Nothing is sent until he
// sends it.
import type { Attachment } from './types'

let queue: Attachment[] = []
let version = 0
const listeners = new Set<() => void>()

export function queueContext(a: Attachment) {
  queue = [...queue, a]
  version += 1
  listeners.forEach((l) => l())
}

export function takeContext(): Attachment[] {
  const out = queue
  queue = []
  return out
}

export const subscribeContext = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const contextVersion = () => version
