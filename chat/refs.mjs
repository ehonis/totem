// chat/refs.mjs — a message's inline attachment references (#295) as model text.
//
// The composer writes an attachment named mid-sentence as a Markdown link to its
// upload, `![image.png](totem-ref://upload/<id>)` or `[notes.pdf](totem-ref://upload/<id>)`
// (web/src/chat/refs.ts, the same pattern). Before a turn reaches an agent each one
// becomes `[Image: image.png; ref=upload_<id>]`, and one <totem_context> block after
// the words says where each file is. Only ids among the message's own attachments
// resolve: any other id (an old upload, another chat's, a made-up one) reads as an
// unavailable attachment and gives no path.
//
// A prompt that carries a block is sealed as a whole (`contextSeal`): every
// `<context`/`<totem_context` tag anywhere else in it (the owner's words, a pasted
// file, an earlier message, a steer) is escaped, so only Totem's own blocks open
// one. A prompt with no block is left exactly as written.

import { randomUUID } from 'node:crypto'

const PATTERN = '(!?)\\[([^\\[\\]\\n]{0,200})\\]\\(totem-ref://upload/([A-Za-z0-9_-]{8,64})\\)'
const refPattern = () => new RegExp(PATTERN, 'g')

/** How much pasted or text-file content one turn may carry inline, shared with attachmentBlock. */
export const TEXT_INLINE_LIMIT = 60_000

/** The text with each reference as its name: for titles, previews and search. */
export function plainRefs(text) {
  return String(text ?? '').replace(refPattern(), (_m, _bang, label) => label)
}

// Only the tags themselves, in any case, so `<Context.Provider>` passes.
const fence = (s) => String(s ?? '').replace(/<(\/?)(totem_context|context)(?=[\s>/]|$)/gi, '&lt;$1$2')
const field = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const kb = (size) => `${Math.max(1, Math.ceil((Number(size) || 0) / 1024))} KB`

function inline(label, file) {
  if (!file) return `[Unavailable attachment: ${label}]`
  return `[${file.kind === 'image' ? 'Image' : 'File'}: ${label}; ref=upload_${file.id}]`
}

/**
 * Text for a transcript replayed to an agent: each reference as its inline form,
 * resolved against that message's own `attachments`, with no paths.
 */
export function inlineRefs(text, attachments = []) {
  const byId = new Map((attachments || []).map((a) => [a.id, a]))
  return String(text ?? '').replace(refPattern(), (_m, _bang, label, id) => inline(label, byId.get(id)))
}

/**
 * One turn's words and files for the agent. `files` are the message's own
 * attachments, loaded (`path`, and `text` for a small text file). Returns the
 * words with every reference rewritten, the <totem_context> block for the files
 * they name, `rest`: the files no reference names, listed as before, and
 * `textLeft`: what remains of the turn's inline text budget for them.
 */
export function projectRefs(text, files = [], textBudget = TEXT_INLINE_LIMIT) {
  const byId = new Map((files || []).map((f) => [f.id, f]))
  const named = []
  const words = String(text ?? '').replace(refPattern(), (_m, _bang, label, id) => {
    const file = byId.get(id)
    if (file && !named.includes(file)) named.push(file)
    return inline(label, file)
  })
  let textLeft = textBudget
  const contexts = named.map((f) => {
    const lines = [`name: ${field(f.name)}`, `mime: ${field(f.mime)}`, `size: ${kb(f.size)}`, `path: ${field(f.path)}`]
    if (f.kind === 'text' && typeof f.text === 'string' && f.text.length <= textLeft) {
      textLeft -= f.text.length
      lines.push(`text:\n${fence(f.text)}`)
    }
    return `<context kind="${f.kind === 'image' ? 'image' : f.kind === 'text' ? 'text' : 'file'}" id="upload_${f.id}">\n${lines.join('\n')}\n</context>`
  })
  return {
    text: words,
    context: contexts.length ? `<totem_context version="1">\n${contexts.join('\n')}\n</totem_context>` : '',
    rest: (files || []).filter((f) => !named.includes(f)),
    textLeft,
  }
}

/**
 * Holds a prompt's real context blocks while it is put together, then seals it:
 * `hold(block)` stands a placeholder in for a block (a random one, so no text can
 * name it), and `seal(prompt)` escapes every tag in the rest of the prompt and puts
 * the blocks back. With nothing held, `seal` returns the prompt unchanged.
 */
export function contextSeal() {
  const blocks = []
  const tag = randomUUID()
  return {
    hold: (block) => {
      if (!block) return ''
      blocks.push(block)
      return `\u0001${tag}:${blocks.length - 1}\u0001`
    },
    seal: (prompt) => {
      if (!blocks.length) return prompt
      return fence(prompt).replace(new RegExp(`\u0001${tag}:(\\d+)\u0001`, 'g'), (_m, i) => blocks[Number(i)])
    },
  }
}
