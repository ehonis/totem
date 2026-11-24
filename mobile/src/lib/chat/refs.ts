// Inline attachment references (#295): a file the owner attached, named in the
// middle of a sentence. A message keeps them as Markdown links to the upload,
//   ![image.png](totem-ref://upload/<id>)   an image
//   [notes.pdf](totem-ref://upload/<id>)    a file or a pasted text
// so the message string stays the one source of truth. The composer draws them
// as chips, the transcripts too (by the message's own attachments), and every
// list or title shows the plain name. The bridge turns them into model text
// (chat/refs.mjs, the same pattern). Copied byte for byte to
// mobile/src/lib/chat/refs.ts; pure, so node runs it.

export const REF_HREF = 'totem-ref://upload/'
export const LABEL_MAX = 200
export const NAME_MAX = 36

/** One reference: `image` is the leading `!`; `id` an upload id (chat/uploads.mjs `validUploadId`). */
export interface Ref { image: boolean; label: string; id: string }
export type RefPart = { text: string; ref?: undefined } | { text: string; ref: Ref }

// The label holds no brackets or newline, the id is an upload id: both bounded, so it runs in linear time.
const PATTERN = `(!?)\\[([^\\[\\]\\n]{0,${LABEL_MAX}})\\]\\(totem-ref://upload/([A-Za-z0-9_-]{8,64})\\)`
const refPattern = () => new RegExp(PATTERN, 'g')

/**
 * A file's name as a reference's label: no brackets or line breaks, at most
 * LABEL_MAX UTF-16 units (what the pattern counts), never splitting a character.
 */
export function refLabel(name: string): string {
  const clean = String(name || '').replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  let end = Math.min(clean.length, LABEL_MAX)
  const code = clean.charCodeAt(end - 1)
  if (end < clean.length && code >= 0xd800 && code <= 0xdbff) end -= 1
  return clean.slice(0, end).trimEnd() || 'file'
}

const VALID_LABEL = new RegExp(`^[^\\[\\]\\n]{0,${LABEL_MAX}}$`)

/** A label that already fits the token (one read back from the text) is written as it was. */
export function formatRef(ref: Ref): string {
  return `${ref.image ? '!' : ''}[${VALID_LABEL.test(ref.label) ? ref.label : refLabel(ref.label)}](${REF_HREF}${ref.id})`
}

/** The reference an attachment gets: an image is `![…]`, a file or pasted text `[…]`. */
export function attachmentRef(a: { id: string; name: string; kind: 'image' | 'file' | 'text' }): Ref {
  return { image: a.kind === 'image', label: refLabel(a.name), id: a.id }
}

/** The text as plain runs and references, in order. */
export function splitRefs(text: string): RefPart[] {
  const out: RefPart[] = []
  let last = 0
  for (const m of String(text || '').matchAll(refPattern())) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at) })
    out.push({ text: m[0], ref: { image: m[1] === '!', label: m[2], id: m[3] } })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** Every upload id the text refers to, once each, in order. */
export function refIds(text: string): string[] {
  return [...new Set(splitRefs(text).flatMap((p) => (p.ref ? [p.ref.id] : [])))]
}

/** The text with each reference as its name (`image.png`): for previews, titles and search. */
export function plainRefs(text: string): string {
  return String(text || '').replace(refPattern(), (_m, _bang, label: string) => label)
}

/** A message in a plain text box: the text shown, how to read an edit of it back, and its caret both ways. */
export interface EditableRefs {
  text: string
  /**
   * The message for an edit of `text`: every reference outside the changed span is
   * kept exactly. `caret`, where the box's caret ended up, says which of two equal
   * spans a typed or deleted run was (the first of two same-named files).
   */
  restore: (edited: string, caret?: number) => string
  /** A caret in `text` as an offset in the message (one inside a `[name]` lands after its reference). */
  toValue: (shown: number) => number
  /** A caret in the message as an offset in `text`. */
  toShown: (value: number) => number
}

