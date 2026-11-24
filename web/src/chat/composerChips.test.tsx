import React, { createRef, useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import type { Attachment } from './types'
import type { ComposerHandle, ComposerProps } from './Composer'
import { setChatCommands } from '../studio'

// The composer's inline attachment chips (#295) and the behaviour the editor
// took over from the textarea.

type Upload = { file: File; name: string; kind?: string; resolve: () => void; reject: (e: Error) => void }
const uploads: Upload[] = []
let nextId = 0
const deleted: string[] = []
const errors: string[] = []

vi.mock('../toast', async (orig) => ({ ...(await orig<typeof import('../toast')>()), pushError: (m: string) => { errors.push(m) } }))

vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  uploadFile: (file: File, name: string, opts: { kind?: string }) => new Promise<Attachment>((res, rej) => {
    const id = `upload${String(++nextId).padStart(4, '0')}`
    const kind = opts?.kind === 'text' ? 'text' : file.type.startsWith('image/') ? 'image' : 'file'
    uploads.push({ file, name, kind, resolve: () => res({ id, name, mime: file.type, size: file.size, kind, url: `/u/${id}` }), reject: rej })
  }),
  deleteUpload: (id: string) => { deleted.push(id) },
}))

const { default: Composer } = await import('./Composer')

beforeEach(() => {
  nextId = 0
  uploads.length = 0
  deleted.length = 0
  errors.length = 0
  URL.createObjectURL = () => 'blob:preview'
  URL.revokeObjectURL = () => {}
  // jsdom has none; ProseMirror's pasteText makes one.
  vi.stubGlobal('ClipboardEvent', class extends Event { clipboardData = null })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

let value = ''
let setOutside: (v: string) => void = () => {}
function Harness(props: Partial<ComposerProps> & { handle?: React.Ref<ComposerHandle> }) {
  const [v, setV] = useState('')
  value = v
  setOutside = setV
  return <Composer ref={props.handle} value={v} onChange={setV} onSend={() => {}} onStop={() => {}} busy={false} {...props} />
}

async function editor() {
  const box = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.vc-ed[contenteditable]')
    if (!el) throw new Error('the editor is still loading')
    return el
  })
  return (box as unknown as { editor: Editor }).editor
}
const type = (ed: Editor, text: string) => act(() => { ed.commands.insertContent(text) })
const key = (ed: Editor, init: KeyboardEventInit) => act(() => { fireEvent.keyDown(ed.view.dom, init) })

function paste(ed: Editor, { files = [], text = '', html = '' }: { files?: File[]; text?: string; html?: string }) {
  const e = new Event('paste', { bubbles: true, cancelable: true })
  const types = [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : []), ...(html ? ['text/html'] : [])]
  Object.defineProperty(e, 'clipboardData', { value: { files, types, getData: (t: string) => (t === 'text/plain' ? text : t === 'text/html' ? html : '') } })
  act(() => { ed.view.dom.dispatchEvent(e) })
  return e
}
const finish = async (i: number) => { await act(async () => { uploads[i].resolve() }) }
const png = (name: string, bytes = 852_992) => new File([new Uint8Array(bytes)], name, { type: 'image/png' })
const pdf = (name = 'notes.pdf') => new File([new Uint8Array(2048)], name, { type: 'application/pdf' })
const chips = () => Array.from(document.querySelectorAll('.vc-ed .vc-ref')).map((c) => c.textContent)
const tiles = () => document.querySelectorAll('.vc-tray > *').length
/** The document position just after the n-th chip. */
function afterChip(ed: Editor, n = 0) {
  let found = -1
  let seen = 0
  ed.state.doc.descendants((node, pos) => { if (node.type.name === 'ref' && seen++ === n) found = pos + 1 })
  return found
}

