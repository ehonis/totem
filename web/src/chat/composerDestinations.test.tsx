import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import type { Project } from './types'
import type { Destination } from './destinations'

// The composer's `$` menu in a chat not started yet: folders and tasks first, and
// picking one takes the `$…` out of the words and hands them to the chat view.

const projects = [
  { id: 'lp', name: 'Work - Acme', instructions: '', createdAt: 0, updatedAt: 2 },
  { id: 'harbor', name: 'harbor', parentId: 'lp', instructions: '', createdAt: 0, updatedAt: 1 },
] as Project[]
const work = {
  tasks: [{ ref: 't1', kind: 'local', title: 'Harbor site map fix', dueDate: null, priority: 1, done: false, status: '', updatedAt: 0 }],
  folders: {}, sheetName: '', loaded: true, error: '',
}

vi.mock('./store', async (orig) => ({ ...(await orig<typeof import('./store')>()), useChat: (sel: (s: { projects: Project[] }) => unknown) => sel({ projects }) }))
// An upload that never finishes, for the test that a pick waits for it.
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), uploadFile: () => new Promise(() => {}) }))
vi.mock('../work/state', async (orig) => ({ ...(await orig<typeof import('../work/state')>()), getWork: () => work, subscribeWork: () => () => {} }))

const { default: Composer } = await import('./Composer')

afterEach(cleanup)

function Harness({ onPick, destinations = true }: { onPick: (d: Destination, text: string) => void; destinations?: boolean }) {
  const [value, setValue] = useState('')
  return (
    <Composer value={value} onChange={setValue} onSend={() => {}} onStop={() => {}} busy={false}
      destinations={destinations ? { projectId: null, taskId: null, onPick: (d, text) => onPick(d, text) } : undefined} />
  )
}

const type = async (text: string) => {
  const box = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('.vc-ed[contenteditable]')
    if (!el) throw new Error('the editor is still loading')
    return el
  })
  act(() => { (box as unknown as { editor: Editor }).editor.commands.insertContent(text) })
  return box
}

describe('composer $ destinations', () => {
  it('lists the folder and the task for "$harb", and Enter picks the folder with the token taken out', async () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    const box = await type('fix the map $harb')
    const options = screen.getAllByRole('option').map((o) => o.textContent)
    expect(options[0]).toContain('harbor')
    expect(options[0]).toContain('Folder in Work - Acme')
    expect(options[1]).toContain('Harbor site map fix')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toMatchObject({ kind: 'project', name: 'harbor' })
    expect(onPick.mock.calls[0][1]).toBe('fix the map')
  })

  it('picks a task with a click', async () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    await type('$site')
    fireEvent.mouseDown(screen.getByRole('option', { name: /Harbor site map fix/ }))
    expect(onPick.mock.calls[0][0]).toMatchObject({ kind: 'task', task: { ref: 't1' } })
    expect(onPick.mock.calls[0][1]).toBe('')
  })

  it('waits for a file still uploading, since only finished files can move with the chat', async () => {
    const onPick = vi.fn()
    const { container } = render(<Harness onPick={onPick} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } })
    const box = await type('$harb')
    expect(screen.getAllByRole('option')[0].textContent).toContain('Waiting for uploads')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('leaves a price alone, so Enter sends it', async () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    const box = await type('it costs $4')
    expect(screen.queryAllByRole('option').filter((o) => /Task|Folder|Project/.test(o.textContent || ''))).toHaveLength(0)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('offers nothing of the kind in a chat already started', async () => {
    render(<Harness onPick={vi.fn()} destinations={false} />)
    await type('$harb')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })
})
