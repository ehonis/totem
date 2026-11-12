import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevIssue, DevIssues } from '../api'

const getDevIssues = vi.fn()
vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), getDevIssues: (...a: unknown[]) => getDevIssues(...a) }))
const { default: IssuesCard } = await import('./IssuesCard')

const issue = (repo: string, number: number, extra: Partial<DevIssue> = {}): DevIssue => ({
  repo, number, title: `Issue ${number}`, state: 'open', stateReason: null,
  url: `https://github.com/${repo}/issues/${number}`, labels: [], assignees: [], author: 'someone',
  comments: 0, createdAt: '2026-10-01T10:00:00Z', updatedAt: new Date().toISOString(), milestone: null,
  ...extra,
})

const feed = (issues: DevIssue[], extra: Partial<DevIssues> = {}): DevIssues => ({
  enabled: true, state: 'open', scope: 'all', repo: null, login: 'octo', repos: ['acme/app', 'acme/site'],
  fetchedAt: new Date().toISOString(), issues, capped: [], errors: [], warnings: [], ...extra,
})

const ISSUES = [
  issue('acme/app', 12, { title: 'Crash on login', labels: [{ name: 'bug', color: 'd73a4a' }], assignees: ['octo'], comments: 3 }),
  issue('acme/site', 7, { title: 'Broken footer', labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'design', color: '7057ff' }] }),
  issue('other/lib', 1, { title: 'Docs typo' }),
]
const titles = () => screen.queryAllByRole('listitem').map((li) => li.querySelector('.dev-issue-title')?.textContent)

beforeEach(() => { localStorage.clear(); getDevIssues.mockReset() })
afterEach(cleanup)

