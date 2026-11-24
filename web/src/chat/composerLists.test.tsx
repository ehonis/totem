import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import type { Attachment } from './types'
import type { ComposerProps } from './Composer'
import { setSetting } from '../settings'
import { setChatCommands } from '../studio'

// Markdown formatted as it is typed in the composer (#298): the key table in
// docs/chat.md → Lists and code in the message box.

vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  uploadFile: (file: File, name: string) => Promise.resolve<Attachment>({ id: 'upload0001', name, mime: file.type, size: file.size, kind: 'file', url: '/u/upload0001' }),
}))

const { default: Composer } = await import('./Composer')

beforeEach(() => {
  setSetting('formatMarkdown', true)
  vi.stubGlobal('ClipboardEvent', class extends Event { clipboardData = null })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

let value = ''
function Harness(props: Partial<ComposerProps>) {
  const [v, setV] = useState('')
  value = v
  return <Composer value={v} onChange={setV} onSend={() => {}} onStop={() => {}} busy={false} {...props} />
}

async function editor() {
  const box = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.vc-ed[contenteditable]')
    if (!el) throw new Error('the editor is still loading')
    return el
  })
  return (box as unknown as { editor: Editor }).editor
}

/** Typed one character at a time, as the browser hands typing to ProseMirror, so input rules see it. */
function type(ed: Editor, text: string) {
  for (const ch of text) {
    act(() => {
      const { view } = ed
      const { from, to } = view.state.selection
      const deflt = () => view.state.tr.insertText(ch, from, to)
      if (!view.someProp('handleTextInput', (f) => f(view, from, to, ch, deflt))) view.dispatch(deflt())
    })
  }
}
const key = (ed: Editor, init: KeyboardEventInit) => {
  let event!: KeyboardEvent
  act(() => {
    event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    ed.view.dom.dispatchEvent(event)
  })
  return event
}
function paste(ed: Editor, { files = [], text = '', html = '' }: { files?: File[]; text?: string; html?: string }) {
  const e = new Event('paste', { bubbles: true, cancelable: true })
  const types = files.length ? ['Files'] : html ? ['text/html', 'text/plain'] : ['text/plain']
  Object.defineProperty(e, 'clipboardData', { value: { files, types, getData: (t: string) => (t === 'text/plain' ? text : t === 'text/html' ? html : '') } })
  act(() => { ed.view.dom.dispatchEvent(e) })
}
const markers = (sel = 'li') => Array.from(document.querySelectorAll(`.vc-ed ${sel}`)).map((li) => (li as HTMLElement).dataset.marker)
/** Where a text node with exactly this text starts. */
function textAt(ed: Editor, text: string) {
  let found = -1
  ed.state.doc.descendants((n, pos) => { if (n.isText && n.text === text) found = pos })
  return found
}
const caretOffset = (ed: Editor) => {
  const { from } = ed.state.selection
  return ed.state.doc.textBetween(0, from, '\n', '\n').length
}

