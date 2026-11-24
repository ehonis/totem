// The composer's text box (#295): a minimal TipTap editor over the message
// string, so an attachment can sit in the middle of a sentence as a chip.
// `value`/`onChange` stay a plain string (editor/doc.ts converts); the parent
// works in string offsets through the handle. Loaded on its own chunk.
import React, { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type ReactNodeViewProps, type UseEditorOptions } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { RefChip, type ChipInfo } from '../RefChip'
import { plainRefs, type Ref } from '../refs'
import { createComposerExtensions, dispatchAlone, refreshMentions } from './extensions'
import { applyValue, formatKey } from './blocks'
import { REF_NODE, docRefIds, docToValue, formats, offsetToPos, posToOffset, selectionRange, valueToDoc, valueToSlice } from './doc'

/**
 * Chips to put where the caret was when a file was picked, pasted or dropped.
 * `insert` is false when they were not put in: the text was replaced from outside
 * since (another chat's draft, a queued message), so the spot no longer exists.
 */
export interface RefCapture { insert: (refs: Ref[]) => boolean; dispose: () => void }

export interface PromptEditorHandle {
  focus: () => void
  /** The selection as string offsets. */
  selection: () => { from: number; to: number }
  /** Make the text `next` by editing only what differs (undoable), and select `caret` to `end` (a caret when equal). */
  setText: (next: string, caret?: number, end?: number) => void
  capture: () => RefCapture
  /** Take every chip for this upload out of the text. Not undoable: its file goes too. */
  removeRefs: (id: string) => void
  /** Return or Tab in a list or a code block, done as formatting does it; true when used. */
  formatKey: (e: KeyboardEvent) => boolean
}

export interface PromptEditorProps {
  value: string
  onChange: (value: string) => void
  lookup: (id: string) => ChipInfo | undefined
  known: Set<string>
  placeholder?: string
  label: string
  enterKeyHint?: 'enter' | 'send'
  onCaret?: (offset: number) => void
  /** Called once the editor exists (it replaces the plain box shown while it loads). */
  onReady?: () => void
  /** Chips he deleted or brought back (Backspace, undo), never an outside change of `value`. */
  onRefsEdited?: (change: { removed: string[]; added: string[] }) => void
  /** True when the key was handled (sent, moved in a menu). */
  onKeyDown?: (e: KeyboardEvent) => boolean
  /** True when the paste was taken as files or a long text. */
  onPaste?: (e: ClipboardEvent) => boolean
  autoFocus?: boolean
  /** Format lists and code fences as they are typed (Settings → Chat). */
  markdown?: boolean
}

const Lookup = createContext<(id: string) => ChipInfo | undefined>(() => undefined)

function ChipView({ node }: ReactNodeViewProps) {
  const lookup = useContext(Lookup)
  return <NodeViewWrapper as="span" className="vc-ref-node"><RefChip info={lookup(node.attrs.id)} label={node.attrs.label} /></NodeViewWrapper>
}
const chipView = ReactNodeViewRenderer(ChipView, { as: 'span' })

const INSERT_ORDER = 'refInsertOrder'
let nextOrder = 0

/** A fresh state for an outside value: history starts over, the selection goes to `kept` (string offsets) or the end. */
function reset(editor: Editor, value: string, kept: { anchor: number; head: number } | null = null) {
  const doc = valueToDoc(editor.schema, value)
  const selection = kept == null ? TextSelection.atEnd(doc) : TextSelection.create(doc, offsetToPos(doc, kept.anchor), offsetToPos(doc, kept.head))
  editor.view.updateState(EditorState.create({ doc, plugins: editor.state.plugins, selection }))
}