describe('IssuesCard', () => {
  it('lists issues with repo, number, labels, initials and comments', async () => {
    getDevIssues.mockResolvedValue(feed(ISSUES))
    render(<IssuesCard onAuthError={() => {}} />)
    await waitFor(() => expect(titles()).toEqual(['Crash on login', 'Broken footer', 'Docs typo']))
    const row = screen.getAllByRole('listitem')[0]
    expect(within(row).getByText('app')).toBeInTheDocument()
    expect(within(row).getByText('#12')).toBeInTheDocument()
    const label = within(row).getByRole('button', { name: 'bug' })
    expect(label.style.color).toMatch(/^rgb\(/)
    expect(label.style.background).toMatch(/^rgb\(/)
    expect(within(row).getByText('OC')).toHaveClass('me')
    expect(within(row).getByTitle('3 comments')).toHaveTextContent('3')
    expect(within(row).getByRole('link')).toHaveAttribute('href', 'https://github.com/acme/app/issues/12')
    expect(screen.getByText(/3 open issues · 1 assigned to you/)).toBeInTheDocument()
    expect(getDevIssues).toHaveBeenCalledWith('open', 'all', false)
  })

  it('filters by search, label and repo without asking the bridge again', async () => {
    getDevIssues.mockResolvedValue(feed(ISSUES))
    render(<IssuesCard onAuthError={() => {}} />)
    await waitFor(() => expect(titles()).toHaveLength(3))
    const calls = getDevIssues.mock.calls.length

    fireEvent.change(screen.getByLabelText('Search issues'), { target: { value: 'footer' } })
    expect(titles()).toEqual(['Broken footer'])
    expect(screen.getByText('1 of 3')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Clear/ }))
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'bug' } })
    expect(titles()).toEqual(['Crash on login', 'Broken footer'])

    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'acme/site' } })
    expect(titles()).toEqual(['Broken footer'])
    expect((screen.getByLabelText('Label') as HTMLSelectElement).value, 'a repo change resets the label').toBe('')

    fireEvent.change(screen.getByLabelText('Search issues'), { target: { value: 'nothing like this' } })
    expect(screen.getByText('No issues match these filters.')).toBeInTheDocument()
    expect(getDevIssues.mock.calls.length).toBe(calls)
  })

  it('a label on a row filters to it', async () => {
    getDevIssues.mockResolvedValue(feed(ISSUES))
    render(<IssuesCard onAuthError={() => {}} />)
    await waitFor(() => expect(titles()).toHaveLength(3))
    fireEvent.click(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: 'design' }))
    expect(titles()).toEqual(['Broken footer'])
  })

  it('asks the bridge for another state or scope, and Refresh asks with refresh', async () => {
    getDevIssues.mockResolvedValue(feed(ISSUES))
    render(<IssuesCard onAuthError={() => {}} />)
    await waitFor(() => expect(titles()).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Closed' }))
    await waitFor(() => expect(getDevIssues).toHaveBeenLastCalledWith('closed', 'all', false))
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }))
    await waitFor(() => expect(getDevIssues).toHaveBeenLastCalledWith('closed', 'mine', false))
    await waitFor(() => expect(screen.getByRole('button', { name: /Refresh/ })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(getDevIssues).toHaveBeenLastCalledWith('closed', 'mine', true))
  })

  it('explains itself when off, when empty, and keeps the list on a failed read', async () => {
    getDevIssues.mockResolvedValueOnce(feed([], { enabled: false, reason: 'Watch a repo below, or sign in gh.' }))
    const { unmount } = render(<IssuesCard onAuthError={() => {}} />)
    expect(await screen.findByText('Watch a repo below, or sign in gh.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Search issues')).toBeNull()
    unmount()

    localStorage.clear()
    getDevIssues.mockResolvedValueOnce(feed([]))
    const second = render(<IssuesCard onAuthError={() => {}} />)
    expect(await screen.findByText('No open issues in the watched repos or assigned to you.')).toBeInTheDocument()
    second.unmount()

    localStorage.clear()
    getDevIssues.mockResolvedValueOnce(feed(ISSUES, { errors: [{ source: 'acme/app', error: 'HTTP 502', stale: true }], error: 'acme/app: HTTP 502' }))
    render(<IssuesCard onAuthError={() => {}} />)
    expect(await screen.findByText('Showing the last good list of acme/app: HTTP 502')).toBeInTheDocument()
    expect(titles()).toHaveLength(3)
  })

  it('shows a request failure and no list when there is nothing to show', async () => {
    getDevIssues.mockRejectedValue(new Error('bridge unreachable'))
    render(<IssuesCard onAuthError={() => {}} />)
    expect(await screen.findByText(/bridge unreachable/)).toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('never draws one view’s rows under another view’s name', async () => {
    getDevIssues.mockResolvedValueOnce(feed(ISSUES))
    render(<IssuesCard onAuthError={() => {}} />)
    await waitFor(() => expect(titles()).toHaveLength(3))

    let fail: (e: Error) => void = () => {}
    getDevIssues.mockReturnValueOnce(new Promise((_, reject) => { fail = reject }))
    fireEvent.click(screen.getByRole('button', { name: 'Closed' }))
    expect(titles(), 'nothing cached for Closed: the open rows go').toEqual([])
    expect(screen.getByText('Asking GitHub…')).toBeInTheDocument()
    fail(new Error('bridge unreachable'))
    expect(await screen.findByText('bridge unreachable')).toBeInTheDocument()
    expect(titles()).toEqual([])
    expect(screen.queryByText(/closed issue/)).toBeNull()

    // An answer for a view no longer selected is not drawn either.
    getDevIssues.mockResolvedValueOnce(feed(ISSUES, { state: 'open' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }))
    await waitFor(() => expect(getDevIssues).toHaveBeenLastCalledWith('closed', 'mine', false))
    await waitFor(() => expect(screen.getByRole('button', { name: /Refresh/ })).not.toBeDisabled())
    expect(titles()).toEqual([])
  })

  it('asks again when the page reloads it, with refresh only for the page’s Refresh', async () => {
    getDevIssues.mockResolvedValue(feed(ISSUES))
    const { rerender } = render(<IssuesCard onAuthError={() => {}} reload={{ n: 0, refresh: false }} />)
    await waitFor(() => expect(titles()).toHaveLength(3))
    expect(getDevIssues).toHaveBeenCalledTimes(1)
    rerender(<IssuesCard onAuthError={() => {}} reload={{ n: 1, refresh: false }} />)
    await waitFor(() => expect(getDevIssues).toHaveBeenCalledTimes(2))
    expect(getDevIssues).toHaveBeenLastCalledWith('open', 'all', false)
    rerender(<IssuesCard onAuthError={() => {}} reload={{ n: 2, refresh: true }} />)
    await waitFor(() => expect(getDevIssues).toHaveBeenLastCalledWith('open', 'all', true))
  })

  it('says GitHub could not be read rather than "no issues", and names a cap', async () => {
    getDevIssues.mockResolvedValueOnce(feed([], { fetchedAt: null, errors: [{ source: 'acme/app', error: 'HTTP 500', stale: false }] }))
    const { unmount } = render(<IssuesCard onAuthError={() => {}} />)
    expect(await screen.findByText('Couldn’t read acme/app: HTTP 500')).toBeInTheDocument()
    expect(screen.getByText('Nothing to show until GitHub answers.')).toBeInTheDocument()
    expect(screen.queryByText(/No open issues/)).toBeNull()
    expect(screen.queryByText(/last good list/)).toBeNull()
    unmount()

    localStorage.clear()
    getDevIssues.mockResolvedValueOnce(feed(ISSUES, { capped: [{ source: 'acme/app', shown: 1000, total: 1240 }] }))
    render(<IssuesCard onAuthError={() => {}} />)
    expect(await screen.findByText('Showing the 1,000 most recently updated open issues in acme/app (of 1,240).')).toBeInTheDocument()
  })

  it('keeps a picked repo in its menu when the new view has none of its issues', async () => {
    getDevIssues.mockResolvedValueOnce(feed(ISSUES))
    render(<IssuesCard onAuthError={() => {}} />)
    await waitFor(() => expect(titles()).toHaveLength(3))
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'other/lib' } })
    getDevIssues.mockResolvedValueOnce(feed(ISSUES.slice(0, 2), { scope: 'watched' }))
    fireEvent.click(screen.getByRole('button', { name: 'Watched' }))
    await waitFor(() => expect(getDevIssues).toHaveBeenLastCalledWith('open', 'watched', false))
    await screen.findByText('No issues match these filters.')
    const select = screen.getByLabelText('Repository') as HTMLSelectElement
    expect(select.value).toBe('other/lib')
    expect(within(select).getByRole('option', { name: 'other/lib (0)' })).toBeInTheDocument()
  })

  it('rows: focusable and named, Chat about this on the row but not the title link, Enter opens, a click does not', async () => {
    const many = issue('acme/app', 99, { title: 'Lots of labels', labels: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, color: '7057ff' })) })
    getDevIssues.mockResolvedValueOnce(feed([many, ISSUES[1]]))
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<IssuesCard onAuthError={() => {}} />)
    const row = await screen.findByRole('listitem', { name: 'acme/app #99: Lots of labels (open)' })
    expect(row).toHaveAttribute('tabindex', '0')
    expect(within(row).getByRole('img', { name: 'Open' })).toBeInTheDocument()
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['a', 'b', 'c'])
    expect(row).toHaveAccessibleDescription(/^Labels: a, b, c, d, e\. 0 comments\. Updated just now\.$/)
    expect(within(row).getByText('+2')).toHaveAttribute('title', 'd, e')

    expect(fireEvent.contextMenu(row), 'the row itself opens Chat about this').toBe(false)
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    const link = within(row).getByRole('link')
    expect(link).toHaveTextContent('Lots of labels')
    expect(fireEvent.contextMenu(link), 'the title keeps the browser’s link menu').toBe(true)

    fireEvent.click(row)
    expect(open).not.toHaveBeenCalled()
    const clicked = vi.fn((e: Event) => e.preventDefault())
    link.addEventListener('click', clicked)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(clicked).toHaveBeenCalledTimes(1)
    open.mockRestore()
  })

  it('the list is one tab stop: arrows move between rows, Tab reaches the active row’s labels', async () => {
    getDevIssues.mockResolvedValueOnce(feed(ISSUES))
    render(<IssuesCard onAuthError={() => {}} />)
    await waitFor(() => expect(titles()).toHaveLength(3))
    const rows = () => screen.getAllByRole('listitem')
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1])
    const labelStops = () => rows().map((r) => within(r).queryAllByRole('button').filter((b) => b.tabIndex === 0).length)
    expect(labelStops(), 'only the active row’s labels are in the tab order').toEqual([1, 0, 0])

    rows()[0].focus()
    fireEvent.keyDown(rows()[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows()[1])
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1])
    expect(labelStops()).toEqual([0, 2, 0])
    fireEvent.keyDown(rows()[1], { key: 'End' })
    expect(document.activeElement).toBe(rows()[2])
    fireEvent.keyDown(rows()[2], { key: 'ArrowDown' })
    expect(document.activeElement, 'stops at the last row').toBe(rows()[2])
    fireEvent.keyDown(rows()[2], { key: 'Home' })
    expect(document.activeElement).toBe(rows()[0])
    fireEvent.keyDown(within(rows()[0]).getByRole('button', { name: 'bug' }), { key: 'ArrowDown' })
    expect(document.activeElement, 'arrows work from a label too').toBe(rows()[1])
  })

  it('names the source it could not read, and warns when GitHub left some issues out', async () => {
    getDevIssues.mockResolvedValueOnce(feed(ISSUES.slice(1), {
      errors: [{ source: 'Assigned to you', error: 'gh is not signed in', stale: false }],
      warnings: [{ source: 'acme/app', warning: 'Resource protected by organization SAML enforcement.' }],
    }))
    render(<IssuesCard onAuthError={() => {}} />)
    expect(await screen.findByText('Couldn’t read issues assigned to you: gh is not signed in')).toBeInTheDocument()
    expect(screen.getByText('Some issues in acme/app could not be read: Resource protected by organization SAML enforcement.')).toBeInTheDocument()
    expect(titles()).toHaveLength(2)
  })
})
