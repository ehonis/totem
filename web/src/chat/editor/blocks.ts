// Markdown formatted as it is typed (#298): ordered, bullet and task lists, and
// fenced code. The nodes keep the prefix each line was typed with (doc.ts), and
// every list key goes through the string (markdown.ts), so the message is always
// the Markdown on screen. After T3 Code's composer-rich-text-doc.ts and
// composer-code-block.ts.
import { Extension, InputRule, Node, combineTransactionSteps, getChangedRanges, type Editor } from '@tiptap/core'
import Paragraph from '@tiptap/extension-paragraph'
import { exitCode } from '@tiptap/pm/commands'
import { isHistoryTransaction } from '@tiptap/pm/history'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { ReplaceStep, canJoin } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'
import { LIST_NODES, REF_NODE, blockToValue, docDiff, docToValue, formats, offsetToPos, posToOffset, sameList, selectionRange, valueToBlocks, valueToDoc } from './doc'
import { analyze, cutSelection, isClosingFence, listBackspace, listDelete, listEnter, listIndentLines, parseListLine, parseOpeningFence, type TextEdit } from './markdown'

/**
 * Make the message `next` by replacing only what differs, selecting `caret` to
 * `end`. TipTap clears a document emptied from a whole selection back to a bare
 * paragraph; the string already says what the document is, so that is held off.
 */
export function applyValue(view: EditorView, next: string, caret: number, end = caret) {
  const { state } = view
  const diff = docDiff(state.doc, valueToDoc(state.schema, next))
  const tr = state.tr.setMeta('preventClearDocument', true)
  if (diff) tr.replace(diff.start, diff.end, diff.slice)
  tr.setSelection(TextSelection.create(tr.doc, offsetToPos(tr.doc, caret), offsetToPos(tr.doc, end)))
  view.dispatch(tr.scrollIntoView())
}

/** A list key as an edit of the string; a selection is taken out first, as typing would. */
function edit(editor: Editor, fn: (value: string, caret: number) => TextEdit | null): boolean {
  const { doc, selection } = editor.state
  const { start, end } = selectionRange(doc, selection.from, selection.to)
  const { value, caret } = cutSelection(docToValue(doc), start, end)
  const result = fn(value, caret)
  if (!result) return false
  applyValue(editor.view, result.value, result.caret)
  return true
}

/** Tab and Shift+Tab move every list item the selection touches, and keep the selection. */
function indent(editor: Editor, out: boolean): boolean {
  const { doc, selection } = editor.state
  const value = docToValue(doc)
  const from = posToOffset(doc, selection.from)
  let to = posToOffset(doc, selection.to)
  // The start of a line's text is the start of its line here (the marker has no caret
  // position), so a selection ending there (Shift+Down from a line's start) leaves it out.
  const end = analyze(value).find((l) => to >= l.start && to <= l.end)
  if (end?.item && to > from && from < end.start && to === end.start + end.item.end) to = end.start
  const result = listIndentLines(value, from, to, out)
  if (!result) return false
  applyValue(editor.view, result.value, result.caret, result.end)
  return true
}

const inCode = (state: EditorState) => {
  const { $from, $to } = state.selection
  return $from.parent.type.name === 'codeBlock' && $from.sameParent($to)
}

/**
 * Return and Tab where formatting decides what they do: in a list (formatting on
 * or off, through the string), and in a code block. True when the key was used.
 */
export function formatKey(editor: Editor, e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  const { view } = editor
  const code = formats(editor.schema) && inCode(view.state)
  if (e.key === 'Enter') {
    if (code) return e.shiftKey ? insertInCode(view, '\n') : codeReturn(view)
    if (!e.shiftKey && formats(editor.schema) && openFence(view)) return true
    return edit(editor, (value, caret) => listEnter(value, caret, e.shiftKey))
  }
  if (e.key === 'Tab') return code ? indentCode(view, e.shiftKey) : indent(editor, e.shiftKey)
  return false
}

// --- the nodes ---------------------------------------------------------------

const ITEM_CONTENT = 'paragraph (paragraph | list)*'
const attr = (name: string, fallback: string) => ({ default: fallback, rendered: false, parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) ?? fallback })

