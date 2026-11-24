// The Markdown structure of the message string (#298): list items, the lines that
// continue them, and code fences. Every list key (Enter, Tab, Shift+Tab, and with
// formatting on Backspace and Delete) is an edit of the string; the editor redraws
// from the result, so what is sent is exactly the Markdown the keys made.
// After T3 Code's composer-list-continuation.ts.

export interface ListItemLine {
  kind: 'ordered' | 'bullet' | 'task'
  indent: string
  /** `1.`, `07)`, `-`, `*` or `+`. */
  marker: string
  /** Between a task's bullet and its `[ ]`. */
  markerSpace: string
  /** A task's box: ` `, `x` or `X`. */
  check: string
  /** After the marker (a task's after its `]`); empty only on an empty item. */
  space: string
  /** Length of the prefix. */
  end: number
  /** The column a nested item or a continuation line must reach to belong to this item. */
  column: number
}

export interface Line {
  start: number
  end: number
  text: string
  item?: ListItemLine
  /** The item this line belongs to: itself, or the item a continuation line continues. */
  owner?: number
  /** For an item, the item it is nested in (-1 at the top). */
  parent?: number
  /** For an item, true when it starts a list rather than following a sibling. */
  first?: boolean
  /** Inside a fenced code block, fences included. */
  code?: boolean
}

export interface TextEdit { value: string; caret: number }

// The marker takes one space or tab after it; any more are the item's text, so the box shows them.
const TASK = /^([ \t]*)([-*+])([ \t]+)\[([ xX])\]([ \t]?)/
const ORDERED = /^([ \t]*)(\d{1,9}[.)])([ \t]|$)/
const BULLET = /^([ \t]*)([-*+])([ \t]|$)/

/** Markdown tabs advance to the next four-column stop. */
function indentWidth(text: string, from = 0): number {
  let column = from
  for (const ch of text) {
    if (ch === ' ') column += 1
    else if (ch === '\t') column += 4 - (column % 4)
    else break
  }
  return column - from
}

// Content follows one to four columns of padding; wider padding is code, so it sits one column past the marker.
function contentColumn(indent: string, markerWidth: number, padding: string): number {
  const markerEnd = indentWidth(indent) + markerWidth
  const space = indentWidth(padding, markerEnd)
  return markerEnd + (space >= 1 && space <= 4 ? space : 1)
}

export function parseListLine(line: string): ListItemLine | null {
  const task = TASK.exec(line)
  if (task && (task[5] || task[0].length === line.length)) {
    const [whole, indent, marker, markerSpace, check, space] = task
    return { kind: 'task', indent, marker, markerSpace, check, space, end: whole.length, column: contentColumn(indent, 1, markerSpace) }
  }
  const ordered = ORDERED.exec(line)
  if (ordered) {
    const [whole, indent, marker, space] = ordered
    return { kind: 'ordered', indent, marker, markerSpace: '', check: '', space, end: whole.length, column: contentColumn(indent, marker.length, space) }
  }
  const bullet = BULLET.exec(line)
  if (bullet) {
    const [whole, indent, marker, space] = bullet
    return { kind: 'bullet', indent, marker, markerSpace: '', check: '', space, end: whole.length, column: contentColumn(indent, 1, space) }
  }
  return null
}

export function parseOpeningFence(line: string): { fence: string; language: string } | null {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(line)
  // A chip's link after the backticks is not a language (and the chip would be lost as one).
  if (!match || (match[1][0] === '`' && match[2].includes('`')) || match[2].includes('totem-ref://')) return null
  return { fence: match[1], language: match[2] }
}

/** A closing fence may sit up to three spaces in, as an indented line of code leaves it. */
export function isClosingFence(line: string, fence: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
  return !!match && match[1][0] === fence[0] && match[1].length >= fence.length
}

/** Items of one list share a kind and a delimiter or bullet character. */
const listKey = (item: ListItemLine) => `${item.kind}${item.marker.slice(-1)}`

/**
 * Each line, with the list item it belongs to. A deeper-indented item nests under
 * the item above; a non-list line indented to an open item's content column
 * continues that item; an empty line or anything else ends the lists. A fence
 * followed by at least one more line opens a code block, closed by a matching fence.
 */