describe('lists in the message box', () => {
  it('turns "1. " into a list that Return continues, Tab nests and Return on an empty item leaves', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, '1. first')
    expect(document.querySelector('.vc-ed ol > li > p')?.textContent).toBe('first')
    key(ed, { key: 'Enter' })
    type(ed, 'second')
    expect(value).toBe('1. first\n2. second')
    expect(markers()).toEqual(['1.', '2.'])
    expect(key(ed, { key: 'Tab' }).defaultPrevented).toBe(true)
    expect(value).toBe('1. first\n   1. second')
    expect(document.querySelectorAll('.vc-ed ol ol > li')).toHaveLength(1)
    key(ed, { key: 'Enter', shiftKey: true })
    type(ed, 'more')
    key(ed, { key: 'Enter' })
    key(ed, { key: 'Enter' })
    key(ed, { key: 'Enter' })
    type(ed, 'after')
    expect(value).toBe('1. first\n   1. second\n      more\nafter')
    expect(onSend).not.toHaveBeenCalled()
    key(ed, { key: 'Enter', ctrlKey: true })
    expect(onSend).toHaveBeenCalledWith({ text: '1. first\n   1. second\n      more\nafter', attachments: [] })
  })

  it('leaves the list from an empty top-level item, and Return then sends as usual', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, '1. a')
    key(ed, { key: 'Enter' })
    type(ed, 'b')
    key(ed, { key: 'Enter' })
    expect(value).toBe('1. a\n2. b\n3. ')
    key(ed, { key: 'Enter' })
    expect(value).toBe('1. a\n2. b\n')
    expect(onSend).not.toHaveBeenCalled()
    type(ed, 'thanks')
    key(ed, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith({ text: '1. a\n2. b\nthanks', attachments: [] })
  })

  it('makes "* " and "+ " bullets at once, and "- " only once the next character shows it is not a task', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '- ')
    expect(document.querySelector('.vc-ed ul')).toBeNull()
    type(ed, 'a')
    expect(document.querySelector('.vc-ed ul > li > p')?.textContent).toBe('a')
    key(ed, { key: 'Enter' })
    key(ed, { key: 'Tab' })
    type(ed, 'b')
    expect(value).toBe('- a\n  - b')
    expect(document.querySelectorAll('.vc-ed ul ul > li')).toHaveLength(1)
    act(() => { ed.commands.setContent('') })
    type(ed, '* x')
    expect(document.querySelector('.vc-ed ul > li')).not.toBeNull()
  })

  it('makes tasks from "- [ ] " and from "[x] " at the start of a bullet, with a checkbox that writes [x]', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '- [ ] buy milk')
    expect(document.querySelector<HTMLInputElement>('.vc-ed ul[data-type="taskList"] li input[type="checkbox"]')!.checked).toBe(false)
    key(ed, { key: 'Enter' })
    type(ed, 'bread')
    expect(value).toBe('- [ ] buy milk\n- [ ] bread')
    act(() => { document.querySelector<HTMLInputElement>('.vc-ed li input[type="checkbox"]')!.click() })
    expect(value).toBe('- [x] buy milk\n- [ ] bread')
    key(ed, { key: 'Enter' })
    key(ed, { key: 'Enter' })
    type(ed, '* ')
    type(ed, '[x] done')
    expect(value).toBe('- [x] buy milk\n- [ ] bread\n* [x] done')
    expect(document.querySelectorAll('.vc-ed ul[data-type="taskList"]')).toHaveLength(2)
  })

  it('puts the typed text back when Backspace comes straight after a rule, and keeps it as text', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '1. ')
    expect(document.querySelector('.vc-ed ol')).not.toBeNull()
    key(ed, { key: 'Backspace' })
    expect(document.querySelector('.vc-ed ol')).toBeNull()
    expect(value).toBe('1. ')
    type(ed, 'not a list')
    expect(document.querySelector('.vc-ed ol')).toBeNull()
    expect(value).toBe('1. not a list')
  })

  it('reads a marker pasted or set from outside, and waits for IME composition to end', async () => {
    render(<Harness />)
    const ed = await editor()
    paste(ed, { text: 'steps:\n1. one\n2. two' })
    expect(value).toBe('steps:\n1. one\n2. two')
    expect(markers()).toEqual(['1.', '2.'])
    act(() => { ed.commands.setContent('') })
    act(() => { fireEvent.compositionStart(ed.view.dom) })
    act(() => { ed.view.dispatch(ed.state.tr.insertText('- かな').setMeta('composition', 1)) })
    expect(document.querySelector('.vc-ed ul')).toBeNull()
    expect(key(ed, { key: 'Enter', isComposing: true, keyCode: 229 }).defaultPrevented).toBe(false)
    expect(value).toBe('- かな')
    act(() => { fireEvent.compositionEnd(ed.view.dom) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.vc-ed ul > li > p')?.textContent).toBe('かな')
    expect(value).toBe('- かな')
  })

  it('never splits a chip: Return after one starts the next item, and a file pasted into an item stays in it', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '1. see ')
    paste(ed, { files: [new File([new Uint8Array(2048)], 'notes.pdf', { type: 'application/pdf' })] })
    await act(async () => {})
    expect(value).toBe('1. see [notes.pdf](totem-ref://upload/upload0001) ')
    expect(document.querySelector('.vc-ed ol > li .vc-ref')).not.toBeNull()
    type(ed, 'now')
    act(() => { ed.commands.setTextSelection(textAt(ed, ' now')) })
    key(ed, { key: 'Enter' })
    expect(value).toBe('1. see [notes.pdf](totem-ref://upload/upload0001)\n2.  now')
    expect(document.querySelectorAll('.vc-ed .vc-ref')).toHaveLength(1)
    key(ed, { key: 'Backspace' })
    expect(value).toBe('1. see [notes.pdf](totem-ref://upload/upload0001)\n now')
    expect(document.querySelector('.vc-ed ol > li .vc-ref')).not.toBeNull()
  })

  it('joins lines with Backspace at the start and Delete at the end of an item', async () => {
    render(<Harness />)
    const ed = await editor()
    paste(ed, { text: '- a\n- b\nlater' })
    act(() => { ed.commands.setTextSelection(textAt(ed, 'a') + 1) })
    key(ed, { key: 'Delete' })
    expect(value).toBe('- ab\nlater')
    act(() => { ed.commands.setTextSelection(textAt(ed, 'later')) })
    key(ed, { key: 'Backspace' })
    expect(value).toBe('- ablater')
    expect(document.querySelectorAll('.vc-ed ul > li')).toHaveLength(1)
  })

  it('leaves Tab alone off a list, and lets the / menu take Return and Tab first', async () => {
    setChatCommands([{ command: '/find-thread', name: 'Find thread', description: 'Find a thread', body: '', enabled: true }])
    render(<Harness />)
    const ed = await editor()
    type(ed, 'plain')
    expect(key(ed, { key: 'Tab' }).defaultPrevented).toBe(false)
    act(() => { ed.commands.setContent('') })
    type(ed, '- use /fi')
    key(ed, { key: 'Tab' })
    expect(value).toBe('- use /find-thread ')
    setChatCommands([])
  })

  it('continues a list with Return on a phone, and sends with ⌘+Return there', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse'), addEventListener() {}, removeEventListener() {} }))
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, '1. a')
    key(ed, { key: 'Enter' })
    expect(value).toBe('1. a\n2. ')
    key(ed, { key: 'Enter', metaKey: true })
    expect(onSend).toHaveBeenCalledWith({ text: '1. a', attachments: [] })
  })
})

