import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'

// Before the editor's chunk arrives (a cold load, a slow link on the phone) the
// composer is a plain textarea on the same value, so nothing typed is lost, and
// the editor carries on from its caret.

const chunk = vi.hoisted(() => {
  let release = () => {}
  const arrived = new Promise<void>((resolve) => { release = resolve })
  return { arrived, release: () => release() }
})
vi.mock('./editor/PromptEditor', async (orig) => {
  await chunk.arrived
  return orig()
})

const { default: Composer } = await import('./Composer')
const { setChatCommands } = await import('../studio')

afterEach(cleanup)

// jsdom lays nothing out; ProseMirror measures when it scrolls the focused caret into view.
for (const proto of [Element.prototype, Text.prototype, Range.prototype] as unknown as Record<string, unknown>[]) {
  proto.getClientRects ??= () => []
  proto.getBoundingClientRect ??= () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
}

let value = ''
function Harness({ initial = '', onSend = () => {} }: { initial?: string; onSend?: (p: { text: string }) => void }) {
  const [v, setV] = useState(initial)
  value = v
  return <Composer value={v} onChange={setV} onSend={onSend} onStop={() => {}} busy={false} />
}

describe('the composer before its editor loads', () => {
  it('shows attached files as their names, keeps them on typing, and never sends from an IME Return', () => {
    const onSend = vi.fn()
    render(<Harness initial="see ![a.png](totem-ref://upload/abcdefgh12) now" onSend={onSend} />)
    const plain = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    expect(plain.value).toBe('see [a.png] now')
    fireEvent.change(plain, { target: { value: 'see [a.png] now please', selectionStart: 22 } })
    expect(value).toBe('see ![a.png](totem-ref://upload/abcdefgh12) now please')
    fireEvent.keyDown(plain, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(plain, { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(plain, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith({ text: 'see ![a.png](totem-ref://upload/abcdefgh12) now please', attachments: [] })
  })

  it('takes a skill picked from the menu', () => {
    setChatCommands([{ command: '/find-thread', name: 'Find thread', description: 'Find a thread', body: '', enabled: true }])
    render(<Harness />)
    const plain = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    plain.focus()
    fireEvent.change(plain, { target: { value: 'use /fi', selectionStart: 7 } })
    expect(screen.getAllByRole('option')[0].textContent).toContain('/find-thread')
    fireEvent.keyDown(plain, { key: 'Enter' })
    expect(value).toBe('use /find-thread ')
    expect(plain.selectionStart).toBe('use /find-thread '.length)
    setChatCommands([])
  })

  it('shows a restored draft and takes typing, then hands the text, caret and focus to the editor', async () => {
    const onSend = vi.fn()
    render(<Harness initial="restored draft" onSend={onSend} />)
    const plain = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    expect(plain.tagName).toBe('TEXTAREA')
    expect(plain.value).toBe('restored draft')
    plain.focus()
    fireEvent.change(plain, { target: { value: 'restored draft, then more', selectionStart: 9 } })
    plain.setSelectionRange(9, 9)
    expect(value).toBe('restored draft, then more')

    await act(async () => { chunk.release(); await chunk.arrived })
    const box = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.vc-ed[contenteditable]')
      if (!el) throw new Error('the editor is still loading')
      return el
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    const editor = (box as unknown as { editor: Editor }).editor
    expect(value).toBe('restored draft, then more')
    expect(editor.state.doc.textContent).toBe('restored draft, then more')
    // The caret is where it was in the plain box (after "restored "), and the editor has focus.
    act(() => { editor.commands.insertContent('X') })
    expect(value).toBe('restored Xdraft, then more')
    await waitFor(() => expect(document.activeElement).toBe(box))
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith({ text: 'restored Xdraft, then more', attachments: [] })
  })
})
