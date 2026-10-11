// Thread actions for the chat list and menus. They live in the chat store now
// (lib/chat/store.ts, ported from the web with settle.ts); this module keeps the
// import site stable and adds the one piece that is UI: a clock that ticks when
// a snooze runs out.
import { useEffect, useState } from 'react'
import { nextWake } from '../../lib/chat/settle'
import type { ChatThread } from '../../lib/chat/types'

export {
  settleThread, unsettleThread, snoozeThread, wakeThread, markRead, markUnread, setPinned, groupThreads,
} from '../../lib/chat/store'

/** The current time, ticking each minute and exactly when the next snooze runs out. */
export function useNow(threads: ChatThread[]) {
  const [at, setAt] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setAt(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  const wake = nextWake(threads, at)
  useEffect(() => {
    if (!wake) return
    // setTimeout overflows past 2^31-1 ms (about 24 days); the minute tick covers the rest.
    const id = setTimeout(() => setAt(Date.now()), Math.min(2_147_483_647, Math.max(0, wake - Date.now()) + 50))
    return () => clearTimeout(id)
  }, [wake])
  return at
}
