import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import TodoComposer, { todoDraftStore } from './TodoComposer'
import TodoConnectors, { TodoTrackingLaunchers } from './TodoConnectors'
import TodoDetailSheet from './TodoDetailSheet'
import TodoLifecyclePanels from './TodoLifecyclePanels'
import type { Todo } from './types'

function task(input: Partial<Todo> & Pick<Todo, 'id' | 'title'>): Todo {
  return { description: '', area: 'Personal', ventureTag: null, status: 'todo', priority: 1, dueDate: null, recurrence: null, snoozedUntil: null, position: 0, createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z', outcome: null, completedAt: null, archivedAt: null, deletedAt: null, tags: [], notes: [], relations: [], externalLinks: [], lists: [], syncState: { status: 'idle', pending: 0, conflicts: 0, exhausted: 0, missing: false, lastSuccessAt: null, lastError: null }, ...input }
}

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

describe('advanced todo workflows', () => {
  it('opens source tracking from visible Action Items and GitHub launchers', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [source, setSource] = React.useState<'sheet' | 'github' | null>(null)
      return <TodoTrackingLaunchers source={source} onSelect={setSource} />
    }
    render(<Harness />)
    const actionItems = screen.getByRole('button', { name: 'Track Action Items' })
    const github = screen.getByRole('button', { name: 'Track GitHub issues' })
    expect(actionItems).toHaveAttribute('aria-pressed', 'false')
    await user.click(actionItems)
    expect(actionItems).toHaveAttribute('aria-pressed', 'true')
    await user.click(github)
    expect(actionItems).toHaveAttribute('aria-pressed', 'false')
    expect(github).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the task editor inside its dialog and can focus note entry directly', () => {
    render(<TodoDetailSheet todo={task({ id: 'bounded', title: 'Stay bounded' })} initialFocus="notes" onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Task details' })
    expect(getComputedStyle(dialog).overflowX).toBe('hidden')
    expect(screen.getByLabelText('New note')).toHaveFocus()
  })

  it('restores a saved draft and keeps notes append-only', () => {
    todoDraftStore.set({ title: 'Half written' })
    render(<TodoComposer />)
    expect(screen.getByDisplayValue('Half written')).toBeVisible()
    cleanup()
    render(<TodoDetailSheet todo={task({ id: 'a', title: 'Read me', notes: [{ id: 'n', body: 'Original note', createdAt: '2026-09-01T12:00:00.000Z' }] })} onClose={() => {}} />)
    expect(screen.getByText('Original note')).toBeVisible()
    expect(screen.queryByRole('button', { name: /edit note|delete note/i })).toBeNull()
  })

  it('unsharing names that the external row remains', async () => {
    const user = userEvent.setup()
    const onUnshare = vi.fn().mockResolvedValue(undefined)
    render(<TodoDetailSheet todo={task({ id: 's', title: 'Shared', externalLinks: [{ id: 'l', connector: 'sheet', externalId: 's', externalUrl: 'https://docs.google.com/s', sourceStatus: 'Not Started', sourceSnapshot: null, lastSyncSnapshot: null, initialStatusSeeded: true, lastObservedAt: null, lastSyncedAt: null, missingAt: null, createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z' }] })} onClose={() => {}} onUnshare={onUnshare} />)
    await user.click(screen.getByRole('button', { name: 'Stop syncing' }))
    expect(screen.getByText(/row stays in Action Items/i)).toBeVisible()
    expect(onUnshare).toHaveBeenCalledOnce()
  })

  it('shares an existing venture task with Action Items only after an explicit click', async () => {
    const user = userEvent.setup(), share = vi.fn().mockResolvedValue(undefined)
    render(<TodoDetailSheet todo={task({ id: 'v', title: 'Venture follow-up', area: 'Ventures', ventureTag: 'Initech' })} onClose={() => {}} onShare={share} />)
    expect(share).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Sync with Action Items' }))
    expect(share).toHaveBeenCalledWith('sheet', {})
  })

  it('keeps snoozed work discoverable and restores deleted work', async () => {
    const user = userEvent.setup(), restore = vi.fn().mockResolvedValue(undefined)
    const snoozed = task({ id: 'z', title: 'Later', snoozedUntil: '2026-09-15T12:00:00.000Z' })
    const deleted = task({ id: 'd', title: 'Bring back', deletedAt: '2026-09-11T12:00:00.000Z' })
    render(<TodoLifecyclePanels snoozed={[snoozed]} deleted={[deleted]} onRestore={restore} />)
    expect(screen.getByText('1 snoozed task')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Recycle bin · 1' }))
    await user.click(screen.getByRole('button', { name: 'Restore Bring back' }))
    expect(restore).toHaveBeenCalledWith('d')
  })

  it('searches and links GitHub issues from an auto-tracking source panel', async () => {
    const user = userEvent.setup(), search = vi.fn().mockResolvedValue([{ id: '90042', title: 'Fix door', identifier: 'acme#42' }]), link = vi.fn()
    render(<TodoConnectors source="github" githubHealth={{ status: 'ok' }} githubSettings={{ trackAssigned: true, watchedRepos: ['acme/acme'], watermark: '2026-09-12T14:00:00.000Z' }} onGithubSearch={search} onGithubLink={link} />)
    expect(screen.getByRole('heading', { name: 'GitHub issue tracking' })).toBeVisible()
    expect(screen.getByText('Auto-tracking on')).toBeVisible()
    expect(screen.queryByText('Action Items tracking')).toBeNull()
    await user.type(screen.getByLabelText('Search GitHub issues'), 'acme#42')
    await user.click(screen.getByRole('button', { name: 'Search issues' }))
    await user.click(await screen.findByRole('button', { name: 'Link acme#42' }))
    expect(link).toHaveBeenCalledWith('90042')
  })

  it('says which setting an unconfigured sheet needs, and that queued writes are kept', () => {
    render(<TodoConnectors source="sheet" sheetHealth={{ status: 'unconfigured', missing: ['TASK_SHEET_ID'], queued: 2, lastError: 'Google Sheet task sync needs TASK_SHEET_ID. 2 queued write(s) are kept and will send once it is configured.', recovery: 'Set TASK_SHEET_ID in .env or Settings -> Integrations, then restart Totem.' }} />)
    expect(screen.getByText('needs TASK_SHEET_ID')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(/2 queued write\(s\) are kept/)
  })

  it('shows Action Items auto-tracking health and filters the board to tracked rows', async () => {
    const user = userEvent.setup(), refreshSheet = vi.fn().mockResolvedValue(undefined), viewSource = vi.fn()
    render(<TodoConnectors source="sheet" sheetHealth={{ status: 'healthy', lastSuccessAt: '2026-09-12T14:00:00.000Z' }} onSheetRefresh={refreshSheet} onViewSource={viewSource} />)
    expect(screen.getByRole('heading', { name: 'Action Items tracking' })).toBeVisible()
    expect(screen.getByText('Auto-tracking on')).toBeVisible()
    expect(screen.getByText(/configured assignees \(TASK_SHEET_ASSIGNEES\)/i)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'View tracked Action Items' }))
    expect(viewSource).toHaveBeenCalledWith('sheet')
    await user.click(screen.getByRole('button', { name: 'Refresh Action Items' }))
    expect(refreshSheet).toHaveBeenCalledOnce()
    expect(screen.getByText(/last synced/i)).toBeVisible()
  })
})