describe('code in the message box', () => {
  it('opens a block on Return after a fence, indents with Tab, and leaves after two blank lines', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '```js')
    key(ed, { key: 'Enter' })
    expect(document.querySelector('.vc-ed pre')?.getAttribute('data-language')).toBe('js')
    expect(value).toBe('```js\n\n```')
    type(ed, 'if (x) {')
    key(ed, { key: 'Enter' })
    key(ed, { key: 'Tab' })
    type(ed, 'go()')
    key(ed, { key: 'Enter' })
    type(ed, '1. not a list')
    expect(value).toBe('```js\nif (x) {\n  go()\n  1. not a list\n```')
    expect(document.querySelector('.vc-ed ol')).toBeNull()
    act(() => { ed.commands.setTextSelection(ed.state.doc.content.size - 1) })
    key(ed, { key: 'Enter' })
    key(ed, { key: 'Enter' })
    key(ed, { key: 'Enter' })
    type(ed, 'after')
    expect(value).toBe('```js\nif (x) {\n  go()\n  1. not a list\n```\nafter')
    expect(document.querySelector('.vc-ed pre + p')?.textContent).toBe('after')
  })

  it('ends the block at a closing fence typed in it, and Backspace at its start unwraps it', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, '```')
    key(ed, { key: 'Enter' })
    type(ed, 'code')
    key(ed, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    type(ed, '```')
    key(ed, { key: 'Enter' })
    type(ed, 'prose')
    expect(value).toBe('```\ncode\n```\nprose')
    act(() => { ed.commands.setTextSelection(1) })
    key(ed, { key: 'Backspace' })
    expect(document.querySelector('.vc-ed pre')).toBeNull()
    expect(value).toBe('code\nprose')
  })
})

