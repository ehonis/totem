// Handing a message's text to the "Select text" sheet (SelectTextSheet.tsx). The
// text can be long, so it waits here rather than riding the route's URL.
import { router } from 'expo-router'
import { markdownToPlainText } from '../../lib/chat/plainText'

let pending = ''

/** Open the sheet on a message's text: Markdown (a reply) reads as its words, the owner's own as written. */
export function openSelectText(text: string, { markdown = false }: { markdown?: boolean } = {}) {
  pending = markdown ? markdownToPlainText(text) : String(text ?? '')
  router.push('/chat/select')
}

/** The text the sheet was last opened on. */
export const selectTextValue = () => pending
