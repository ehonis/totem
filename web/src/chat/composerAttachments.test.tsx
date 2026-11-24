import React, { createRef } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import type { ComposerHandle } from './Composer'

// The composer tells its chat view when the tray's finished uploads change, so
// they are kept with the open draft (drafts.ts), and never just for mounting.

vi.mock('./store', async (orig) => ({ ...(await orig<typeof import('./store')>()), useChat: (sel: (s: { projects: [] }) => unknown) => sel({ projects: [] }) }))
const deleteUpload = vi.fn()
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), deleteUpload, uploadFile: () => new Promise(() => {}) }))

const { default: Composer } = await import('./Composer')
afterEach(cleanup)

const file = (id: string) => ({ id, name: `${id}.pdf`, mime: 'application/pdf', size: 10, kind: 'file' as const })

describe('onAttachmentsChange', () => {
  it('reports the tray as it changes, not on mounting', () => {
    const ref = createRef<ComposerHandle>()
    const onAttachmentsChange = vi.fn()
    render(<Composer ref={ref} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} busy={false} onAttachmentsChange={onAttachmentsChange} />)
    expect(onAttachmentsChange).not.toHaveBeenCalled()
    act(() => ref.current!.setAttachments([file('a'), file('b')]))
    expect(onAttachmentsChange).toHaveBeenLastCalledWith([file('a'), file('b')], 0)
    // Putting the same files back is no change.
    act(() => ref.current!.setAttachments([file('a'), file('b')]))
    expect(onAttachmentsChange).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }))
    expect(onAttachmentsChange).toHaveBeenLastCalledWith([file('b')], 0)
  })

  it('counts an upload still on its way, so the draft can say it stayed behind', () => {
    const onAttachmentsChange = vi.fn()
    const { container } = render(<Composer value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} busy={false} onAttachmentsChange={onAttachmentsChange} />)
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'slow.pdf', { type: 'application/pdf' })] } })
    expect(onAttachmentsChange).toHaveBeenLastCalledWith([], 1)
  })
})

describe('setAttachments', () => {
  it('deletes a removed file only when the draft says it is its own', () => {
    deleteUpload.mockClear()
    const ref = createRef<ComposerHandle>()
    render(<Composer ref={ref} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} busy={false} />)
    act(() => ref.current!.setAttachments([file('mine'), file('shared')], (a) => a.id === 'mine'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove shared.pdf' }))
    expect(deleteUpload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove mine.pdf' }))
    expect(deleteUpload).toHaveBeenCalledWith('mine')
    // A queued message's files are never the composer's to delete.
    act(() => ref.current!.setAttachments([file('queued')]))
    fireEvent.click(screen.getByRole('button', { name: 'Remove queued.pdf' }))
    expect(deleteUpload).toHaveBeenCalledTimes(1)
  })
})