/** A list item's text is its first paragraph; later ones are its continuation lines, each with the indent it was typed with. */
const IndentedParagraph = Paragraph.extend({
  addAttributes: () => ({ indent: { ...attr('indent', ''), rendered: true, renderHTML: ({ indent }: { indent: string }) => (indent ? { 'data-indent': indent } : {}) } }),
})

const list = (name: string, tag: 'ol' | 'ul', item: string, type?: string) => Node.create({
  name,
  group: 'block list',
  content: `${item}+`,
  parseHTML: () => [{ tag: type ? `ul[data-type="${type}"]` : tag, priority: type ? 60 : 50 }],
  renderHTML: () => [tag, type ? { 'data-type': type } : {}, 0],
})

const ListItem = Node.create({
  name: 'listItem',
  content: ITEM_CONTENT,
  defining: true,
  addAttributes: () => ({ indent: attr('indent', ''), marker: attr('marker', '-'), space: attr('space', ' ') }),
  parseHTML: () => [{ tag: 'li[data-marker]:not([data-check])' }],
  // The marker drawn is the one typed (`3)`, a nested `7.`); its width sets the list's gutter.
  renderHTML: ({ node }) => ['li', {
    'data-marker': node.attrs.marker,
    'data-marker-width': Math.min(node.attrs.marker.length, 10),
    value: /^\d/.test(node.attrs.marker) ? Number.parseInt(node.attrs.marker, 10) : null,
    'data-indent': node.attrs.indent,
    'data-space': node.attrs.space,
  }, 0],
})

const TaskItem = Node.create({
  name: 'taskItem',
  content: ITEM_CONTENT,
  defining: true,
  addAttributes: () => ({ indent: attr('indent', ''), marker: attr('marker', '-'), markerSpace: attr('marker-space', ' '), check: attr('check', ' '), space: attr('space', ' ') }),
  parseHTML: () => [{ tag: 'li[data-check]', contentElement: 'div' }],
  renderHTML: ({ node }) => ['li', {
    'data-check': node.attrs.check,
    'data-marker': node.attrs.marker,
    'data-indent': node.attrs.indent,
    'data-marker-space': node.attrs.markerSpace,
    'data-space': node.attrs.space,
  }, ['label', { contenteditable: 'false' }, ['input', { type: 'checkbox', ...(node.attrs.check !== ' ' ? { checked: 'checked' } : {}) }]], ['div', 0]],
  // A real checkbox: clicking it writes `[x]` or `[ ]`.
  addNodeView: () => ({ node, getPos, editor }) => {
    const dom = document.createElement('li')
    const label = document.createElement('label')
    const box = document.createElement('input')
    const contentDOM = document.createElement('div')
    label.contentEditable = 'false'
    box.type = 'checkbox'
    box.tabIndex = -1
    box.setAttribute('aria-label', 'Done')
    label.append(box)
    dom.append(label, contentDOM)
    let current = node
    const draw = (n: PMNode) => {
      current = n
      box.checked = n.attrs.check !== ' '
      dom.dataset.check = n.attrs.check
    }
    draw(node)
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('change', () => {
      const pos = getPos()
      if (typeof pos === 'number') editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, check: box.checked ? 'x' : ' ' }))
    })
    return {
      dom,
      contentDOM,
      update: (n: PMNode) => n.type === current.type && (draw(n), true),
      stopEvent: (e: Event) => e.target === box,
      ignoreMutation: (m: { target: globalThis.Node }) => label.contains(m.target),
    }
  },
})

const CodeBlock = Node.create({
  name: 'codeBlock',
  group: 'block',
  content: `(text | ${REF_NODE})*`,
  marks: '',
  code: true,
  defining: true,
  addAttributes: () => ({ fence: attr('fence', '```'), language: attr('language', ''), close: attr('close', '\n```') }),
  parseHTML: () => [{ tag: 'pre', preserveWhitespace: 'full' }],
  renderHTML: ({ node }) => ['pre', {
    'data-fence': node.attrs.fence,
    'data-language': node.attrs.language,
    'data-close': node.attrs.close,
  }, ['code', 0]],
})

// --- input rules ---------------------------------------------------------------