/**
 * A message for a plain text box (the iPhone's edit boxes, the web composer before
 * its editor loads): each reference shown as `[name]`. `restore` diffs the edit
 * against what was shown (common start and end) and keeps the message exactly as
 * it was on both sides of the change; inside it, a reference whose `[name]` still
 * stands keeps it, in order. So a deleted `[name]` takes only its own reference, and
 * one he typed outside the change stays text.
 */
export function editableRefs(value: string): EditableRefs {
  const spans: { shown: [number, number]; value: [number, number]; ref: boolean }[] = []
  let shown = ''
  let at = 0
  for (const p of splitRefs(value)) {
    const piece = p.ref ? `[${p.ref.label}]` : p.text
    spans.push({ shown: [shown.length, shown.length + piece.length], value: [at, at + p.text.length], ref: !!p.ref })
    shown += piece
    at += p.text.length
  }
  const toValue = (n: number) => {
    for (const s of spans) {
      if (n > s.shown[1]) continue
      if (!s.ref) return s.value[0] + (n - s.shown[0])
      return n <= s.shown[0] ? s.value[0] : s.value[1]
    }
    return value.length
  }
  const toShown = (n: number) => {
    for (const s of spans) {
      if (n > s.value[1]) continue
      if (!s.ref) return s.shown[0] + (n - s.value[0])
      return n <= s.value[0] ? s.shown[0] : s.shown[1]
    }
    return shown.length
  }
  const cuts = (at: number) => spans.some((s) => s.ref && at > s.shown[0] && at < s.shown[1])
  const restore = (edited: string, caret?: number) => {
    if (edited === shown) return value
    let start = 0
    while (start < shown.length && start < edited.length && shown[start] === edited[start]) start++
    let tail = 0
    while (tail < shown.length - start && tail < edited.length - start && shown[shown.length - 1 - tail] === edited[edited.length - 1 - tail]) tail++
    // A run only typed or only deleted can sit anywhere repeated text lets it slide
    // left to: put it where the caret says, else where it cuts no `[name]`.
    const removed = shown.length - start - tail
    const added = edited.length - start - tail
    if (!removed !== !added) {
      const run = removed ? shown : edited
      const len = removed || added
      const fits = (at: number) => !cuts(at) && !(removed && cuts(at + removed))
      let best = start
      for (let at = start; at >= 0; at--) {
        if (at < start && run[at] !== run[at + len]) break
        if (caret !== undefined && caret === (removed ? at : at + added)) { best = at; break }
        if (!fits(best) && fits(at)) best = at
      }
      tail += start - best
      start = best
    }
    // A `[name]` the change cuts into is part of the change.
    for (const s of spans) {
      if (!s.ref) continue
      if (start > s.shown[0] && start < s.shown[1]) start = s.shown[0]
      const end = shown.length - tail
      if (end > s.shown[0] && end < s.shown[1]) tail = shown.length - s.shown[1]
    }
    // Inside the change, a reference whose `[name]` still stands there, in order, keeps it.
    let middle = edited.slice(start, edited.length - tail)
    let out = ''
    for (const span of spans) {
      if (!span.ref || span.shown[0] < start || span.shown[1] > shown.length - tail) continue
      const name = shown.slice(span.shown[0], span.shown[1])
      const found = middle.indexOf(name)
      if (found < 0) continue
      out += middle.slice(0, found) + value.slice(span.value[0], span.value[1])
      middle = middle.slice(found + name.length)
    }
    return value.slice(0, toValue(start)) + out + middle + value.slice(toValue(shown.length - tail))
  }
  return { text: shown, restore, toValue, toShown }
}

/** T3 Code's size: whole KB rounded up, then one decimal of MB from 1024 KB. */
export function formatSize(bytes: number): string {
  const kb = Math.max(1, Math.ceil((Number(bytes) || 0) / 1024))
  return kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`
}

/** A long name cut in its middle, so the extension stays: `quarterly-rep…-final-v2.pdf`. */
export function middleTruncate(name: string, max = NAME_MAX): string {
  const chars = Array.from(String(name || ''))
  if (chars.length <= max) return chars.join('')
  const tail = Math.min(14, Math.floor((max - 1) / 2))
  return `${chars.slice(0, max - 1 - tail).join('')}…${chars.slice(chars.length - tail).join('')}`
}
