import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DownloadActivity from './components/DownloadActivity'
import { downloads, installDownloadLinks } from './downloads'

let uninstall: () => void
beforeEach(() => {
  localStorage.clear()
  delete window.__TOTEM_DESKTOP__
  vi.stubGlobal('showSaveFilePicker', undefined)
  uninstall = installDownloadLinks()
})
afterEach(() => {
  uninstall()
  cleanup()
  for (const d of downloads.getSnapshot()) { downloads.cancel(d.id); downloads.dismiss(d.id) }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('intercepts download links from every route and shows immediate cancellable activity', () => {
  vi.stubGlobal('fetch', () => new Promise(() => {}))
  render(<><a href="/api/chat/files/raw?path=%2Ftmp%2Freport.csv&download=1" download="report.csv"><span>Download file</span></a><DownloadActivity /></>)
  fireEvent.click(screen.getByText('Download file'))
  expect(screen.getByRole('region', { name: 'Downloads' })).toBeVisible()
  expect(screen.getByText('report.csv')).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent('Starting')
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel report.csv' }))
  expect(screen.getByRole('status')).toHaveTextContent('Cancelled')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss report.csv' }))
  expect(screen.queryByRole('region', { name: 'Downloads' })).toBeNull()
})

it('shows HTTP failures and a working retry instead of downloading an error page', async () => {
  let failing = true
  vi.stubGlobal('fetch', async () => failing ? new Response('missing', { status: 404 }) : new Promise(() => {}))
  render(<DownloadActivity />)
  act(() => { downloads.start('/api/chat/uploads/fictional?sig=fixture', 'notes.txt') })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Download failed'))
  expect(screen.getByText(/no longer available/i)).toBeVisible()
  failing = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry download' }))
  expect(screen.getByRole('status')).toHaveTextContent('Starting')
})

it('keeps multiple files visible and measures known totals without announcing every byte', async () => {
  let stream: ReadableStreamDefaultController<Uint8Array>
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(c) { stream = c } }), { headers: { 'content-length': '8' } }))
  render(<DownloadActivity />)
  act(() => { downloads.start('/api/chat/uploads/first?sig=fixture', 'first.csv') })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Downloading'))
  await act(async () => { stream!.enqueue(new Uint8Array(4)) })
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
  expect(screen.getByRole('status')).not.toHaveTextContent('50')
  act(() => { downloads.start('/api/chat/uploads/second?sig=fixture', 'second.csv') })
  expect(screen.getByText('first.csv')).toBeVisible()
  expect(screen.getByText('second.csv')).toBeVisible()
})

it('leaves modified clicks and preview links alone', () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  render(<><a href="/api/chat/uploads/fixture" download="notes.txt">Download</a><a href="/api/chat/uploads/fixture" onClick={(e) => e.preventDefault()}>Preview</a><DownloadActivity /></>)
  const link = screen.getByText('Download')
  link.addEventListener('click', (e) => e.preventDefault())
  fireEvent.click(link, { ctrlKey: true })
  fireEvent.click(screen.getByText('Preview'))
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.queryByRole('region', { name: 'Downloads' })).toBeNull()
})

it('shows a saved desktop download in its folder', async () => {
  window.__TOTEM_DESKTOP__ = { downloads: true }
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const reveal = vi.spyOn(downloads, 'reveal').mockImplementation(() => {})
  render(<DownloadActivity />)
  act(() => { downloads.start('blob:http://localhost/recording', 'recording.m4a') })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Downloading'))
  expect(screen.queryByRole('button', { name: /Show in/ })).toBeNull()
  act(() => { downloads.nativeEvent({ url: 'blob:http://localhost/recording', state: 'saved', reveal: true }) })
  fireEvent.click(screen.getByRole('button', { name: 'Show in folder: recording.m4a' }))
  expect(reveal).toHaveBeenCalledTimes(1)
})
