import React, { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import TodoToolbar from './TodoToolbar'
import type { TodoQuery, TodoSort } from './types'

afterEach(cleanup)

function SortHarness() {
  const [sort, setSort] = useState<TodoSort[]>(['manual'])
  return <TodoToolbar query={{}} sort={sort} groupBySource={false} bulkMode={false} selectedCount={0} onQuery={() => {}} onSort={setSort} onGroupBySource={() => {}} onBulkMode={() => {}} onBulk={() => {}} />
}

function FilterHarness({ initial = {} as TodoQuery }) {
  const [query, setQuery] = useState<TodoQuery>(initial)
  return <TodoToolbar query={query} sort={['manual']} groupBySource={false} bulkMode={false} selectedCount={0} onQuery={setQuery} onSort={() => {}} onGroupBySource={() => {}} onBulkMode={() => {}} onBulk={() => {}} />
}

const openSort = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /^Manual order|Due date|Priority|Recently/ }))

describe('todo toolbar sorting', () => {
  it('builds and edits an ordered list of sort criteria', async () => {
    const user = userEvent.setup()
    render(<SortHarness />)

    await openSort(user)
    await user.selectOptions(screen.getByLabelText('Sort tasks by'), 'due')
    await user.click(screen.getByRole('button', { name: 'Then by' }))
    expect(screen.getByLabelText('Sort tasks by')).toHaveValue('due')
    expect(screen.getByLabelText('Then sort tasks by 2')).toHaveValue('priority')

    await user.selectOptions(screen.getByLabelText('Then sort tasks by 2'), 'updated')
    expect(screen.getByLabelText('Then sort tasks by 2')).toHaveValue('updated')
    await user.click(screen.getByRole('button', { name: 'Remove Recently updated sort' }))
    expect(screen.queryByLabelText('Then sort tasks by 2')).toBeNull()
  })

  it('keeps manual order as a standalone mode', async () => {
    const user = userEvent.setup()
    render(<SortHarness />)

    await openSort(user)
    expect(screen.queryByRole('button', { name: 'Then by' })).toBeNull()
    await user.selectOptions(screen.getByLabelText('Sort tasks by'), 'priority')
    await user.click(screen.getByRole('button', { name: 'Then by' }))
    await user.selectOptions(screen.getByLabelText('Sort tasks by'), 'manual')
    expect(screen.getByLabelText('Sort tasks by')).toHaveValue('manual')
    expect(screen.queryByLabelText('Then sort tasks by 2')).toBeNull()
  })

  it('states the order on the button so the panel does not have to be opened to read it', async () => {
    const user = userEvent.setup()
    render(<SortHarness />)

    expect(screen.getByRole('button', { name: /Manual order/ })).toBeVisible()
    await openSort(user)
    await user.selectOptions(screen.getByLabelText('Sort tasks by'), 'due')
    await user.click(screen.getByRole('button', { name: 'Then by' }))
    expect(screen.getByRole('button', { name: /Due date → Priority/ })).toBeVisible()
  })
})

describe('todo toolbar filters', () => {
  it('keeps filters in a popover and shows what is on as removable chips', async () => {
    const user = userEvent.setup()
    render(<FilterHarness />)

    expect(screen.queryByLabelText('Priority')).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Filter/ }))
    await user.selectOptions(screen.getByLabelText('Priority'), '4')
    await user.selectOptions(screen.getByLabelText('Due'), 'overdue')

    expect(screen.getByRole('button', { name: /^Filter 2/ })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Clear Priority filter' })).toHaveTextContent('P1')
    expect(screen.getByRole('button', { name: 'Clear Due filter' })).toHaveTextContent('Overdue')

    await user.click(screen.getByRole('button', { name: 'Clear Priority filter' }))
    expect(screen.queryByRole('button', { name: 'Clear Priority filter' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Filter 1/ })).toBeVisible()
  })

  it('clears every filter at once without touching the search text', async () => {
    const user = userEvent.setup()
    render(<FilterHarness initial={{ search: 'launch', area: 'Ventures', source: 'github' }} />)

    await user.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(screen.queryByRole('button', { name: /^Clear .* filter/ })).toBeNull()
    expect(screen.getByLabelText('Search tasks')).toHaveValue('launch')
  })

  it('clears the search from the field itself', async () => {
    const user = userEvent.setup()
    render(<FilterHarness initial={{ search: 'launch' }} />)

    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByLabelText('Search tasks')).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
  })

  it('carries grouping with the other view options instead of a fifth toolbar button', async () => {
    const user = userEvent.setup()
    const onGroupBySource = vi.fn()
    render(<TodoToolbar query={{}} sort={['manual']} groupBySource={false} bulkMode={false} selectedCount={0} onQuery={() => {}} onSort={() => {}} onGroupBySource={onGroupBySource} onBulkMode={() => {}} onBulk={() => {}} />)

    expect(screen.queryByRole('checkbox', { name: 'Group by source' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Filter/ }))
    await user.click(screen.getByRole('checkbox', { name: 'Group by source' }))
    expect(onGroupBySource).toHaveBeenCalledWith(true)
  })

  it('closes an open popover on Escape', async () => {
    const user = userEvent.setup()
    render(<FilterHarness />)

    await user.click(screen.getByRole('button', { name: /^Filter/ }))
    expect(screen.getByRole('dialog', { name: 'Filter and group tasks' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Filter and group tasks' })).toBeNull()
  })
})

describe('todo toolbar bulk mode', () => {
  it('gives bulk actions their own row and disables them until something is selected', async () => {
    const user = userEvent.setup()
    const onBulk = vi.fn(), onBulkMode = vi.fn()
    const { rerender } = render(<TodoToolbar query={{}} sort={['manual']} groupBySource={false} bulkMode selectedCount={0} onQuery={() => {}} onSort={() => {}} onGroupBySource={() => {}} onBulkMode={onBulkMode} onBulk={onBulk} />)

    expect(screen.getByLabelText('Bulk actions')).toHaveTextContent('0 selected')
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeDisabled()

    rerender(<TodoToolbar query={{}} sort={['manual']} groupBySource={false} bulkMode selectedCount={3} onQuery={() => {}} onSort={() => {}} onGroupBySource={() => {}} onBulkMode={onBulkMode} onBulk={onBulk} />)
    expect(screen.getByLabelText('Bulk actions')).toHaveTextContent('3 selected')
    await user.click(screen.getByRole('button', { name: 'Mark done' }))
    expect(onBulk).toHaveBeenCalledWith('complete')

    await user.type(screen.getByLabelText('Bulk tag'), 'launch')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(onBulk).toHaveBeenLastCalledWith('addTag', 'launch')

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(onBulkMode).toHaveBeenCalledWith(false)
  })
})