describe('with formatting off (Settings → Chat)', () => {
  it('redraws the box as plain text when the setting changes, with the message unchanged', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '1. a')
    act(() => { setSetting('formatMarkdown', false) })
    const plain = await editor()
    expect(plain).not.toBe(ed)
    expect(document.querySelector('.vc-ed ol')).toBeNull()
    expect(document.querySelector('.vc-ed p')?.textContent).toBe('1. a')
    expect(value).toBe('1. a')
  })


  it('draws plain text, and still continues and nests lists through the text', async () => {
    setSetting('formatMarkdown', false)
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, '1. a')
    expect(document.querySelector('.vc-ed ol')).toBeNull()
    key(ed, { key: 'Enter' })
    type(ed, 'b')
    key(ed, { key: 'Tab' })
    expect(value).toBe('1. a\n   1. b')
    expect(caretOffset(ed)).toBe(value.length)
    type(ed, '```')
    key(ed, { key: 'Enter' })
    expect(document.querySelector('.vc-ed pre')).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('round 1: copy, sending, selections and the edges', () => {
  /** What a copy or cut of the selection puts on the clipboard: its plain text and ProseMirror's HTML. */
  function copy(ed: Editor) {
    const { dom, text } = ed.view.serializeForClipboard(ed.state.selection.content())
    return { text, html: dom.innerHTML }
  }
  /** A cut, as the browser sends it: what the editor puts on the clipboard, and the box after. */
  function cutOut(ed: Editor) {
    const data = new Map<string, string>()
    const e = new Event('cut', { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'clipboardData', { value: { clearData: () => data.clear(), setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) || '' } })
    act(() => { ed.view.dom.dispatchEvent(e) })
    return { text: data.get('text/plain') || '', html: data.get('text/html') || '' }
  }
  const pdf = () => new File([new Uint8Array(2048)], 'notes.pdf', { type: 'application/pdf' })
  const MESSAGE = 'Plan:\n1. a\n2. b\n   - c\n- [x] d\n```js\nx\n```\nend'

  it('copies the Markdown, and cut then paste puts back the same lines', async () => {
    render(<Harness />)
    const ed = await editor()
    paste(ed, { text: MESSAGE })
    act(() => { ed.commands.selectAll() })
    expect(copy(ed).text).toBe(MESSAGE)
    act(() => { ed.commands.setTextSelection({ from: textAt(ed, 'a'), to: textAt(ed, 'b') + 1 }) })
    const cut = cutOut(ed)
    expect(cut.text).toBe('1. a\n2. b')
    expect(value).toBe('Plan:\n\n   - c\n- [x] d\n```js\nx\n```\nend')
    paste(ed, cut)
    expect(value).toBe(MESSAGE)
    act(() => { ed.commands.setTextSelection({ from: textAt(ed, 'end') + 1, to: textAt(ed, 'end') + 2 }) })
    expect(copy(ed).text).toBe('n')
  })

  it('copies a chip as its name, and pasting the editor\'s own copy back keeps the chip and the list', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '- [ ] see ')
    paste(ed, { files: [pdf()] })
    await act(async () => {})
    act(() => { ed.commands.selectAll() })
    const clip = copy(ed)
    expect(clip.text).toBe('- [ ] see notes.pdf ')
    const before = value
    cutOut(ed)
    expect(value).toBe('')
    paste(ed, clip)
    await act(async () => {})
    expect(value).toBe(before)
    expect(document.querySelector('.vc-ed ul[data-type="taskList"] li .vc-ref')).not.toBeNull()
  })

  it('sends a block closed by a fence typed without Return as it reads, from ⌘+Return or the button', async () => {
    for (const how of ['key', 'button'] as const) {
      const onSend = vi.fn()
      render(<Harness onSend={onSend} />)
      const ed = await editor()
      type(ed, '```')
      key(ed, { key: 'Enter' })
      type(ed, 'code')
      key(ed, { key: 'Enter' })
      type(ed, '```')
      if (how === 'key') key(ed, { key: 'Enter', metaKey: true })
      else act(() => { document.querySelector<HTMLButtonElement>('.vc-send')!.click() })
      expect(onSend).toHaveBeenCalledWith({ text: '```\ncode\n```', attachments: [] })
      cleanup()
    }
  })

  it('ends a block at an indented closing fence', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '```')
    key(ed, { key: 'Enter' })
    type(ed, 'if (x) {')
    key(ed, { key: 'Enter' })
    key(ed, { key: 'Tab' })
    type(ed, '```')
    key(ed, { key: 'Enter' })
    type(ed, 'after')
    expect(value).toBe('```\nif (x) {\n  ```\nafter')
    expect(document.querySelector('.vc-ed pre + p')?.textContent).toBe('after')
  })

  it('takes a selection out before Return splits the item, within an item or across two', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '- abcdef')
    act(() => { ed.commands.setTextSelection({ from: textAt(ed, 'abcdef') + 3, to: textAt(ed, 'abcdef') + 6 }) })
    key(ed, { key: 'Enter' })
    expect(value).toBe('- abc\n- ')
    act(() => { ed.commands.setContent('') })
    paste(ed, { text: '- abc\n- def' })
    act(() => { ed.commands.setTextSelection({ from: textAt(ed, 'abc') + 2, to: textAt(ed, 'def') + 1 }) })
    key(ed, { key: 'Enter' })
    expect(value).toBe('- ab\n- ef')
  })

  it('keeps "- x" as text when Backspace comes straight after its rule', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '- a')
    expect(document.querySelector('.vc-ed ul')).not.toBeNull()
    key(ed, { key: 'Backspace' })
    expect(document.querySelector('.vc-ed ul')).toBeNull()
    expect(value).toBe('- a')
    type(ed, 'b')
    expect(document.querySelector('.vc-ed ul')).toBeNull()
    expect(value).toBe('- ab')
  })

  it('keeps the marker when a space is pasted over an item\'s text', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '- a')
    act(() => { ed.commands.setTextSelection({ from: textAt(ed, 'a'), to: textAt(ed, 'a') + 1 }) })
    paste(ed, { text: ' ' })
    expect(value).toBe('-  ')
  })

  it('moves every selected item with Tab and Shift+Tab, keeping them selected', async () => {
    render(<Harness />)
    const ed = await editor()
    paste(ed, { text: '1. a\n2. b\n3. c' })
    act(() => { ed.commands.setTextSelection({ from: textAt(ed, 'b'), to: textAt(ed, 'c') + 1 }) })
    key(ed, { key: 'Tab' })
    expect(value).toBe('1. a\n   1. b\n   2. c')
    expect(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to, '\n')).toBe('b\nc')
    key(ed, { key: 'Tab', shiftKey: true })
    expect(value).toBe('1. a\n2. b\n3. c')
  })

  it('never makes a chip a code block\'s language', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '```')
    paste(ed, { files: [pdf()] })
    await act(async () => {})
    act(() => { ed.commands.setTextSelection(ed.state.doc.content.size - 1) })
    key(ed, { key: 'Enter', shiftKey: true })
    expect(document.querySelector('.vc-ed pre')).toBeNull()
  })

  it('does not send the empty item Return left at the end of a list', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, '- a')
    key(ed, { key: 'Enter' })
    expect(value).toBe('- a\n- ')
    key(ed, { key: 'Enter', ctrlKey: true })
    expect(onSend).toHaveBeenCalledWith({ text: '- a', attachments: [] })
  })

  it('reads a list again after undo, so a bullet never shows a task\'s box as text', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, '* ')
    type(ed, '[ ] a')
    expect(document.querySelector('.vc-ed ul[data-type="taskList"]')).not.toBeNull()
    act(() => { ed.commands.undo() })
    const bullets = [...document.querySelectorAll('.vc-ed ul:not([data-type]) > li')].map((li) => li.textContent)
    expect(bullets.some((t) => t?.startsWith('[ ]'))).toBe(false)
    expect(value.startsWith('* ')).toBe(true)
  })
})

