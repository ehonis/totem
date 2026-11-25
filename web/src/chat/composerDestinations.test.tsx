import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import type { Project } from './types'
import type { Destination } from './destinations'
import type { NewTaskFields } from './newTask'

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

const providers = [{ id: 'claude', name: 'Claude', driver: 'claude', supportsModelPicker: true }]
const models = { claude: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }] }
vi.mock('./store', async (orig) => ({
  ...(await orig<typeof import('./store')>()),
  useChat: (sel: (s: { projects: Project[]; providers: typeof providers; models: typeof models }) => unknown) => sel({ projects, providers, models }),
  ensureModels: () => {},
}))
// An upload that never finishes, for the test that a pick waits for it.
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), uploadFile: () => new Promise(() => {}) }))
vi.mock('../work/state', async (orig) => ({ ...(await orig<typeof import('../work/state')>()), getWork: () => work, subscribeWork: () => () => {} }))

const { default: Composer } = await import('./Composer')

afterEach(cleanup)

function Harness({ onPick, destinations = true, onNewTask, projectId = null, onSend = () => {}, onModel, onStartOption, valueSpy }: {
  onPick: (d: Destination, text: string) => void; destinations?: boolean
  onNewTask?: (fields: NewTaskFields) => Promise<boolean>; projectId?: string | null; onSend?: () => void
  onModel?: (d: any) => void; onStartOption?: (d: any) => void; valueSpy?: (v: string) => void
}) {
  const [value, setValue] = useState('')
  return (
    <Composer value={value} onChange={(v) => { valueSpy?.(v); setValue(v) }} onSend={onSend} onStop={() => {}} busy={false}
      destinations={destinations ? { projectId, taskId: null, onPick: (d, text) => onPick(d, text), onNewTask, onModel, onStartOption } : undefined} />
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

  it('$ghost makes it a ghost chat, keeping the words', async () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    const box = await type('just between us $gho')
    expect(screen.getAllByRole('option')[0].textContent).toContain('Ghost chat')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onPick.mock.calls[0][0]).toMatchObject({ kind: 'ghost' })
    expect(onPick.mock.calls[0][1]).toBe('just between us')
  })

  it('offers a new folder in the project, and a new project, for a name nothing has, with his capitals', async () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} projectId="harbor" />)
    await type('$NYC-trip')
    const options = screen.getAllByRole('option').map((o) => o.textContent)
    expect(options[0]).toContain('New folder “NYC trip”')
    expect(options[0]).toContain('New folder in Work - Acme')
    expect(options[1]).toContain('New project “NYC trip”')
    fireEvent.mouseDown(screen.getAllByRole('option')[1])
    expect(onPick.mock.calls[0][0]).toMatchObject({ kind: 'new-folder', name: 'NYC trip' })
    expect(onPick.mock.calls[0][0].parent).toBeUndefined()
  })

  it('$opus picks the model and leaves the words in the box', async () => {
    const onPick = vi.fn()
    const onModel = vi.fn()
    const box = await (async () => { render(<Harness onPick={onPick} onModel={onModel} />); return type('plan the week $opus') })()
    expect(screen.getAllByRole('option')[0].textContent).toContain('Claude Opus 5.5')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onModel.mock.calls[0][0]).toMatchObject({ kind: 'model', modelId: 'claude-opus-5-5' })
    expect(onPick).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0))
  })

  it('offers no models where the chat view cannot take one', async () => {
    render(<Harness onPick={vi.fn()} />)
    await type('$opus')
    expect(screen.queryAllByRole('option').map((o) => o.textContent).join()).not.toContain('Opus 5.5')
  })

  it('$pin and $snooze-tom hand the option over', async () => {
    const onStartOption = vi.fn()
    render(<Harness onPick={vi.fn()} onStartOption={onStartOption} />)
    const box = await type('$pin')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onStartOption.mock.calls[0][0]).toMatchObject({ kind: 'pin' })
    cleanup()
    render(<Harness onPick={vi.fn()} onStartOption={onStartOption} />)
    const again = await type('ask about the lease $snooze-tom')
    expect(screen.getAllByRole('option')[0].textContent).toContain('Snooze · Tomorrow')
    fireEvent.keyDown(again, { key: 'Enter' })
    expect(onStartOption.mock.calls[1][0]).toMatchObject({ kind: 'snooze' })
  })

  it('offers nothing of the kind in a chat already started', async () => {
    render(<Harness onPick={vi.fn()} destinations={false} />)
    await type('$harb')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })
})

describe('composer $task', () => {
  it('turns the box into a task line, reads its hints and makes the task on Enter', async () => {
    const onPick = vi.fn()
    const onSend = vi.fn()
    const onNewTask = vi.fn(async () => true)
    render(<Harness onPick={onPick} onSend={onSend} onNewTask={onNewTask} projectId="harbor" />)
    const box = await type('$task')
    expect(screen.getAllByRole('option')[0].textContent).toContain('New task')
    expect(screen.getAllByRole('option')[0].textContent).toContain('filed in harbor')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.getByLabelText('New task')).toBeTruthy()
    // The folder chip says where it goes before anything is typed.
    expect(screen.getByLabelText('New task').textContent).toContain('Work - Acme / harbor')
    await type('Renew passport p1')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByLabelText('New task').textContent).toContain('P1')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(onSend).not.toHaveBeenCalled()
    expect(onNewTask).toHaveBeenCalledWith({ title: 'Renew passport', dueDate: null, priority: 4, folderId: 'harbor' })
    expect(screen.queryByLabelText('New task')).toBeNull()
  })

  it('takes the words already typed as the title, and a #folder over where the chat is', async () => {
    const onNewTask = vi.fn(async () => true)
    render(<Harness onPick={vi.fn()} onNewTask={onNewTask} />)
    const box = await type('Fix the site map #harbor $new')
    fireEvent.keyDown(box, { key: 'Enter' })
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(onNewTask).toHaveBeenCalledWith({ title: 'Fix the site map', dueDate: null, priority: null, folderId: 'harbor' })
  })

  it('keeps the task line when the bridge refuses it, and Escape makes it a message again', async () => {
    const onSend = vi.fn()
    const onNewTask = vi.fn(async () => false)
    render(<Harness onPick={vi.fn()} onSend={onSend} onNewTask={onNewTask} />)
    const box = await type('$task')
    fireEvent.keyDown(box, { key: 'Enter' })
    await type('Call the bank')
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(onNewTask).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('New task')).toBeTruthy()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByLabelText('New task')).toBeNull()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('offers no New task where the chat view cannot make one', async () => {
    render(<Harness onPick={vi.fn()} />)
    await type('$task')
    expect(screen.queryAllByRole('option').map((o) => o.textContent).join()).not.toContain('New task')
  })
})
