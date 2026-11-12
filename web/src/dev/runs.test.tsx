import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevRun, DevRunThread } from '../api'
import { isStale, issueLabel, splitRuns, stageLabel, stageTone, threadSummary, STALE_MS } from './runs'

const getDevRuns = vi.fn()
const setDevRunArchived = vi.fn()
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  getDevRuns: (...a: unknown[]) => getDevRuns(...a),
  setDevRunArchived: (...a: unknown[]) => setDevRunArchived(...a),
}))
const { default: RunsCard } = await import('./RunsCard')

const thread = (extra: Partial<DevRunThread> = {}): DevRunThread => ({
  issue: '#12', title: 'Kanban board', stage: 'review', round: 2, lastReportAt: null,
  pr: { number: 41, url: 'https://github.com/acme/app/pull/41' }, ci: 'passing', codeScore: 9, uxScore: 8, skippedSeats: [], ...extra,
})

const run = (slug: string, extra: Partial<DevRun> = {}): DevRun => ({
  slug, run: slug, title: `${slug} ORCH`, repo: 'acme/app', orchThreadId: 't1', environmentId: 'e1',
  orchUrl: 'https://t3.example/e1/t1', updatedAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
  waitingOnEthan: [], incidents: [], threads: [thread()], handoffUrl: null, finishedAt: null, archived: false, archivedAt: null, ...extra,
})

describe('runs helpers', () => {
  it('splits active from finished, newest first', () => {
    const { active, finished } = splitRuns([
      run('old', { updatedAt: '2026-11-01T00:00:00Z' }),
      run('new', { updatedAt: '2026-11-09T00:00:00Z' }),
      run('done', { archived: true, archivedAt: '2026-11-05T00:00:00Z' }),
    ])
    expect(active.map((r) => r.slug)).toEqual(['new', 'old'])
    expect(finished.map((r) => r.slug)).toEqual(['done'])
  })

  it('calls a run stale after two hours', () => {
    const now = Date.parse('2026-11-10T12:00:00Z')
    expect(isStale({ updatedAt: new Date(now - STALE_MS + 1000).toISOString() }, now)).toBe(false)
    expect(isStale({ updatedAt: new Date(now - STALE_MS - 1000).toISOString() }, now)).toBe(true)
  })

  it('names stages, issues and the thread tally', () => {
    expect(stageLabel({ stage: 'review', round: 2 })).toBe('Review, round 2')
    expect(stageLabel({ stage: 'pr', round: null })).toBe('PR open')
    expect(stageTone('blocked')).toBe('failure')
    expect(issueLabel('acme/app#7')).toBe('#7')
    expect(issueLabel('12')).toBe('#12')
    expect(threadSummary([thread({ stage: 'merged' }), thread({ stage: 'blocked' }), thread()])).toBe('1 of 3 merged · 1 blocked')
  })
})

describe('RunsCard', () => {
  beforeEach(() => { localStorage.clear(); getDevRuns.mockReset(); setDevRunArchived.mockReset() })
  afterEach(cleanup)

  it('draws nothing before any run has reported', async () => {
    getDevRuns.mockResolvedValue({ runs: [] })
    const { container } = render(<RunsCard onAuthError={() => {}} />)
    await waitFor(() => expect(getDevRuns).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('shows what each run waits on, its incidents, its threads and a link to the ORCH', async () => {
    getDevRuns.mockResolvedValue({ runs: [
      run('tasks', {
        waitingOnEthan: ['Merge PR #41'],
        incidents: ['A sub-thread deleted its worktree'],
        threads: [thread(), thread({ issue: '#13', title: 'Sheet feed', stage: 'blocked', pr: null, codeScore: null, uxScore: null, skippedSeats: ['Fable'] })],
      }),
      run('stale', { updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }),
      run('done', { archived: true, archivedAt: new Date().toISOString(), handoffUrl: 'https://example.com/handoff' }),
    ] })
    render(<RunsCard onAuthError={() => {}} />)
    const block = await screen.findByRole('article', { name: 'tasks ORCH' })
    expect(within(block).getByRole('link', { name: 'tasks ORCH' }).getAttribute('href')).toBe('https://t3.example/e1/t1')
    expect(within(block).getByText('Merge PR #41')).toBeTruthy()
    expect(within(block).getByRole('list', { name: 'Incidents' }).textContent).toContain('deleted its worktree')
    expect(within(block).getByText('Review, round 2')).toBeTruthy()
    expect(within(block).getByText('Blocked')).toBeTruthy()
    expect(within(block).getByRole('link', { name: /#41/ }).getAttribute('href')).toBe('https://github.com/acme/app/pull/41')
    expect(within(block).getByText('Fable')).toBeTruthy()
    expect(within(block).getByText(/1 blocked/)).toBeTruthy()
    expect(screen.getByRole('article', { name: 'stale ORCH' }).textContent).toMatch(/Stale, updated 3h ago/)
    expect(screen.queryByRole('article', { name: 'done ORCH' })).toBeNull()
    expect(screen.getByText('Finished')).toBeTruthy()
  })

  it('archives at once and puts the run back if the bridge refuses', async () => {
    getDevRuns.mockResolvedValue({ runs: [run('tasks')] })
    setDevRunArchived.mockRejectedValue(new Error('nope'))
    render(<RunsCard onAuthError={() => {}} />)
    const block = await screen.findByRole('article', { name: 'tasks ORCH' })
    fireEvent.click(within(block).getByRole('button', { name: 'Archive' }))
    expect(setDevRunArchived).toHaveBeenCalledWith('tasks', true)
    await waitFor(() => expect(screen.getByRole('article', { name: 'tasks ORCH' })).toBeTruthy())
  })
})