describe('round 2: what a selection covers', () => {
  function cutOut(ed: Editor) {
    const data = new Map<string, string>()
    const e = new Event('cut', { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'clipboardData', { value: { clearData: () => data.clear(), setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) || '' } })
    act(() => { ed.view.dom.dispatchEvent(e) })
    return data.get('text/plain') || ''
  }

  it('pastes over select-all as typing would, list or code block', async () => {
    for (const draft of ['- a\n- b', '```js\nhello\n```\nafter']) {
      render(<Harness />)
      const ed = await editor()
      paste(ed, { text: draft })
      act(() => { ed.commands.selectAll() })
      paste(ed, { text: 'NEW' })
      expect(value).toBe('NEW')
      cleanup()
    }
  })

  it('sends the whole message on Return over select-all in a list, rather than emptying the box', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    paste(ed, { text: '- a\n- b' })
    act(() => { ed.commands.selectAll() })
    key(ed, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith({ text: '- a\n- b', attachments: [] })
  })

  it('cuts a word or an item\'s whole text without its marker, leaving the item', async () => {
    render(<Harness />)
    const ed = await editor()
    paste(ed, { text: '- alpha beta\n- bc\n- d' })
    act(() => { ed.commands.setTextSelection({ from: textAt(ed, 'alpha beta'), to: textAt(ed, 'alpha beta') + 5 }) })
    expect(cutOut(ed)).toBe('alpha')
    // The space after the cut word stays the item's text, so the box shows what is sent.
    expect(value).toBe('-  beta\n- bc\n- d')
    expect(document.querySelector('.vc-ed ul > li > p')?.textContent).toBe(' beta')
    paste(ed, { text: 'alpha' })
    expect(value).toBe('- alpha beta\n- bc\n- d')
    act(() => { ed.commands.setTextSelection({ from: textAt(ed, 'bc'), to: textAt(ed, 'bc') + 2 }) })
    expect(cutOut(ed)).toBe('bc')
    expect(value).toBe('- alpha beta\n- \n- d')
    expect(document.querySelectorAll('.vc-ed ul > li')).toHaveLength(3)
  })

  it('leaves out a line Shift+Down only reached the start of, when Tab moves the items', async () => {
    render(<Harness />)
    const ed = await editor()
    paste(ed, { text: '- a\n- b\n- c' })
    act(() => { ed.commands.setTextSelection({ from: textAt(ed, 'b'), to: textAt(ed, 'c') }) })
    key(ed, { key: 'Tab' })
    expect(value).toBe('- a\n  - b\n- c')
  })

  it('cuts a code line inside a block without its fences', async () => {
    render(<Harness />)
    const ed = await editor()
    paste(ed, { text: '```js\nx\ny\n```\nafter' })
    act(() => { ed.commands.setTextSelection({ from: textAt(ed, 'x\ny'), to: textAt(ed, 'x\ny') + 1 }) })
    expect(cutOut(ed)).toBe('x')
    expect(value).toBe('```js\n\ny\n```\nafter')
    expect(document.querySelector('.vc-ed pre + p')?.textContent).toBe('after')
  })
})
