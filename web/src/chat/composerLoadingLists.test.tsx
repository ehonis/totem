import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { setSetting } from '../settings'

// A list typed into the plain textarea that stands in before the editor's chunk
// arrives (#298): once the editor mounts it is drawn as a list, the message is
// unchanged, and the caret carries on in the same item.

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

afterEach(cleanup)

for (const proto of [Element.prototype, Text.prototype, Range.prototype] as unknown as Record<string, unknown>[]) {
  proto.getClientRects ??= () => []
  proto.getBoundingClientRect ??= () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
}

let value = ''
function Harness() {
  const [v, setV] = useState('')
  value = v
  return <Composer value={v} onChange={setV} onSend={() => {}} onStop={() => {}} busy={false} />
}

describe('a list typed before the editor loads', () => {
  it('is drawn as a list once the editor mounts, and the caret stays in its item', async () => {
    setSetting('formatMarkdown', true)
    render(<Harness />)
    const plain = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    plain.focus()
    fireEvent.change(plain, { target: { value: '1. one\n2. two' } })
    plain.setSelectionRange(11, 11)

    await act(async () => { chunk.release(); await chunk.arrived })
    const box = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.vc-ed[contenteditable]')
      if (!el) throw new Error('the editor is still loading')
      return el
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    const editor = (box as unknown as { editor: Editor }).editor
    expect([...box.querySelectorAll('ol > li')].map((li) => li.getAttribute('data-marker'))).toEqual(['1.', '2.'])
    expect(value).toBe('1. one\n2. two')
    act(() => { editor.commands.insertContent('X') })
    expect(value).toBe('1. one\n2. tXwo')
  })
})
