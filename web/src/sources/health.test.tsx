import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import MetricSourceWarning from './MetricSourceWarning'
import SourceHealthPanel from './SourceHealthPanel'
import {
  failingSourceFor, groupSources, resetSourceHealthCache, sourceSummary,
  type SourceHealth, type SourceHealthPayload,
} from './health'

const NOW = Date.parse('2026-10-30T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

const source = (over: Partial<SourceHealth>): SourceHealth => ({
  source: 'strava', kind: 'strava', instance: null, label: 'Strava', via: 'read from Bushido',
  state: 'ok', lastRunAt: hoursAgo(1), lastOkAt: hoursAgo(1), lastErrorAt: null,
  failures: 0, failingSince: null, error: null, rows: 120, goals: [], ...over,
})

const payload = (sources: SourceHealth[], goals: SourceHealthPayload['goals'] = []): SourceHealthPayload => ({
  generatedAt: new Date(NOW).toISOString(), disabled: null, sources, goals, metricSources: { strava_distance: 'strava', strava_gear_odometer: 'strava' },
})

const failingStrava = source({
  state: 'failing', failures: 4, failingSince: hoursAgo(3), lastOkAt: hoursAgo(5), error: 'could not reach Bushido for Strava',
  goals: [{ id: 'g1', title: 'Ride 40 miles' }],
})

function serve(body: SourceHealthPayload) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetSourceHealthCache() })

describe('sourceSummary', () => {
  it('says when a working source last worked and what it brought', () => {
    expect(sourceSummary(source({}), NOW)).toBe('Last OK 1h ago · 120 rows')
  })
  it('says how long a failing source has been failing and when it last worked', () => {
    expect(sourceSummary(failingStrava, NOW)).toBe('Failing since 3h ago · last OK 5h ago')
  })
  it('counts the failures of a source that is only erroring', () => {
    expect(sourceSummary(source({ state: 'degraded', failures: 1, lastOkAt: null }), NOW)).toBe('1 failed read in a row · never worked')
  })
  it('says a source nothing has read yet is not read', () => {
    expect(sourceSummary(source({ state: 'unknown', lastOkAt: null }), NOW)).toBe('Not read yet')
  })
  it('says a source that answered it is not set up is not set up, with why', () => {
    expect(sourceSummary(source({ state: 'unconfigured', error: 'waiting for its sign-in' }), NOW)).toBe('Not set up: waiting for its sign-in')
  })
})

describe('groupSources', () => {
  it('lists each goal\'s sources under it and the rest after, failing first', () => {
    const data = payload(
      [failingStrava, source({ source: 'gmail:home', label: 'Gmail · home' }), source({ source: 'feed:hn', label: 'Feed · hn', state: 'failing' })],
      [{ id: 'g1', title: 'Ride 40 miles', periodType: 'week', sources: ['strava'], failing: ['strava'] }],
    )
    const { goals, other } = groupSources(data)
    expect(goals.map((g) => [g.goal.title, g.sources.map((s) => s.source)])).toEqual([['Ride 40 miles', ['strava']]])
    expect(other.map((s) => s.source)).toEqual(['feed:hn', 'gmail:home'])
  })
})

describe('failingSourceFor', () => {
  it('names the failing source a metric reads, and nothing for a working one or a manual metric', () => {
    expect(failingSourceFor(payload([failingStrava]), 'strava_distance')?.source).toBe('strava')
    expect(failingSourceFor(payload([source({ state: 'degraded' })]), 'strava_distance')).toBeNull()
    expect(failingSourceFor(payload([failingStrava]), 'manual')).toBeNull()
    expect(failingSourceFor(null, 'strava_distance')).toBeNull()
  })
})

describe('MetricSourceWarning', () => {
  it('marks a metric whose source is failing', async () => {
    serve(payload([failingStrava]))
    render(<MetricSourceWarning sourceKind="strava_distance" />)
    const link = await screen.findByRole('link', { name: /Strava failing since/ })
    expect(link.getAttribute('href')).toBe('/settings/connections')
    expect(link.getAttribute('title')).toContain('could not reach Bushido')
  })
  it('says nothing while the source works', async () => {
    serve(payload([source({})]))
    const { container } = render(<MetricSourceWarning sourceKind="strava_distance" />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })
})

describe('SourceHealthPanel', () => {
  it('says source health is off when the run log could not be opened', async () => {
    serve({ ...payload([]), disabled: 'unable to open database file' })
    render(<SourceHealthPanel />)
    expect(await screen.findByText(/Source health is off until Totem restarts: unable to open database file/)).toBeTruthy()
  })

  it('shows a failing source under the goal it feeds, with its error', async () => {
    serve(payload([failingStrava], [{ id: 'g1', title: 'Ride 40 miles', periodType: 'week', sources: ['strava'], failing: ['strava'] }]))
    render(<SourceHealthPanel />)
    expect(await screen.findByText('Ride 40 miles')).toBeTruthy()
    expect(screen.getByText('Failing')).toBeTruthy()
    expect(screen.getByText('could not reach Bushido for Strava')).toBeTruthy()
    expect(screen.getByText(/1 source is failing/)).toBeTruthy()
  })
})