describe('pasting and attaching', () => {
  it('puts two pasted images at the caret, as two tray tiles and two chips with their sizes, in paste order', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, 'like if i paste this image ')
    expect(paste(ed, { files: [png('a.png'), png('b.png', 370_000)] }).defaultPrevented).toBe(true)
    expect(tiles()).toBe(2)
    // The second finishes first; each still lands in the order it was pasted.
    await finish(1)
    await finish(0)
    expect(value).toBe('like if i paste this image ![a.png](totem-ref://upload/upload0001) ![b.png](totem-ref://upload/upload0002) ')
    expect(chips()).toEqual(['a.png833 KB', 'b.png362 KB'])
    expect(document.querySelectorAll('.vc-ed .vc-ref.image img.vc-ref-thumb')).toHaveLength(2)
  })

  it('keeps an image in an empty box to the tray, and gives a file a chip anyway', async () => {
    render(<Harness />)
    const ed = await editor()
    paste(ed, { files: [png('shot.png')] })
    await finish(0)
    expect(value).toBe('')
    expect(tiles()).toBe(1)
    paste(ed, { files: [pdf()] })
    await finish(1)
    expect(value).toBe('[notes.pdf](totem-ref://upload/upload0002) ')
    expect(chips()).toEqual(['notes.pdf2 KB'])
  })

  it('makes a long paste a pasted-text chip', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, 'read this: ')
    paste(ed, { text: Array.from({ length: 31 }, (_, i) => `line ${i}`).join('\n') })
    expect(uploads[0].kind).toBe('text')
    await finish(0)
    expect(value).toMatch(/^read this: \[Pasted text \d+\.txt\]\(totem-ref:\/\/upload\/upload0001\) $/)
    expect(document.querySelector('.vc-ed .vc-ref.text')).not.toBeNull()
  })

  it('puts the chip at the caret when the text around the paste spot was edited away', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, 'abc def')
    act(() => { ed.commands.setTextSelection(4) })
    paste(ed, { files: [pdf()] })
    act(() => { ed.commands.selectAll(); ed.commands.insertContent('new') })
    await finish(0)
    expect(value).toBe('new [notes.pdf](totem-ref://upload/upload0001) ')
  })

  it('adds a space before the chip when the caret sits against a word', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, 'see')
    paste(ed, { files: [pdf()] })
    await finish(0)
    expect(value).toBe('see [notes.pdf](totem-ref://upload/upload0001) ')
  })

  it('drops a failed upload\'s place without inserting anything', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, 'see ')
    paste(ed, { files: [pdf()] })
    await act(async () => { uploads[0].reject(new Error('nope')) })
    expect(value).toBe('see ')
  })

  it('puts an attachment handed in (Search\'s "Add to chat") in the tray only', async () => {
    const handle = createRef<ComposerHandle>()
    render(<Harness handle={handle} />)
    await editor()
    act(() => handle.current!.addAttachment({ id: 'ctxupload1', name: 'result.md', mime: 'text/markdown', size: 10, kind: 'text' }))
    expect(tiles()).toBe(1)
    expect(value).toBe('')
  })

  it('pastes plain text as lines, and a copied reference comes back as a chip', async () => {
    render(<Harness />)
    const ed = await editor()
    await act(async () => { ed.view.pasteText('one\ntwo [notes.pdf](totem-ref://upload/abcdefgh12)') })
    expect(value).toBe('one\ntwo [notes.pdf](totem-ref://upload/abcdefgh12)')
    expect(ed.state.doc.childCount).toBe(2)
    expect(document.querySelectorAll('.vc-ed .vc-ref.gone')).toHaveLength(1)
  })
})

describe('keeping the tray and the text together', () => {
  it('deletes a chip as one unit, takes its file out of the tray, and undo brings both back', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, 'see ')
    paste(ed, { files: [pdf()] })
    await finish(0)
    act(() => { ed.commands.setTextSelection(afterChip(ed)) })
    key(ed, { key: 'Backspace' })
    expect(value).toBe('see  ')
    expect(tiles()).toBe(0)
    act(() => { ed.commands.undo() })
    expect(value).toBe('see [notes.pdf](totem-ref://upload/upload0001) ')
    expect(tiles()).toBe(1)
    // Deleted again and sent: it can no longer come back, so it goes, and it is not sent.
    act(() => { ed.commands.setTextSelection(afterChip(ed)) })
    key(ed, { key: 'Backspace' })
    expect(deleted).toEqual([])
    key(ed, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith({ text: 'see', attachments: [] })
    expect(deleted).toEqual(['upload0001'])
  })

  it('leaves a file whose chip was deleted out of the draft until undo brings it back', async () => {
    const onAttachmentsChange = vi.fn()
    render(<Harness onAttachmentsChange={onAttachmentsChange} />)
    const ed = await editor()
    type(ed, 'see ')
    paste(ed, { files: [pdf()] })
    await finish(0)
    const last = () => onAttachmentsChange.mock.calls[onAttachmentsChange.mock.calls.length - 1].map((x: unknown) => (Array.isArray(x) ? x.map((a: Attachment) => a.id) : x))
    expect(last()).toEqual([['upload0001'], 0])
    act(() => { ed.commands.setTextSelection(afterChip(ed)) })
    key(ed, { key: 'Backspace' })
    expect(last()).toEqual([[], 0])
    act(() => { ed.commands.undo() })
    expect(last()).toEqual([['upload0001'], 0])
  })

  it('leaves an image in the tray when its chip is deleted', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, 'look ')
    paste(ed, { files: [png('a.png')] })
    await finish(0)
    act(() => { ed.commands.setTextSelection(afterChip(ed)) })
    key(ed, { key: 'Backspace' })
    expect(chips()).toEqual([])
    expect(tiles()).toBe(1)
  })

  it('asks before × removes a file the text refers to, then takes every reference with it', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, 'a ')
    paste(ed, { files: [png('a.png')] })
    await finish(0)
    act(() => { ed.commands.insertContent('and again ') })
    await act(async () => { ed.view.pasteText('![a.png](totem-ref://upload/upload0001) end') })
    expect(chips()).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }))
    const ask = screen.getByRole('alertdialog')
    expect(ask.textContent).toBe('a.png (833 KB) is referenced in your message; removing it removes every reference.KeepRemove')
    // The tile and both of its chips in the text are marked, so two same-named files are told apart.
    expect(document.querySelectorAll('.vc-tray .asking')).toHaveLength(1)
    expect(document.querySelectorAll('.vc-ed .vc-ref.asking')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(tiles()).toBe(1)
    expect(chips()).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(tiles()).toBe(0)
    expect(value).toBe('a and again end')
    expect(deleted).toEqual(['upload0001'])
  })

  it('removes an item the text does not name at once', async () => {
    render(<Harness />)
    const ed = await editor()
    paste(ed, { files: [png('a.png')] })
    await finish(0)
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(tiles()).toBe(0)
  })
})

