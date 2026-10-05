import React from 'react'
import { THREAD_ICONS } from './threadIcons.gen'
import { TI } from './ui'
import { IconGhost2, IconMessage } from './icons'
import type { ChatThread } from './types'

/**
 * The icon the title model picked for a chat (chat/thread-icons.mjs). A
 * temporary chat keeps its ghost; a chat that has none yet shows a plain bubble.
 */
export default function ThreadIcon({ t, size = 16, busy = false }: { t: Pick<ChatThread, 'icon' | 'kind'>; size?: number; busy?: boolean }) {
  const icon = t.kind === 'temporary' ? IconGhost2 : (t.icon && THREAD_ICONS[t.icon]) || IconMessage
  return <TI icon={icon} size={size} className={`vc-thread-icon ${t.icon ? 'picked' : ''} ${busy ? 'busy' : ''}`} />
}