/** Read one top-level block again as the text it holds, and join it to a list beside it that its text continues. */
function reformat(tr: Transaction, pos: number): void {
  const block = tr.doc.nodeAt(pos)
  if (!block) return
  const blocks = valueToBlocks(tr.doc.type.schema, blockToValue(block))
  if (blocks.length === 1 && blocks[0].eq(block)) return
  const caret = posToOffset(tr.doc, tr.selection.head)
  tr.replaceWith(pos, pos + block.nodeSize, blocks)
  const end = pos + blocks.reduce((n, b) => n + b.nodeSize, 0)
  for (const at of [end, pos]) {
    const $at = tr.doc.resolve(at)
    if ($at.nodeBefore && $at.nodeAfter && sameList($at.nodeBefore, $at.nodeAfter) && canJoin(tr.doc, at)) tr.join(at)
  }
  tr.setSelection(TextSelection.create(tr.doc, offsetToPos(tr.doc, caret)))
}

/**
 * A marker typed at the start of a top-level line (or `[ ] ` at the start of a
 * bullet) turns the line into a list item. Backspace straight after puts the typed
 * text back.
 */
const listRule = (find: RegExp, inBullet = false) => new InputRule({
  find,
  handler: ({ state, range }) => {
    const $from = state.tr.doc.resolve(range.from)
    if ($from.parent.type.name !== 'paragraph' || $from.parentOffset !== 0) return null
    const item = $from.depth > 1 ? $from.node(-1) : null
    const fits = inBullet
      ? item?.type.name === 'listItem' && $from.index(-1) === 0 && /^[-*+]$/.test(item.attrs.marker)
      : $from.depth === 1
    if (!fits) return null
    reformat(state.tr, $from.before(1))
  },
})

const LIST_RULES = [
  listRule(/^\d{1,9}[.)][ \t]$/),
  listRule(/^[*+][ \t]$/),
  // `- ` waits for the next character, which leaves room for `- [ ]`.
  listRule(/^-[ \t]+[^\s[]$/),
  listRule(/^-[ \t]+\[[ xX]\][ \t]$/),
  listRule(/^\[[ xX]\][ \t]$/, true),
]

// --- the reformat pass ---------------------------------------------------------

/** Only text typed or deleted inside one line, which the input rules already watch. */
const isTyping = (tr: Transaction) => tr.steps.every((step, i) => {
  if (!(step instanceof ReplaceStep)) return false
  const { from, to, slice } = step
  let inline = !slice.openStart && !slice.openEnd
  slice.content.forEach((n) => { inline &&= n.isInline })
  return inline && tr.docs[i].resolve(from).parent === tr.docs[i].resolve(to).parent
})

/**
 * A line still being typed as a marker: nothing after it yet, `- [` on its way to
 * a task, or `- ` and the one character its input rule is about to take (so
 * Backspace straight after can put it back).
 */
function held(state: EditorState, pos: number, text: string): boolean {
  const { $head } = state.selection
  if ($head.depth !== 1 || $head.before(1) !== pos) return false
  const item = parseListLine(text)!
  const rest = text.slice(item.end)
  const dash = item.kind === 'bullet' && item.marker === '-'
  return !rest || (dash && /^\[(?:[ xX]\]?)?$/.test(rest)) || (dash && rest.length === 1 && $head.parentOffset === $head.parent.content.size)
}

/**
 * Catches what the input rules do not see: a marker pasted, dropped, dictated or
 * edited in at the start of a top-level line, and a list that an edit across
 * lines left out of step with its text. Waits for IME composition to end.
 */