describe('what the textarea did, the editor still does', () => {
  it('sends on Return with the chips in the text and their files attached', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, 'compare ')
    paste(ed, { files: [pdf()] })
    await finish(0)
    key(ed, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0].text).toBe('compare [notes.pdf](totem-ref://upload/upload0001)')
    expect(onSend.mock.calls[0][0].attachments.map((a: Attachment) => a.id)).toEqual(['upload0001'])
  })

  it('makes Shift+Return a new line, and never sends from Return mid-composition', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, 'にほん')
    act(() => { fireEvent.compositionStart(ed.view.dom) })
    key(ed, { key: 'Enter', isComposing: true, keyCode: 229 })
    act(() => { fireEvent.compositionEnd(ed.view.dom) })
    expect(onSend).not.toHaveBeenCalled()
    expect(value).toBe('にほん')
    key(ed, { key: 'Enter', shiftKey: true })
    type(ed, 'two')
    expect(value).toBe('にほん\ntwo')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('makes Return a new line on a phone', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse'), addEventListener() {}, removeEventListener() {} }))
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, 'one')
    key(ed, { key: 'Enter' })
    type(ed, 'two')
    expect(value).toBe('one\ntwo')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('queues on Return and steers on Ctrl+Return while a reply runs', async () => {
    const onQueue = vi.fn(() => true)
    const onSteer = vi.fn(() => true)
    render(<Harness busy onQueue={onQueue} onSteer={onSteer} />)
    const ed = await editor()
    type(ed, 'first')
    key(ed, { key: 'Enter' })
    await act(async () => {})
    expect(onQueue).toHaveBeenCalledWith({ text: 'first', attachments: [] })
    type(ed, 'second')
    key(ed, { key: 'Enter', ctrlKey: true })
    await act(async () => {})
    expect(onSteer).toHaveBeenCalledWith({ text: 'second', attachments: [] })
  })

  it('puts the words, the chips and the files back when a follow-up could not be sent', async () => {
    const onQueue = vi.fn(() => false)
    render(<Harness busy onQueue={onQueue} />)
    const ed = await editor()
    type(ed, 'see ')
    paste(ed, { files: [pdf()] })
    await finish(0)
    key(ed, { key: 'Enter' })
    await act(async () => {})
    expect(onQueue).toHaveBeenCalledTimes(1)
    expect(value).toBe('see [notes.pdf](totem-ref://upload/upload0001)')
    expect(chips()).toEqual(['notes.pdf2 KB'])
    expect(tiles()).toBe(1)
  })

  it('opens the skills menu at the caret mid-sentence, tints the cited skill, and Return picks it', async () => {
    setChatCommands([{ command: '/find-thread', name: 'Find thread', description: 'Find a thread', body: '', enabled: true }])
    render(<Harness />)
    const ed = await editor()
    type(ed, 'use /fi')
    let scrolled = false
    ed.on('transaction', ({ transaction }) => { if (transaction.docChanged) scrolled = transaction.scrolledIntoView })
    expect(screen.getAllByRole('option')[0].textContent).toContain('/find-thread')
    key(ed, { key: 'Enter' })
    expect(value).toBe('use /find-thread ')
    expect(document.querySelector('.vc-ed .vc-mention')?.textContent).toBe('/find-thread')
    // The pick scrolls the caret into view, for a long draft.
    expect(scrolled).toBe(true)
    setChatCommands([])
  })
})

