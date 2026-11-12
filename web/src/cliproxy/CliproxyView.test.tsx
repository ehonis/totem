/*
 * The CLIProxy tab in the outage it exists to explain: the proxy stopped
 * answering after the poller had read it once, so the tab has only the last
 * readings, without the proxy's own fields. It must show them and say why, not
 * blank the dashboard.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const snapshot = {
  ok: true,
  accounts: [{
    id: 'claude:proxy:a.json', backend: 'claude', label: 'a.json', source: 'cliproxy', displayName: 'a@example.com',
    status: 'ok', state: 'ok', headroomPct: 60, stale: true, meters: [{ key: 'session:', label: '5-hour limit', remainingPct: 60, windowMinutes: 300 }],
  }],
  pools: [{ backend: 'claude', total: 1, usable: 1, bestId: 'claude:proxy:a.json', headroomPct: 60, nextBackAt: null, limited: 0, errors: 0, disabled: 0, proxied: true }],
  proxy: { configured: true, reachable: false, error: 'CLIProxy is unreachable', code: 'unreachable' },
}

vi.mock('../useAiUsageLive', () => ({ useAiUsageLive: () => ({ data: snapshot, err: null, busy: false, forceRefresh: async () => {} }) }))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  getProxyHistory: async () => ({ supported: false, samples: [] }),
  // Exactly what cliproxy/manage.mjs overview() answers when the list call fails.
  getProxy: async () => ({
    configured: true, url: 'http://proxy.example.net:8317', reachable: false, error: 'CLIProxy is unreachable', code: 'unreachable',
    accounts: snapshot.accounts.map((q) => ({ ...q, name: q.label, cooldowns: [], recent: [], successCount: 0, failedCount: 0, note: null, priority: null, weight: null, websockets: null, runtimeOnly: false })),
    pools: snapshot.pools,
  }),
}))

import CliproxyView from './CliproxyView'

afterEach(cleanup)

describe('CliproxyView with the proxy down', () => {
  it('shows the last readings and the outage', async () => {
    render(<CliproxyView onAuthError={() => {}} onNavigate={() => {}} />)
    expect(await screen.findByText(/CLIProxy is not answering/)).toBeTruthy()
    expect(screen.getByText('a@example.com', {selector: 'strong'})).toBeTruthy()
    expect(screen.getAllByText('60% left').length).toBeGreaterThan(0)
  })

  it('survives a row with none of the proxy fields at all', async () => {
    const api = await import('./api')
    vi.spyOn(api, 'getProxy').mockResolvedValueOnce({ configured: true, url: null, reachable: false, error: 'x', accounts: snapshot.accounts as any, pools: snapshot.pools as any })
    render(<CliproxyView onAuthError={() => {}} onNavigate={() => {}} />)
    expect(await screen.findByText('a@example.com', {selector: 'strong'})).toBeTruthy()
  })

  it('keeps rare proxy actions behind the header menu and hands focus back on Escape', async () => {
    render(<CliproxyView onAuthError={() => {}} onNavigate={() => {}} />)
    const more = await screen.findByRole('button', { name: 'More proxy actions' })
    expect(screen.queryByRole('button', { name: 'Refresh login tokens' })).toBeNull()
    fireEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const item = screen.getByRole('button', { name: 'Refresh login tokens' })
    item.focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Refresh login tokens' })).toBeNull()
    expect(document.activeElement).toBe(more)
  })

  it('opens Add login as plain buttons and closes it with Escape', async () => {
    render(<CliproxyView onAuthError={() => {}} onNavigate={() => {}} />)
    const add = await screen.findByRole('button', { name: 'Add login' })
    fireEvent.click(add)
    expect(screen.queryByRole('menu')).toBeNull()
    const claude = screen.getByRole('button', { name: 'Claude' })
    claude.focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Claude' })).toBeNull()
    expect(document.activeElement).toBe(add)
  })
})
