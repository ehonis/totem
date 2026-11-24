// The composer's editor is a view over the message string (refs.ts): each
// reference an inline `ref` node, everything else literal text. Without
// formatting every line is a paragraph. With it (a schema that has lists, #298)
// list items, their continuation lines and fenced code are their own nodes,
// which keep the exact prefix they were typed with, so the string comes back
// unchanged. These convert between the two and map a caret between a string
// offset and a document position.
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { formatRef, splitRefs, type Ref } from '../refs'
import { analyze, isClosingFence, parseOpeningFence, type Line } from './markdown'

export const REF_NODE = 'ref'
export const LIST_NODES = new Set(['orderedList', 'bulletList', 'taskList'])

const inlineNodes = (schema: Schema, text: string): PMNode[] => splitRefs(text).flatMap((p) => (
  p.ref ? [schema.nodes[REF_NODE].create(p.ref)] : p.text ? [schema.text(p.text)] : []
))
const paragraphs = (schema: Schema, value: string) => value.split('\n').map((line) => schema.nodes.paragraph.create(null, inlineNodes(schema, line)))

/** Whether this editor formats Markdown as it is typed. */
export const formats = (schema: Schema) => !!schema.nodes.orderedList

interface PendingItem { line: Line; content: (PMNode | PendingList)[] }
interface PendingList { items: PendingItem[] }

function listNode(schema: Schema, list: PendingList): PMNode {
  const items = list.items.map(({ line, content }) => {
    const item = line.item!
    const blocks = content.map((c) => ('items' in c ? listNode(schema, c) : c))
    const text = line.text.slice(item.end)
    blocks.unshift(schema.nodes.paragraph.create(null, inlineNodes(schema, text)))
    return item.kind === 'task'
      ? schema.nodes.taskItem.create({ indent: item.indent, marker: item.marker, markerSpace: item.markerSpace, check: item.check, space: item.space }, blocks)
      : schema.nodes.listItem.create({ indent: item.indent, marker: item.marker, space: item.space }, blocks)
  })
  const kind = list.items[0].line.item!.kind
  return schema.nodes[kind === 'ordered' ? 'orderedList' : kind === 'task' ? 'taskList' : 'bulletList'].create(null, items)
}

function formattedBlocks(schema: Schema, value: string): PMNode[] {
  const lines = analyze(value)
  const blocks: PMNode[] = []
  const pending = new Map<number, PendingItem>()
  let roots: PendingList[] = []
  const flush = () => { for (const list of roots) blocks.push(listNode(schema, list)); roots = []; pending.clear() }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.code) {
      flush()
      const open = parseOpeningFence(line.text)!
      let j = i + 1
      while (j < lines.length && !isClosingFence(lines[j].text, open.fence)) j++
      const closed = j < lines.length
      const body = lines.slice(i + 1, j).map((l) => l.text).join('\n')
      blocks.push(schema.nodes.codeBlock.create({ fence: open.fence, language: open.language, close: closed ? `\n${lines[j].text}` : '' }, inlineNodes(schema, body)))
      i = closed ? j : lines.length
      continue
    }
    if (line.owner === undefined) {
      flush()
      blocks.push(schema.nodes.paragraph.create(null, inlineNodes(schema, line.text)))
      continue
    }
    if (!line.item) {
      const indent = line.text.length - line.text.trimStart().length
      pending.get(line.owner)!.content.push(schema.nodes.paragraph.create({ indent: line.text.slice(0, indent) }, inlineNodes(schema, line.text.slice(indent))))
      continue
    }
    const item: PendingItem = { line, content: [] }
    pending.set(i, item)
    const siblings = line.parent! < 0 ? roots : pending.get(line.parent!)!.content
    const last = siblings[siblings.length - 1]
    if (!line.first && last && 'items' in last) last.items.push(item)
    else siblings.push({ items: [item] })
  }
  flush()
  return blocks
}

const blocksFor = (schema: Schema, value: string) => (formats(schema) ? formattedBlocks(schema, value) : paragraphs(schema, value))

export function valueToDoc(schema: Schema, value: string): PMNode {
  return schema.nodes.doc.create(null, blocksFor(schema, value))
}

/** Text pasted or set in the middle of a line: its first and last lines join the lines around them. */
export function valueToSlice(schema: Schema, value: string): Slice {
  return new Slice(Fragment.fromArray(paragraphs(schema, value)), 1, 1)
}

const inlineText = (n: PMNode) => (n.isText ? n.text || '' : n.type.name === REF_NODE ? formatRef(n.attrs as Ref) : '')
const blockText = (block: PMNode) => {
  let text = ''
  block.forEach((n) => { text += inlineText(n) })
  return text
}

/** The prefix an item is written with; an empty item's padding comes back once it has text. */
function itemPrefix(item: PMNode): string {
  const { indent, marker, space } = item.attrs
  const pad = space || (item.firstChild?.content.size ? ' ' : '')
  return item.type.name === 'taskItem' ? `${indent}${marker}${item.attrs.markerSpace}[${item.attrs.check}]${pad}` : `${indent}${marker}${pad}`
}

/**
 * How a code block is written: a closing fence typed as its last line closes it
 * (Return was not pressed after it), a fence inside the code gets a longer one
 * around it, and a block that more follows is always closed.
 */
