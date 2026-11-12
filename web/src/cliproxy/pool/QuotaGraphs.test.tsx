import React from 'react'
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProxyAccount } from '../api'
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  getProxyHistory: vi.fn(async () => ({ supported: true, samples: [] })),
}))
import { getProxyHistory } from '../api'
import { QuotaGraphs } from './QuotaGraphs'
const now = Date.now()
const accounts = ['claude', 'codex'].map((backend) => ({
  id: `${backend}:proxy:a`,
  backend,
  source: 'cliproxy',
  displayName: `${backend} seat`,
  fetchedAt: now,
  meters: [
    {
      key: backend === 'claude' ? 'session:' : 'primary',
      remainingPct: 40,
      resetsAt: now + 3600_000,
      windowMinutes: 300,
    },
    {
      key: backend === 'claude' ? 'weekly_all:' : 'secondary',
      remainingPct: 50,
      resetsAt: now + 3 * 86400_000,
      windowMinutes: 10080,
    },
  ],
})) as ProxyAccount[]
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
it('switches the copied graph views, provider merge, drain rate and forecast controls', async () => {
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  expect(await screen.findByRole('article', { name: 'Claude pool' })).toBeTruthy()
  const weekly = screen.getByRole('button', { name: 'Weekly' })
  fireEvent.click(weekly)
  expect(weekly.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Combined' }))
  expect(screen.getAllByText('Weekly runs out')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Together' }))
  expect(screen.getAllByRole('article')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Drain rate' }))
  const settings = screen.getByRole('button', { name: /^Forecast settings/ })
  expect(settings.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('combobox', { name: 'Future usage' })).toBeNull()
  fireEvent.click(settings)
  const bands = screen.getByRole('checkbox', { name: /Show provider bands/ }) as HTMLInputElement
  expect(bands.disabled).toBe(true)
  expect(bands.checked).toBe(true)
  fireEvent.change(screen.getByRole('combobox', { name: 'Future usage' }), { target: { value: 'none' } })
  expect((screen.getByRole('combobox', { name: 'Future usage' }) as HTMLSelectElement).value).toBe('none')
})
it('keeps forecast tuning folded away and counts what differs from the defaults', async () => {
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  await screen.findByRole('article', { name: 'Claude pool' })
  fireEvent.click(screen.getByRole('button', { name: 'Forecast settings' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Projection routing' }), { target: { value: 'fill-first' } })
  fireEvent.click(screen.getByRole('button', { name: '6h' }))
  expect(screen.getByRole('button', { name: 'Forecast settings, 2 changed from default' })).toBeTruthy()
  const reset = screen.getByRole('button', { name: 'Reset to defaults' })
  fireEvent.click(reset)
  expect(reset.isConnected && (reset as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('combobox', { name: 'Projection routing' }) as HTMLSelectElement).value).toBe('soonest-reset')
  expect(screen.getByRole('button', { name: '3h' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Forecast settings' }).getAttribute('aria-expanded')).toBe('true')
})
it('explains missing history and lets the owner retry a failed history load', async () => {
  vi.mocked(getProxyHistory).mockRejectedValueOnce(new Error('Add history to the scoped key.'))
  render(<QuotaGraphs accounts={accounts} onAuthError={() => {}} />)
  expect(await screen.findByText(/Add history to the scoped key/)).toBeTruthy()
  vi.mocked(getProxyHistory).mockResolvedValueOnce({ supported: false, samples: [] })
  fireEvent.click(screen.getByRole('button', { name: 'Retry history' }))
  expect(await screen.findByText(/This proxy has no quota history endpoint/)).toBeTruthy()
  expect(screen.queryByText(/History unavailable/)).toBeNull()
  expect(document.querySelector('path[class*="recordedLine"]')).toBeNull()
})

it('shows only observed seats in history and includes new seats at Now', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    const older = { ...accounts[0], displayName: 'Existing seat', meters: accounts[0].meters.map((m) => ({ ...m, remainingPct: 50 })) }
    const fresh = { ...accounts[0], id: 'claude:proxy:new', displayName: 'New seat', meters: accounts[0].meters.map((m) => ({ ...m, remainingPct: 100 })) }
    vi.mocked(getProxyHistory).mockResolvedValueOnce({ supported: true, samples: [{
      t: now - 2 * 3600_000, accountId: older.id, provider: 'claude', source: 'active',
      windows: {
        five_hour: { used: 50, resetAtMs: now + 3600_000, windowMinutes: 300 },
        seven_day: { used: 50, resetAtMs: now + 3 * 86400_000, windowMinutes: 10080 },
      },
    }] })
    render(<QuotaGraphs accounts={[older, fresh]} onAuthError={() => {}} />)
    const chart = await screen.findByRole('group', { name: /Claude pool chart/i })
    await waitFor(() => expect(chart.querySelector('path[class*="recordedLine"]')).toBeTruthy())
    fireEvent.keyDown(chart, { key: 'ArrowLeft', shiftKey: true })
    const tooltip = await screen.findByRole('status')
    expect(within(tooltip).getAllByText('50%').length).toBeGreaterThan(0)
    expect(within(tooltip).getByText('New seat').parentElement?.textContent).toBe('New seat0%')
    fireEvent.keyDown(chart, { key: 'Home' })
    expect(within(tooltip).getByText('150%')).toBeTruthy()
    expect(within(tooltip).getByText('New seat').parentElement?.textContent).toBe('New seat100%')
  } finally {
    clock.mockRestore()
  }
})

it('omits aggregate history when one contributing provider has no recorded readings', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    const mixed = accounts.map((a, i) => ({
      ...a,
      meters: a.meters.map((m, index) => ({ ...m, remainingPct: index === 0 ? [22, 24][i] : 50 })),
    }))
    vi.mocked(getProxyHistory).mockResolvedValueOnce({ supported: true, samples: [{
      t: now - 2 * 3600_000, accountId: mixed[0].id, provider: 'claude', source: 'active',
      windows: {
        five_hour: { used: 60, resetAtMs: now + 3600_000, windowMinutes: 300 },
        seven_day: { used: 50, resetAtMs: now + 3 * 86400_000, windowMinutes: 10080 },
      },
    }] })
    render(<QuotaGraphs accounts={mixed} onAuthError={() => {}} />)
    const claude = await screen.findByRole('article', { name: 'Claude pool' })
    await waitFor(() => expect(claude.querySelector('path[class*="recordedLine"]')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Together' }))
    const aggregate = screen.getByRole('article')
    expect(within(aggregate).getByText('46%')).toBeTruthy()
    expect(aggregate.querySelector('path[class*="recordedLine"]')).toBeNull()
    expect(aggregate.querySelector('path[class*="projectedLine"]')).toBeTruthy()
    expect(screen.getByText(/Combined history needs recorded readings for every provider/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Drain rate' }))
    expect(aggregate.querySelector('path[class*="recordedLine"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remaining' }))
    fireEvent.click(screen.getByRole('button', { name: 'Separate' }))
    expect(screen.getByRole('article', { name: 'Claude pool' }).querySelector('path[class*="recordedLine"]')).toBeTruthy()
  } finally {
    clock.mockRestore()
  }
})
it("draws Claude's Fable cap as its own line in the weekly view only", async () => {
  const withFable = accounts.map((a) =>
    a.backend === 'claude'
      ? { ...a, meters: [...a.meters, { key: 'weekly_scoped:Fable', remainingPct: 28, resetsAt: now + 3 * 86400_000, windowMinutes: 10080 }] }
      : a,
  ) as ProxyAccount[]
  render(<QuotaGraphs accounts={withFable} onAuthError={() => {}} />)
  const claude = await screen.findByRole('article', { name: 'Claude pool' })
  expect(within(claude).queryByText(/^Fable/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Weekly' }))
  expect(within(claude).getByText('Fable 28%')).toBeTruthy()
  expect(within(screen.getByRole('article', { name: 'Codex pool' })).queryByText(/^Fable/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Drain rate' }))
  expect(within(claude).queryByText(/^Fable/)).toBeNull()
})

it('lists each seat\'s usable, weekly and 5-hour levels on the combined chart', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    const seat = {
      ...accounts[0],
      meters: accounts[0].meters.map((m) => ({ ...m, resetsAt: m.resetsAt + 2 * 3600_000 })),
    }
    render(<QuotaGraphs accounts={[seat]} onAuthError={() => {}} />)
    await screen.findByRole('article', { name: 'Claude pool' })
    fireEvent.click(screen.getByRole('button', { name: 'Combined' }))
    const chart = screen.getByRole('group', { name: /Claude pool chart/i })
    // No history, so the first point with a value is just past Now.
    fireEvent.keyDown(chart, { key: 'Home' })
    fireEvent.keyDown(chart, { key: 'ArrowRight' })
    const tooltip = await screen.findByRole('status')
    const table = within(tooltip).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Account',
      'Usable',
      'Weekly',
      '5-hour',
    ])
    const row = within(table).getByRole('row', { name: /claude seat/ })
    // 50% weekly buys more than the 40% left of the 5-hour window, so the 5-hour one binds.
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      '40%',
      '50%',
      '40% (the limit holding it)',
    ])
    expect(within(tooltip).getByText('Underlined: the limit that sets Usable')).toBeTruthy()
  } finally {
    clock.mockRestore()
  }
})
