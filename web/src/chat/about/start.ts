// "Chat about this": save a card's context as a text upload, queue it for the
// composer (pendingContext.ts, as Search's "Add to chat" does) and open a new
// chat on Home. Nothing is sent until the owner sends it.
import { uploadFile } from '../api'
import { queueContext } from '../pendingContext'
import { openProject } from '../store'
import { contextFileName, contextMarkdown, type ChatContext } from './context'

interface Hooks {
  navigate: (target: 'chat') => void
  /** A signed-out session: App's sign-in screen, as Search's onAuthError. */
  onAuthError: () => void
}

let hooks: Hooks | null = null

/** App hands over its router and sign-out once; returns the uninstall. */
export function installChatAbout(h: Hooks): () => void {
  hooks = h
  return () => { if (hooks === h) hooks = null }
}

export const chatAboutAuthError = () => hooks?.onAuthError()

export async function startChatAbout(ctx: ChatContext): Promise<void> {
  // Checked first: without App's router the chat would never open, and the
  // upload would sit in the queue for whenever it next did.
  const h = hooks
  if (!h) throw new Error('Chat about this is not ready: the app has not installed it')
  const text = contextMarkdown(ctx)
  const attachment = await uploadFile(new Blob([text], { type: 'text/markdown' }), contextFileName(ctx), { kind: 'text' })
  queueContext(attachment)
  openProject(null)
  h.navigate('chat')
}

export async function copyChatAbout(ctx: ChatContext): Promise<void> {
  await navigator.clipboard.writeText(contextMarkdown(ctx))
}