describe('rich text pasted from elsewhere', () => {
  const shapes: [string, string, string][] = [
    ['paragraphs and a blank line (a mail)', '<p>Hi Sam,</p><p><br></p><p>The quote is attached.</p>', 'Hi Sam,\n\nThe quote is attached.'],
    ['line breaks', '<div>one<br>two<br><br>four</div>', 'one\ntwo\n\nfour'],
    ['a code block (an editor)', '<pre><code>const x = 1\n\n  return x</code></pre>', 'const x = 1\n\n  return x'],
  ]
  for (const [what, html, text] of shapes) {
    it(`keeps every line of ${what}`, async () => {
      render(<Harness />)
      const ed = await editor()
      expect(paste(ed, { html, text }).defaultPrevented).toBe(true)
      expect(value).toBe(text)
    })
  }

  it('keeps the numbers of a list copied from another ProseMirror app', async () => {
    render(<Harness />)
    const ed = await editor()
    paste(ed, { html: '<ol data-pm-slice="1 1 []"><li><p>build</p></li><li><p>test</p></li></ol>', text: '1. build\n2. test' })
    expect(value).toBe('1. build\n2. test')
  })

  it('keeps the chips in a copy from this editor', async () => {
    render(<Harness />)
    const ed = await editor()
    const html = '<p data-pm-slice="1 1 []">see <span data-ref-id="abcdefgh12" data-ref-label="notes.pdf" data-ref-image="false">notes.pdf</span></p>'
    await act(async () => { paste(ed, { html, text: 'see notes.pdf' }) })
    expect(value).toBe('see [notes.pdf](totem-ref://upload/abcdefgh12)')
  })

  it('copies lines out one newline apart, chips as their names', async () => {
    render(<Harness />)
    const ed = await editor()
    await act(async () => { ed.view.pasteText('one [notes.pdf](totem-ref://upload/abcdefgh12)\ntwo') })
    act(() => { ed.commands.selectAll() })
    const copied = ed.view.someProp('clipboardTextSerializer', (f) => f(ed.state.selection.content(), ed.view))
    expect(copied).toBe('one notes.pdf\ntwo')
  })
})

describe('an upload that finishes after its place is gone', () => {
  it('stays out of another chat\'s shorter draft, and the file stays in the tray', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, 'a long draft in this chat with the caret at its end ')
    paste(ed, { files: [pdf()] })
    act(() => setOutside('hi'))
    await finish(0)
    expect(value).toBe('hi')
    expect(errors).toEqual([])
    expect(tiles()).toBe(1)
    key(ed, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith({ text: 'hi', attachments: [expect.objectContaining({ id: 'upload0001' })] })
  })

  it('stays out of another chat\'s longer draft', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, 'see ')
    paste(ed, { files: [pdf()] })
    act(() => setOutside('the other chat has a longer draft than this one'))
    await finish(0)
    expect(value).toBe('the other chat has a longer draft than this one')
    expect(tiles()).toBe(1)
  })

  it('is deleted when a queued edit took the tray while it uploaded', async () => {
    const handle = createRef<ComposerHandle>()
    render(<Harness handle={handle} />)
    const ed = await editor()
    type(ed, 'see ')
    paste(ed, { files: [pdf()] })
    act(() => { handle.current!.takeAttachments(); setOutside('the queued message'); handle.current!.setAttachments([]) })
    await finish(0)
    expect(value).toBe('the queued message')
    expect(tiles()).toBe(0)
    expect(deleted).toEqual(['upload0001'])
  })

  it('is deleted, with no chip, when its × was pressed while it uploaded', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, 'see ')
    paste(ed, { files: [pdf()] })
    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.pdf' }))
    await finish(0)
    expect(value).toBe('see ')
    expect(tiles()).toBe(0)
    expect(deleted).toEqual(['upload0001'])
  })
})

describe('undo and the keyboard around chips', () => {
  it('undoes typing next to a new chip without taking the chip', async () => {
    render(<Harness />)
    const ed = await editor()
    type(ed, 'see ')
    paste(ed, { files: [pdf()] })
    await finish(0)
    type(ed, 'more')
    act(() => { ed.commands.undo() })
    expect(value).toBe('see [notes.pdf](totem-ref://upload/upload0001) ')
    expect(tiles()).toBe(1)
  })

  it('never sends from the Return that commits an IME word after compositionend (Safari)', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const ed = await editor()
    type(ed, 'にほん')
    key(ed, { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
  })
})