function fences(block: PMNode, followed: boolean) {
  const { language } = block.attrs
  let { fence, close } = block.attrs as { fence: string; close: string }
  const lines = blockText(block).split('\n')
  if (lines.length > 1 && isClosingFence(lines[lines.length - 1], fence)) close = `\n${lines.pop()}`
  const longest = Math.max(0, ...lines.filter((l) => isClosingFence(l, fence)).map((l) => /[`~]+/.exec(l)![0].length))
  if (longest) {
    fence = fence[0].repeat(longest + 1)
    if (close) close = `\n${fence}`
  }
  if (!close && followed) close = `\n${fence}`
  return { open: `${fence}${language}\n`, body: lines.join('\n'), close }
}

/** Each textblock: where its text starts in the document and the string, and its whole line or lines there. */
interface Span { pos: number; offset: number; node: PMNode; lineStart: number; lineEnd: number }
interface Written { value: string; spans: Span[] }

const written = new WeakMap<PMNode, Written>()

function write(doc: PMNode): Written {
  const cached = written.get(doc)
  if (cached) return cached
  let value = ''
  const spans: Span[] = []
  const line = (prefix: string, node: PMNode, pos: number, text = blockText(node), suffix = '') => {
    if (spans.length) value += '\n'
    const lineStart = value.length
    value += prefix
    const offset = value.length
    value += text + suffix
    spans.push({ pos, offset, node, lineStart, lineEnd: value.length })
  }
  const list = (node: PMNode, pos: number) => node.forEach((item, at) => {
    const start = pos + 1 + at + 1
    item.forEach((child, childAt) => {
      const childPos = start + childAt
      if (LIST_NODES.has(child.type.name)) list(child, childPos)
      else line(childAt === 0 ? itemPrefix(item) : child.attrs.indent || '', child, childPos + 1)
    })
  })
  doc.forEach((block, pos, index) => {
    if (LIST_NODES.has(block.type.name)) list(block, pos)
    else if (block.type.name === 'codeBlock') {
      const { open, body, close } = fences(block, index < doc.childCount - 1)
      line(open, block, pos + 1, body, close)
    } else line('', block, pos + 1)
  })
  const out = { value, spans }
  written.set(doc, out)
  return out
}

export function docToValue(doc: PMNode): string {
  return write(doc).value
}

/**
 * Where a selection's Markdown lies in the string, for copy, cut, paste and Return
 * over it. It takes a line's marker or opening fence only when it starts at that
 * line's text and runs on past its end (or starts outside the line, as select-all
 * does), and a code block's closing fence only when it reaches past the block:
 * a selection inside one line or one code block is just its text.
 */
export function selectionRange(doc: PMNode, from: number, to: number): { start: number; end: number } {
  const { spans } = write(doc)
  const first = spans.find((s) => from <= s.pos + s.node.content.size)
  const last = [...spans].reverse().find((s) => to >= s.pos)
  const endOf = (s: Span) => s.pos + s.node.content.size
  const start = first && (from < first.pos || (from === first.pos && to > endOf(first))) ? first.lineStart : posToOffset(doc, from)
  const end = last && (to > endOf(last) || (to === endOf(last) && from < last.pos)) ? last.lineEnd : posToOffset(doc, to)
  return { start, end: Math.max(start, end) }
}

/** The top-level block at `pos` as its own string. */
export function blockToValue(block: PMNode): string {
  return docToValue(block.type.schema.nodes.doc.create(null, block))
}

/** The top-level blocks a string makes, for putting one block back as it reads. */
export function valueToBlocks(schema: Schema, value: string): PMNode[] {
  return blocksFor(schema, value)
}

/** Every upload id the document refers to. */
export function docRefIds(doc: PMNode): Set<string> {
  const ids = new Set<string>()
  doc.descendants((n) => { if (n.type.name === REF_NODE) ids.add(n.attrs.id) })
  return ids
}

/** Where a document position falls in the string. */
export function posToOffset(doc: PMNode, pos: number): number {
  const { value, spans } = write(doc)
  for (const { pos: start, offset, node } of spans) {
    if (pos < start) return offset
    if (pos > start + node.content.size) continue
    let at = offset
    node.forEach((n, rel) => {
      const abs = start + rel
      if (abs < pos) at += n.isText ? Math.min(n.nodeSize, pos - abs) : inlineText(n).length
    })
    return at
  }
  return value.length
}

/** The document position for a string offset; one inside a reference lands after it, one in a prefix at the text after it. */
export function offsetToPos(doc: PMNode, offset: number): number {
  const { spans } = write(doc)
  for (const { pos, offset: start, node } of spans) {
    if (offset > start + blockText(node).length) continue
    if (offset <= start) return pos
    let left = offset - start
    let at = pos
    let found = -1
    node.forEach((n) => {
      if (found >= 0) return
      const len = inlineText(n).length
      if (n.isText && left <= len) { found = at + left; return }
      if (!n.isText && left < len) { found = at + n.nodeSize; return }
      left -= len
      at += n.nodeSize
    })
    return found >= 0 ? found : at
  }
  const last = spans[spans.length - 1]
  return last.pos + last.node.content.size
}

/** The replacement that turns `from` into `to`, as narrow as the two allow. */
export function docDiff(from: PMNode, to: PMNode): { start: number; end: number; slice: Slice } | null {
  const start = from.content.findDiffStart(to.content)
  if (start == null) return null
  let { a: endA, b: endB } = from.content.findDiffEnd(to.content)!
  const overlap = start - Math.min(endA, endB)
  if (overlap > 0) { endA += overlap; endB += overlap }
  return { start, end: endA, slice: to.slice(start, endB) }
}

/** Whether two lists would be one list if their text were read again. */
export function sameList(a: PMNode, b: PMNode): boolean {
  const key = (list: PMNode) => `${list.type.name}${list.firstChild!.attrs.marker.slice(-1)}`
  return LIST_NODES.has(a.type.name) && key(a) === key(b)
}