export function analyze(value: string): Line[] {
  const lines: Line[] = []
  let at = 0
  for (const text of value.split('\n')) {
    lines.push({ start: at, end: at + text.length, text })
    at += text.length + 1
  }
  let stack: { width: number; line: number; key: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = i + 1 < lines.length ? parseOpeningFence(line.text) : null
    if (fence && !isClosingFence(lines[i + 1].text, fence.fence)) {
      stack = []
      let j = i
      line.code = true
      while (++j < lines.length) {
        lines[j].code = true
        if (isClosingFence(lines[j].text, fence.fence)) break
      }
      i = j
      continue
    }
    if (line.text === '') { stack = []; continue }
    const item = parseListLine(line.text)
    if (item) {
      const width = indentWidth(item.indent)
      const key = listKey(item)
      while (stack.length && stack[stack.length - 1].width > width) stack.pop()
      const top = stack[stack.length - 1]
      line.item = item
      line.owner = i
      if (top && top.width === width) {
        line.parent = stack.length > 1 ? stack[stack.length - 2].line : -1
        line.first = top.key !== key
        top.line = i
        top.key = key
      } else {
        line.parent = top ? top.line : -1
        line.first = true
        stack.push({ width, line: i, key })
      }
      continue
    }
    const width = indentWidth(line.text)
    let level = stack.length - 1
    while (level >= 0 && lines[stack[level].line].item!.column > width) level--
    if (level < 0) { stack = []; continue }
    line.owner = stack[level].line
    stack.length = level + 1
  }
  return lines
}

function lineIndexAt(lines: Line[], offset: number): number {
  let i = 0
  while (i < lines.length - 1 && offset > lines[i].end) i++
  return i
}

function replace(value: string, start: number, end: number, text: string) {
  return value.slice(0, start) + text + value.slice(end)
}

/** `9.` → `10.`, `09)` → `10)`, `001.` → `002.`. */
export function nextOrderedMarker(marker: string): string {
  const digits = marker.slice(0, -1)
  const n = Number.parseInt(digits, 10) + 1
  return `${String(n).padStart(digits.length, '0')}${marker.slice(-1)}`
}

function numbered(marker: string, n: number): string {
  const digits = marker.slice(0, -1)
  return `${digits.startsWith('0') ? String(n).padStart(digits.length, '0') : n}${marker.slice(-1)}`
}

/** The prefix of the item after `item` in its list; a task's starts unchecked. */
function nextPrefix(item: ListItemLine): string {
  if (item.kind === 'task') return `${item.indent}${item.marker}${item.markerSpace}[ ] `
  return `${item.indent}${item.kind === 'ordered' ? nextOrderedMarker(item.marker) : item.marker} `
}

/** The last line of the item on line `i`: its continuation lines and nested items. */
function subtreeEnd(lines: Line[], i: number): number {
  const width = indentWidth(lines[i].item!.indent)
  let j = i
  while (j + 1 < lines.length) {
    const next = lines[j + 1]
    if (next.owner === undefined) break
    if (next.item ? indentWidth(next.item.indent) <= width : lines[next.owner].start < lines[i].start) break
    j++
  }
  return j
}

/**
 * Number the items that follow line `i` in its list from `n`, keeping each one's
 * zero padding. Only lines after `i` change, so a caret on or before it stays put.
 */
function renumberAfter(value: string, i: number, n: number): string {
  const lines = analyze(value)
  const item = lines[i]?.item
  if (item?.kind !== 'ordered') return value
  let out = value
  let shift = 0
  for (let j = subtreeEnd(lines, i) + 1; j < lines.length; j = subtreeEnd(lines, j) + 1) {
    const line = lines[j]
    if (!line.item || line.parent !== lines[i].parent || line.first) break
    const next = numbered(line.item.marker, n++)
    if (next !== line.item.marker) {
      const from = line.start + line.item.indent.length + shift
      out = replace(out, from, from + line.item.marker.length, next)
      shift += next.length - line.item.marker.length
    }
  }
  return out
}

/** Shift every line from `from` to `to` (line indexes) right by `add` columns, or left by `-add`. */
function reindent(value: string, lines: Line[], from: number, to: number, add: number): string {
  let out = value
  for (let j = to; j >= from; j--) {
    const { start, text } = lines[j]
    if (add > 0) out = replace(out, start, start, ' '.repeat(add))
    else {
      let cut = 0
      while (cut < text.length && /[ \t]/.test(text[cut]) && indentWidth(text.slice(0, cut + 1)) <= -add) cut++
      out = replace(out, start, start + cut, '')
    }
  }
  return out
}

function lineOf(value: string, offset: number) {
  const lines = analyze(value)
  const i = lineIndexAt(lines, offset)
  return { lines, i, line: lines[i] }
}

/**
 * Return in a list. On an item it splits the item at the caret and numbers the
 * new one next, renumbering the items after it; a task continues unchecked. On
 * an empty item it lifts the item one level, and at the top it leaves the list.
 * With Shift it starts a continuation line in the same item. Null off a list.
 */
