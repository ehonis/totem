// Skill mentions: `/name` or `$name` anywhere in a message. The same token rules
// as skills/agent-skills.mjs on the bridge, which decides what the agent is sent;
// this side decides what the composer offers and what gets drawn as a chip.

/** A token starts the text or follows whitespace or an opening bracket/quote. */
const BEFORE = `(^|[\\s(\\[{"'])`

/**
 * The partial token the caret is in, for the composer's menu: `/fi|` → `{ prefix:
 * '/', term: 'fi', start }`. Null when the caret is not at the end of one, or the
 * token runs on into a word ("/fi|nd").
 */
export function mentionAtCaret(value: string, caret: number) {
  const before = value.slice(0, caret)
  const m = new RegExp(`${BEFORE}([/$])([a-z0-9-]*)$`, 'i').exec(before)
  if (!m) return null
  if (/^[a-z0-9-]/i.test(value.slice(caret))) return null
  const start = m.index + m[1].length
  return { prefix: m[2] as '/' | '$', term: m[3].toLowerCase(), start, end: caret }
}

export type MentionPart = { text: string; mention?: string }

/**
 * Split text into plain runs and known mentions. `known` holds full commands in
 * lower case (`/find-thread`, `$morning`); anything else stays plain, so a path
 * like `/home/x` or an unknown `/word` is never drawn as a skill.
 */
export function splitMentions(text: string, known: Set<string>): MentionPart[] {
  if (!known.size || !text) return [{ text }]
  const re = new RegExp(`${BEFORE}([/$][a-z0-9][a-z0-9-]*)(?=$|[\\s.,;:!?)\\]}"'])`, 'gi')
  const out: MentionPart[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const cmd = m[2]
    if (!known.has(cmd.toLowerCase())) continue
    const at = (m.index ?? 0) + m[1].length
    if (at > last) out.push({ text: text.slice(last, at) })
    out.push({ text: cmd, mention: cmd.toLowerCase() })
    last = at + cmd.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out.length ? out : [{ text }]
}

/** Replace the token `[start, end)` with `cmd` and a space; returns the new caret too. */
export function insertMention(value: string, start: number, end: number, cmd: string) {
  const after = value.slice(end)
  const insert = /^\s/.test(after) ? cmd : `${cmd} `
  const next = value.slice(0, start) + insert + after
  return { value: next, caret: start + insert.length + (/^\s/.test(after) ? 1 : 0) }
}
