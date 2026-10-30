// "Chat about this" (web/src/chat/about/start.ts): save a card's context as a text
// upload, queue it for the composer (pendingContext.ts, as Search's "Add to chat"
// does) and open a new chat on Home. Nothing is sent until the owner sends it.
import { router } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { uploadFile } from '../api'
import { queueContext } from '../pendingContext'
import { openProject } from '../store'
import { contextFileName, contextMarkdown, type ChatContext } from './context'

export async function startChatAbout(ctx: ChatContext): Promise<void> {
  // React Native builds a Blob from string parts, and its XHR sends one.
  const text = contextMarkdown(ctx)
  const attachment = await uploadFile(new Blob([text], { type: 'text/markdown' }), contextFileName(ctx), { kind: 'text' })
  queueContext(attachment)
  openProject(null)
  router.navigate('/chat')
}

export async function copyChatAbout(ctx: ChatContext): Promise<void> {
  await Clipboard.setStringAsync(contextMarkdown(ctx))
}