export function listEnter(value: string, caret: number, shift = false): TextEdit | null {
  const { lines, i, line } = lineOf(value, caret)
  if (line.owner === undefined || line.code) return null
  const owner = lines[line.owner]
  const item = owner.item!
  if (shift) {
    const pad = `\n${' '.repeat(item.column)}`
    return { value: replace(value, caret, caret, pad), caret: caret + pad.length }
  }
  if (line.item) {
    if (!item.space || caret < line.start + item.end) return null
    if (!value.slice(line.start + item.end, line.end).trim()) {
      const parent = line.parent! >= 0 ? lines[line.parent!].item! : null
      const prefix = parent ? nextPrefix(parent) : ''
      const next = replace(value, line.start, line.start + item.end, prefix)
      return {
        value: parent?.kind === 'ordered' ? renumberAfter(next, i, Number.parseInt(parent.marker, 10) + 2) : next,
        caret: line.start + prefix.length,
      }
    }
  }
  const prefix = nextPrefix(item)
  const blank = !line.item && !line.text.trim()
  const next = blank ? replace(value, line.start, line.end, prefix) : replace(value, caret, caret, `\n${prefix}`)
  const at = blank ? line.start + prefix.length : caret + 1 + prefix.length
  return { value: item.kind === 'ordered' ? renumberAfter(next, lineIndexAt(analyze(next), at), Number.parseInt(item.marker, 10) + 2) : next, caret: at }
}

/**
 * Tab on a list line nests the item under the sibling above it, with its own
 * nested lines: numbered from 1, or after the sibling's last child. The items
 * after it in the old list are renumbered. With no sibling above it, nothing
 * changes. Null off a list.
 */
export function listIndent(value: string, caret: number): TextEdit | null {
  const { lines, i, line } = lineOf(value, caret)
  if (line.owner === undefined || line.code) return null
  const item = line.item
  if (!item || line.first) return { value, caret }
  let sibling = i - 1
  while (lines[sibling].owner !== sibling || lines[sibling].parent !== line.parent) sibling--
  const above = lines[sibling].item!
  let child: ListItemLine | null = null
  for (let j = sibling + 1; j < i; j++) if (lines[j].item && lines[j].parent === sibling) child = lines[j].item!
  const indent = child ? child.indent : above.indent + ' '.repeat(above.column - indentWidth(above.indent))
  const marker = item.kind !== 'ordered' ? item.marker
    : child?.kind === 'ordered' && child.marker.slice(-1) === item.marker.slice(-1) ? nextOrderedMarker(child.marker)
    : `1${item.marker.slice(-1)}`
  let next = reindent(value, lines, i + 1, subtreeEnd(lines, i), indentWidth(indent) - indentWidth(item.indent))
  next = replace(next, line.start, line.start + item.indent.length + item.marker.length, indent + marker)
  if (above.kind === 'ordered') next = renumberAfter(next, sibling, Number.parseInt(above.marker, 10) + 1)
  return { value: next, caret: movedCaret(line, item, indent + marker, caret) }
}

/**
 * Shift+Tab on a list line lifts a nested item to follow its parent, numbered
 * after it, and the parent's later items are renumbered; the items that followed
 * it in its old list become its own children, numbered from 1. An indented item
 * with no parent loses one step of indent. Null off a list.
 */
export function listOutdent(value: string, caret: number): TextEdit | null {
  const { lines, i, line } = lineOf(value, caret)
  if (line.owner === undefined || line.code) return null
  const item = line.item
  if (!item || !item.indent) return { value, caret }
  const parent = line.parent! >= 0 ? lines[line.parent!].item! : null
  const indent = parent ? parent.indent : item.indent.replace(/^(?:\t| {1,2})/, '')
  const continues = parent?.kind === 'ordered' && item.kind === 'ordered' && parent.marker.slice(-1) === item.marker.slice(-1)
  const marker = continues ? nextOrderedMarker(parent!.marker) : item.marker
  let next = reindent(value, lines, i + 1, subtreeEnd(lines, i), indentWidth(indent) - indentWidth(item.indent))
  next = replace(next, line.start, line.start + item.indent.length + item.marker.length, indent + marker)
  if (parent) {
    const after = analyze(next)
    const child = after.findIndex((l, j) => j > i && l.item && l.parent === i)
    if (child >= 0 && after[child].item!.kind === 'ordered') {
      const { start, item: first } = after[child]
      const from = start + first!.indent.length
      next = renumberAfter(replace(next, from, from + first!.marker.length, numbered(first!.marker, 1)), child, 2)
    }
    if (continues) next = renumberAfter(next, i, Number.parseInt(marker, 10) + 1)
  }
  return { value: next, caret: movedCaret(line, item, indent + marker, caret) }
}

