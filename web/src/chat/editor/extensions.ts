// The composer editor's schema and behaviour, as one list; with `markdown` it
// also formats lists and code fences as they are typed (blocks.ts).
import { Extension, Node, type AnyExtension } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { UndoRedo } from '@tiptap/extensions/undo-redo'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { NodeViewRenderer } from '@tiptap/core'
import { splitMentions } from '../mentions'
import { REF_NODE } from './doc'
import { markdownExtensions } from './blocks'

/** An attachment named in the message: one inline atom, deleted and undone as a unit. */
const RefNode = Node.create({
  name: REF_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,
  addAttributes: () => ({
    id: { default: '', rendered: false },
    label: { default: '', rendered: false },
    image: { default: false, rendered: false },
  }),
  // Copying inside the editor keeps the chip (ProseMirror's own clipboard HTML).
  parseHTML: () => [{
    tag: 'span[data-ref-id]',
    getAttrs: (el) => ({ id: el.getAttribute('data-ref-id'), label: el.getAttribute('data-ref-label') || '', image: el.getAttribute('data-ref-image') === 'true' }),
  }],
  renderHTML: ({ node }) => ['span', { 'data-ref-id': node.attrs.id, 'data-ref-label': node.attrs.label, 'data-ref-image': String(node.attrs.image) }, node.attrs.label],
  // Copied out as plain text, it reads as the file's name.
  renderText: ({ node }) => node.attrs.label,
  addKeyboardShortcuts() {
    const removeNext = (dir: -1 | 1) => () => {
      const { state, view } = this.editor
      const { empty, $from } = state.selection
      const node = dir < 0 ? $from.nodeBefore : $from.nodeAfter
      if (!empty || node?.type.name !== REF_NODE) return false
      dispatchAlone(view, dir < 0 ? state.tr.delete($from.pos - 1, $from.pos) : state.tr.delete($from.pos, $from.pos + 1))
      return true
    }
    return { Backspace: removeNext(-1), Delete: removeNext(1) }
  },
})

/**
 * A chip put in or taken out is its own undo step: undo brings back the chip
 * (and its file) and not the typing beside it, before or after.
 */
export function dispatchAlone(view: EditorView, tr: Transaction) {
  view.dispatch(closeHistory(tr))
  view.dispatch(closeHistory(view.state.tr))
}

const mentionKey = new PluginKey<DecorationSet>('skillMentions')

function mentionDecorations(doc: PMNode, known: Set<string>) {
  const marks: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    let at = pos
    for (const part of splitMentions(node.text || '', known)) {
      if (part.mention) marks.push(Decoration.inline(at, at + part.text.length, { class: 'vc-mention' }))
      at += part.text.length
    }
  })
  return DecorationSet.create(doc, marks)
}

/** Each skill the message cites (`/name`), tinted as it is typed. */
const SkillMentions = Extension.create<{ known: () => Set<string> }>({
  name: 'skillMentions',
  addOptions: () => ({ known: () => new Set<string>() }),
  addProseMirrorPlugins() {
    const known = this.options.known
    return [new Plugin<DecorationSet>({
      key: mentionKey,
      state: {
        init: (_config, state: EditorState) => mentionDecorations(state.doc, known()),
        apply: (tr, old, _before, state) => (tr.docChanged || tr.getMeta(mentionKey) ? mentionDecorations(state.doc, known()) : old),
      },
      props: { decorations: (state) => mentionKey.getState(state) },
    })]
  },
})

/** The skill list changed: tint the message again. */
export const refreshMentions = (view: EditorView) => view.dispatch(view.state.tr.setMeta(mentionKey, true).setMeta('addToHistory', false))

/** Shift+Return is always a new line (Return's own meaning is the composer's to decide). */
const NewLine = Extension.create({
  name: 'newLine',
  addKeyboardShortcuts() {
    return { 'Shift-Enter': () => this.editor.commands.splitBlock() }
  },
})

export function createComposerExtensions({ known, chipView = null, markdown = false }: { known: () => Set<string>; chipView?: NodeViewRenderer | null; markdown?: boolean }): AnyExtension[] {
  return [
    Document, Text, UndoRedo, NewLine,
    ...(markdown ? markdownExtensions : [Paragraph]),
    chipView ? RefNode.extend({ addNodeView: () => chipView }) : RefNode,
    SkillMentions.configure({ known }),
  ]
}