function reformatPass(isComposing: () => boolean) {
  let pending = new Set<number>()
  return new Plugin({
    key: new PluginKey('markdownReformat'),
    props: {
      handleDOMEvents: {
        compositionend: (view) => {
          setTimeout(() => { if (!view.isDestroyed && !view.composing && pending.size) view.dispatch(view.state.tr) })
          return false
        },
      },
    },
    appendTransaction(transactions, oldState, state) {
      // Backspace after an input rule puts the typed text back on purpose.
      const afterRule = oldState.plugins.some((p) => (p.spec as { isInputRules?: boolean }).isInputRules && p.getState(oldState))
      if (afterRule || transactions.some((tr) => tr.getMeta('inputRule'))) {
        pending.clear()
        return null
      }
      // Undo and redo restore lines as they were typed, but a list they leave must read as its text.
      const history = transactions.some(isHistoryTransaction)
      if (history) pending.clear()
      if (!pending.size && !transactions.some((tr) => tr.docChanged)) return null
      const changes = combineTransactionSteps(oldState.doc, [...transactions])
      pending = new Set([...pending].flatMap((pos) => {
        const mapped = changes.mapping.mapResult(pos, 1)
        return mapped.deleted ? [] : [mapped.pos]
      }))
      const typing = transactions.every(isTyping)
      for (const { newRange } of getChangedRanges(changes)) {
        state.doc.forEach((block, pos) => {
          if (pos + block.nodeSize < newRange.from || pos > newRange.to) return
          if (block.type.name === 'paragraph') {
            if (history) return
            const item = parseListLine(blockToValue(block))
            // Typing after a marker left as text keeps it text; only an edit inside the marker changes it.
            if (item && (!typing || newRange.from < pos + 1 + item.end)) pending.add(pos)
          } else if ((!typing || history) && LIST_NODES.has(block.type.name)) pending.add(pos)
        })
      }
      if (isComposing() || transactions.some((tr) => tr.getMeta('composition') != null)) return null
      const tr = state.tr
      const waiting: number[] = []
      for (const pos of [...pending].sort((a, b) => b - a)) {
        const block = tr.doc.nodeAt(pos)
        if (block?.type.name === 'paragraph') {
          const text = blockToValue(block)
          const item = parseListLine(text)
          if (!item || item.indent) continue
          if (held(state, pos, text)) { waiting.push(pos); continue }
        } else if (!block || !LIST_NODES.has(block.type.name)) continue
        reformat(tr, pos)
      }
      pending = new Set(waiting.map((pos) => tr.mapping.map(pos, 1)))
      return tr.docChanged ? tr : null
    },
  })
}

// --- code blocks -----------------------------------------------------------------

const CODE_INDENT = '  '

/** A code block's text with each chip as one character, so offsets in it are offsets in the node. */
const codeText = (block: PMNode) => block.textBetween(0, block.content.size, undefined, '\ufffc')

/** A code block's content, one fragment per line. */
function codeLines(content: Fragment): Fragment[] {
  const lines: PMNode[][] = [[]]
  content.forEach((n) => {
    if (!n.isText) { lines[lines.length - 1].push(n); return }
    n.text!.split('\n').forEach((part, i) => {
      if (i) lines.push([])
      if (part) lines[lines.length - 1].push(n.type.schema.text(part))
    })
  })
  return lines.map((l) => Fragment.fromArray(l))
}

function insertInCode(view: EditorView, text: string): boolean {
  view.dispatch(view.state.tr.insertText(text).scrollIntoView())
  return true
}

/** Return on a line that is only an opening fence (```lang) makes it a code block. */
function openFence(view: EditorView): boolean {
  const { $from, empty } = view.state.selection
  if (!empty || $from.depth !== 1 || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size) return false
  // A chip on the line is not a language.
  let chip = false
  $from.parent.forEach((n) => { chip ||= n.type.name === REF_NODE })
  if (chip) return false
  const fence = parseOpeningFence(blockToValue($from.parent))
  if (!fence) return false
  const start = $from.before()
  const tr = view.state.tr.replaceWith(start, start + $from.parent.nodeSize, view.state.schema.nodes.codeBlock.create({ ...fence, close: `\n${fence.fence}` }))
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)).scrollIntoView())
  return true
}

/**
 * Return in a code block: after a typed closing fence it ends the block there;
 * on a third line in a row that is blank it leaves the block; otherwise a new
 * line keeps the indent of the one above.
 */