/** The caret after an item's indent and marker became `prefix`: on the text it stays on the same character. */
function movedCaret(line: Line, item: ListItemLine, prefix: string, caret: number): number {
  const oldEnd = line.start + item.indent.length + item.marker.length
  return caret < oldEnd ? line.start + prefix.length : caret + prefix.length - (oldEnd - line.start)
}

/**
 * Tab or Shift+Tab over a selection: every list item it touches moves, top to
 * bottom (so siblings nest under the same item), each with its own nested lines,
 * so an item whose parent is selected too is not moved again. A selection ending
 * at the very start of a line leaves that line out. The selection keeps its
 * characters. Null when it touches no list line.
 */
export function listIndentLines(value: string, from: number, to: number, out: boolean): (TextEdit & { end: number }) | null {
  const before = analyze(value)
  const first = lineIndexAt(before, from)
  const toLine = lineIndexAt(before, to)
  const last = toLine > first && to === before[toLine].start ? toLine - 1 : toLine
  if (!before.slice(first, last + 1).some((l) => l.owner !== undefined && !l.code)) return null
  const selected = (i: number) => i >= first && i <= last && !!before[i].item && !before[i].code
  const moved = new Set<number>()
  let next = value
  for (let i = first; i <= last; i++) {
    if (!selected(i)) continue
    let up = before[i].parent!
    while (up >= 0 && !moved.has(up)) up = before[up].parent!
    if (up >= 0) continue
    const line = analyze(next)[i]
    const result = (out ? listOutdent : listIndent)(next, line.start + line.item!.end)!.value
    if (result !== next) moved.add(i)
    next = result
  }
  const after = analyze(next)
  // On a line's text a selection end keeps its distance from the line's end; inside a
  // marker it keeps its column if the marker is unchanged, else it goes to the text.
  const keep = (offset: number, i: number) => {
    const b = before[i], a = after[i]
    const was = b.text.slice(0, b.item?.end ?? 0), now = a.text.slice(0, a.item?.end ?? 0)
    if (offset - b.start >= was.length) return Math.max(a.start, a.end - (b.end - offset))
    return a.start + (was === now ? offset - b.start : now.length)
  }
  return { value: next, caret: keep(from, first), end: last < toLine ? after[toLine].start : keep(to, toLine) }
}

/** Without a selection: the text with the selected span taken out, and the caret where it was. */
export function cutSelection(value: string, from: number, to: number): { value: string; caret: number } {
  return { value: value.slice(0, from) + value.slice(to), caret: from }
}

/** The message to send: an empty item Return left at the end of a list is dropped. */
export function messageText(value: string): string {
  const lines = analyze(value.trimEnd())
  const last = lines[lines.length - 1]
  const empty = last.item && !last.text.slice(last.item.end).trim() && lines.length > 1 && lines[lines.length - 2].owner !== undefined
  return (empty ? value.slice(0, last.start) : value).trim()
}

/**
 * Backspace with formatting on, at the start of a line's text. On an item it
 * lifts a nested one (as Shift+Tab) and takes a top-level one out of its list;
 * on a continuation line, or a line just below a list, it joins the line above.
 */
export function listBackspace(value: string, caret: number): TextEdit | null {
  const { lines, i, line } = lineOf(value, caret)
  if (line.code) return null
  if (line.item) {
    if (caret !== line.start + line.item.end) return null
    if (line.item.indent) return listOutdent(value, caret)
    return { value: replace(value, line.start, caret, ''), caret: line.start }
  }
  const textStart = line.start + (line.owner === undefined ? 0 : line.text.length - line.text.trimStart().length)
  if (caret !== textStart || i === 0 || (line.owner === undefined && lines[i - 1].owner === undefined)) return null
  return { value: replace(value, line.start - 1, caret, ''), caret: line.start - 1 }
}

/**
 * Delete with formatting on, at the end of a line in or just above a list: the
 * next line's text joins this one, without its marker or indent. A fence below
 * stays where it is.
 */
export function listDelete(value: string, caret: number): TextEdit | null {
  const { lines, i, line } = lineOf(value, caret)
  const below = lines[i + 1]
  if (caret !== line.end || !below || line.code || (line.owner === undefined && below.owner === undefined)) return null
  if (below.code) return { value, caret }
  const cut = below.item ? below.item.end : below.owner === undefined ? 0 : below.text.length - below.text.trimStart().length
  return { value: replace(value, line.end, below.start + cut, ''), caret }
}
