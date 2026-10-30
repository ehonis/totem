// "Chat about this" from a long press (the web's ChatAbout.tsx): an action sheet
// with Chat about this and Copy as text. A card with its own long-press menu adds
// `CHAT_ABOUT_ACTION` to it instead and calls `chatAbout` for it.
import { AuthError } from '../lib/api'
import type { ChatContext } from '../lib/chat/about/context'
import { copyChatAbout, startChatAbout } from '../lib/chat/about/start'
import { pushError, pushSuccess } from '../lib/toast'
import { showMenu } from './menu'
import { success } from './haptics'

type Of = () => ChatContext | null | undefined

export const CHAT_ABOUT_ACTION = { id: 'chat-about', title: 'Chat about this', image: 'bubble.left.and.bubble.right' }

export function chatAbout(of: Of, copy = false) {
  const ctx = of()
  if (!ctx) return
  const done = copy ? copyChatAbout(ctx).then(() => pushSuccess('Copied')) : startChatAbout(ctx).then(success)
  done.catch((e: any) => { if (!(e instanceof AuthError)) pushError(e?.message || 'Could not start that chat') })
}

export function chatAboutMenu(of: Of) {
  const ctx = of()
  if (!ctx) return
  showMenu([
    { label: 'Chat about this', onPress: () => chatAbout(() => ctx) },
    { label: 'Copy as text', onPress: () => chatAbout(() => ctx, true) },
  ], { title: ctx.title })
}