const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditor(props, ref) {
  const latest = useRef(props)
  latest.current = props
  const emitted = useRef(props.value)
  const refIds = useRef(new Set<string>())
  // Bumped whenever an outside value replaces the text, which strands any capture taken before.
  const resets = useRef(0)
  // TipTap may replace its editor instance after mounting (useEditor's own lifecycle):
  // the new one carries on from the old one's selection and focus.
  const kept = useRef<{ selection: { anchor: number; head: number } | null; focused: boolean }>({ selection: null, focused: false })

  // Built once per formatting setting: TipTap compares options by identity on every
  // render and would otherwise rebuild its state on each keystroke. Everything reads `latest`.
  const options = useMemo<UseEditorOptions>(() => ({
    extensions: createComposerExtensions({ known: () => latest.current.known, chipView, markdown: props.markdown }),
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: 'vc-ed',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': props.label,
        ...(props.enterKeyHint ? { enterkeyhint: props.enterKeyHint } : {}),
      },
      // Return that commits an IME candidate never sends, even where ProseMirror
      // saw no composition (Safari sends keyCode 229 after compositionend).
      handleKeyDown: (view, e) => !view.composing && !e.isComposing && e.keyCode !== 229 && !!latest.current.onKeyDown?.(e),
      handlePaste: (view, e) => {
        if (latest.current.onPaste?.(e)) return true
        // Text from anywhere but this editor goes in as its plain text, so every line
        // and blank line stays (a mail's or an editor's HTML would fold them); with
        // formatting on it is read as Markdown where it lands. This editor's own copies,
        // a ProseMirror slice with chips in it, keep their chips; other ProseMirror apps
        // (Linear, Confluence) mark their slices the same way.
        const text = e.clipboardData?.getData('text/plain')
        const html = e.clipboardData?.getData('text/html') || ''
        if (!text || (html.includes('data-pm-slice') && html.includes('data-ref-id'))) return false
        const clean = text.replace(/\r\n?/g, '\n')
        if (formats(view.state.schema)) {
          const { doc, selection } = view.state
          const value = docToValue(doc)
          const { start, end } = selectionRange(doc, selection.from, selection.to)
          applyValue(view, value.slice(0, start) + clean + value.slice(end), start + clean.length)
        } else view.dispatch(view.state.tr.replaceSelection(valueToSlice(view.state.schema, clean)).scrollIntoView().setMeta('uiEvent', 'paste'))
        return true
      },
      // Files dropped on the box go to the chat's own drop, which attaches them.
      handleDrop: (_view, e) => !!(e as DragEvent).dataTransfer?.files?.length,
      // Copied or cut, a selection is its Markdown (markers, fences), with each chip as its file's name.
      clipboardTextSerializer: (_slice, view) => {
        const { doc, selection } = view.state
        const { start, end } = selectionRange(doc, selection.from, selection.to)
        return plainRefs(docToValue(doc).slice(start, end))
      },
      handleDOMEvents: {
        // A cut takes out exactly the Markdown it copied, markers and fences included.
        cut: (view, e) => {
          const { doc, selection } = view.state
          if (selection.empty || !e.clipboardData) return false
          const { dom, text } = view.serializeForClipboard(selection.content())
          e.preventDefault()
          e.clipboardData.clearData()
          e.clipboardData.setData('text/html', dom.innerHTML)
          e.clipboardData.setData('text/plain', text)
          const value = docToValue(doc)
          const { start, end } = selectionRange(doc, selection.from, selection.to)
          applyValue(view, value.slice(0, start) + value.slice(end), start)
          return true
        },
      },
      // Plain text (and ⌘/Ctrl+Shift+V) keeps its lines, and a copied reference becomes a chip again.
      clipboardTextParser: (text, _$context, _plain, view) => valueToSlice(view.state.schema, text.replace(/\r\n?/g, '\n')),
    },
    // Every instance starts with the text, not just once its `create` (a timeout later)
    // has run: a call through the handle may reach it before then.
    onBeforeCreate: ({ editor }) => { editor.options.content = valueToDoc(editor.schema, emitted.current).toJSON() },
    onCreate: ({ editor }) => {
      reset(editor, emitted.current, kept.current.selection)
      refIds.current = docRefIds(editor.state.doc)
      if (kept.current.focused) editor.view.focus()
      latest.current.onReady?.()
    },
    onFocus: () => { kept.current.focused = true },
    // A blur from its own teardown is not him leaving.
    onBlur: ({ editor }) => { if (!editor.isDestroyed && editor.view.dom.isConnected) kept.current.focused = false },
    onUpdate: ({ editor }) => {
      const value = docToValue(editor.state.doc)
      emitted.current = value
      const ids = docRefIds(editor.state.doc)
      const removed = [...refIds.current].filter((id) => !ids.has(id))
      const added = [...ids].filter((id) => !refIds.current.has(id))
      refIds.current = ids
      if (removed.length || added.length) latest.current.onRefsEdited?.({ removed, added })
      latest.current.onChange(value)
    },
    onSelectionUpdate: ({ editor }) => {
      const { doc, selection } = editor.state
      kept.current.selection = { anchor: posToOffset(doc, selection.anchor), head: posToOffset(doc, selection.head) }
      latest.current.onCaret?.(kept.current.selection.head)
    },
  }), [props.markdown])
  const editor = useEditor(options, [options])

  // A value set from outside (sent, put back, a draft switched in) replaces the text.
  useEffect(() => {
    if (!editor || props.value === emitted.current) return
    emitted.current = props.value
    resets.current += 1
    reset(editor, props.value)
    refIds.current = docRefIds(editor.state.doc)
    latest.current.onCaret?.(props.value.length)
  }, [editor, props.value])

  useEffect(() => { if (editor) refreshMentions(editor.view) }, [editor, props.known])
  // Never from another field he is typing in, nor while hidden behind the composer's
  // plain box (which hands over its own caret), nor over a caret already placed.
  useEffect(() => {
    if (!editor || !props.autoFocus || editor.view.hasFocus() || !editor.view.dom.getClientRects().length) return
    const active = document.activeElement
    const home = editor.view.dom.closest('.vc-composer, .vc-edit')
    if (active && active !== document.body && !home?.contains(active)) return
    editor.commands.focus('end')
  }, [editor, props.autoFocus])

  useImperativeHandle(ref, () => ({
    focus: () => { editor?.commands.focus() },
    selection: () => {
      if (!editor) return { from: emitted.current.length, to: emitted.current.length }
      const { doc, selection } = editor.state
      return { from: posToOffset(doc, selection.from), to: posToOffset(doc, selection.to) }
    },
    setText: (next, caret = next.length, end = caret) => {
      if (!editor) return
      applyValue(editor.view, next, caret, end)
      // At once, not on the next frame, so a key pressed as the plain box hands over lands here.
      editor.view.focus()
    },
    capture: () => {
      if (!editor) return { insert: () => false, dispose: () => {} }
      const order = nextOrder++
      const resetAt = resets.current
      let { from, to } = editor.state.selection
      let lost = false
      const track = ({ transaction: tr }: { transaction: Transaction }) => {
        if (!tr.docChanged) return
        // Text typed at the spot stays after the chips; an earlier capture's chips stay before them.
        const earlier = tr.getMeta(INSERT_ORDER)
        const assoc = earlier !== undefined && earlier < order ? 1 : -1
        const a = tr.mapping.mapResult(from, assoc)
        const b = tr.mapping.mapResult(to, assoc)
        lost ||= a.deletedAcross || b.deletedAcross
        from = a.pos
        to = Math.max(a.pos, b.pos)
      }
      editor.on('transaction', track)
      const dispose = () => { editor.off('transaction', track) }
      return {
        dispose,
        insert: (refs) => {
          dispose()
          if (editor.isDestroyed || !refs.length || resets.current !== resetAt) return false
          const { state, schema } = editor
          // The text around the spot was edited away: the chips go where the caret is now.
          const at = lost ? { from: state.selection.from, to: state.selection.to } : { from, to }
          const before = state.doc.resolve(at.from).nodeBefore
          const after = state.doc.resolve(at.to).nodeAfter
          const nodes = refs.flatMap((r) => [schema.nodes[REF_NODE].create(r), schema.text(' ')])
          if (before && !(before.isText && /\s$/.test(before.text || ''))) nodes.unshift(schema.text(' '))
          if (after?.isText && /^\s/.test(after.text || '')) nodes.pop()
          dispatchAlone(editor.view, state.tr.replaceWith(at.from, at.to, nodes).setMeta(INSERT_ORDER, order))
          return true
        },
      }
    },
    removeRefs: (id) => {
      if (!editor) return
      const tr = editor.state.tr
      const spots: number[] = []
      tr.doc.descendants((n, pos) => { if (n.type.name === REF_NODE && n.attrs.id === id) spots.push(pos) })
      for (const pos of spots.reverse()) {
        const next = tr.doc.resolve(pos + 1).nodeAfter
        tr.delete(pos, pos + 1 + (next?.isText && next.text?.startsWith(' ') ? 1 : 0))
      }
      if (spots.length) editor.view.dispatch(tr.setMeta('addToHistory', false))
    },
    formatKey: (e) => !!editor && formatKey(editor, e),
  }), [editor])

  return (
    <Lookup.Provider value={props.lookup}>
      <div className="vc-ed-wrap">
        {!props.value && props.placeholder && <div className="vc-ed-placeholder" aria-hidden>{props.placeholder}</div>}
        <EditorContent editor={editor} />
      </div>
    </Lookup.Provider>
  )
})

export default PromptEditor