function codeReturn(view: EditorView): boolean {
  const { state } = view
  const { $from, empty } = state.selection
  const block = $from.parent
  const text = codeText(block)
  const caret = $from.parentOffset
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  if (empty) {
    const lineEnd = text.indexOf('\n', caret) < 0 ? text.length : text.indexOf('\n', caret)
    const line = text.slice(lineStart, lineEnd)
    if (caret === lineEnd && isClosingFence(line, block.attrs.fence)) {
      const { schema } = state
      const lines = codeLines(block.content)
      const index = text.slice(0, lineStart).split('\n').length - 1
      const code: PMNode[] = []
      lines.slice(0, index).forEach((l, i) => { if (i) code.push(schema.text('\n')); l.forEach((n) => { code.push(n) }) })
      const closed = block.type.create({ ...block.attrs, close: `\n${line}` }, code)
      const after = [Fragment.empty, ...lines.slice(index + 1)].map((l) => schema.nodes.paragraph.create(null, l))
      const at = $from.before()
      const tr = state.tr.replaceWith(at, at + block.nodeSize, [closed, ...after])
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + closed.nodeSize + 1)).scrollIntoView())
      return true
    }
    const trailing = caret === block.content.size && /\n[ \t]*\n[ \t]*$/.exec(text)
    if (trailing) {
      const tr = state.tr.delete($from.pos - trailing[0].length, $from.pos)
      if (!block.attrs.close) tr.setNodeAttribute($from.before(), 'close', `\n${block.attrs.fence}`)
      view.dispatch(tr)
      return exitCode(view.state, (t) => view.dispatch(t.scrollIntoView()))
    }
  }
  const indent = /^[ \t]*/.exec(text.slice(lineStart, caret))![0]
  return insertInCode(view, `\n${indent}`)
}

/** Tab and Shift+Tab in a code block indent by two spaces: at the caret, or every line of a selection. */
function indentCode(view: EditorView, out: boolean): boolean {
  const { state } = view
  const { from, to, $from, empty } = state.selection
  if (empty && !out) return insertInCode(view, CODE_INDENT)
  const text = codeText($from.parent)
  const start = $from.start()
  const tr = state.tr
  let line = text.lastIndexOf('\n', from - start - 1) + 1
  const starts: number[] = []
  while (line <= Math.max(from - start, to - start - 1)) {
    starts.push(line)
    const next = text.indexOf('\n', line)
    if (next < 0) break
    line = next + 1
  }
  for (const at of starts.reverse()) {
    const rest = text.slice(at)
    if (!out) { if (rest && rest[0] !== '\n') tr.insertText(CODE_INDENT, start + at) }
    else {
      const cut = /^(?: {1,2}|\t)/.exec(rest)?.[0].length ?? 0
      if (cut) tr.delete(start + at, start + at + cut)
    }
  }
  if (tr.docChanged) view.dispatch(tr.scrollIntoView())
  return true
}

/** Backspace at the start of a code block takes the fences away and leaves its lines. */
function unwrapCode(editor: Editor): boolean {
  const { state } = editor
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.name !== 'codeBlock' || $from.parentOffset !== 0) return false
  const at = $from.before()
  const lines = codeLines($from.parent.content).map((l) => state.schema.nodes.paragraph.create(null, l))
  const tr = state.tr.replaceWith(at, at + $from.parent.nodeSize, lines)
  editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)))
  return true
}

/** A caret at the start or end of its line's text, where Backspace and Delete cross lines. */
function atEdge(state: EditorState, edge: 'start' | 'end'): boolean {
  const { $from, empty } = state.selection
  return empty && $from.parent.type.name !== 'codeBlock' && $from.parentOffset === (edge === 'start' ? 0 : $from.parent.content.size)
}

// --- the extension ---------------------------------------------------------------

const Markdown = Extension.create({
  name: 'markdown',
  addInputRules: () => LIST_RULES,
  addProseMirrorPlugins() {
    return [reformatPass(() => this.editor.view.composing)]
  },
  addKeyboardShortcuts() {
    return {
      Backspace: () => this.editor.commands.undoInputRule() || unwrapCode(this.editor) || (atEdge(this.editor.state, 'start') && edit(this.editor, listBackspace)),
      Delete: () => atEdge(this.editor.state, 'end') && edit(this.editor, listDelete),
    }
  },
})

/** The nodes and behaviour that format Markdown as it is typed. */
export const markdownExtensions = [
  IndentedParagraph,
  list('orderedList', 'ol', 'listItem'),
  list('bulletList', 'ul', 'listItem'),
  list('taskList', 'ul', 'taskItem', 'taskList'),
  ListItem,
  TaskItem,
  CodeBlock,
  Markdown,
]
