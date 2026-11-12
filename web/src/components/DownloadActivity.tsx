import React, { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { downloadActive, downloads } from '../downloads'
import { desktopRevealLabel as revealLabel } from '../desktop'
import './downloads.css'

const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`

export default function DownloadActivity() {
  const rows = useSyncExternalStore(downloads.subscribe, downloads.getSnapshot)
  if (!rows.length) return null
  return createPortal(
    <section className="downloads" aria-label="Downloads">
      <header><strong>Downloads</strong><span>{rows.filter(downloadActive).length} active</span></header>
      <ul>{rows.slice().reverse().map((d) => {
        const active = downloadActive(d)
        const native = downloads.isNative(d.id)
        const percent = d.total && !native ? Math.min(100, Math.floor(d.received / d.total * 100)) : null
        const status = d.state === 'starting' ? 'Starting download…' : d.state === 'transferring' ? 'Downloading…' : d.state === 'saved' ? 'Saved' : d.state === 'handed-off' ? 'Sent to Downloads' : d.state === 'cancelled' ? 'Cancelled' : 'Download failed'
        return <li key={d.id} className={d.state}>
          <div className="download-title"><strong title={d.name}>{d.name}</strong>
            {active ? !native && <button type="button" onClick={() => downloads.cancel(d.id)} aria-label={`Cancel ${d.name}`}>Cancel</button>
              : <button type="button" onClick={() => downloads.dismiss(d.id)} aria-label={`Dismiss ${d.name}`}>Dismiss</button>}
          </div>
          <span className="download-status" role="status" aria-label={d.name}>{status}</span>
          {active && <>
            <div className={`download-meter${percent === null ? ' indeterminate' : ''}`} role="progressbar" aria-label={`Downloading ${d.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? 'Download in progress; total size unknown' : `${percent}%`}>
              <span style={{ width: percent === null ? '35%' : `${percent}%` }} />
            </div>
            {!native && d.received > 0 && <span className="download-detail">{bytes(d.received)}{d.total !== null && ` of ${bytes(d.total)}`}{percent !== null && ` · ${percent}%`}</span>}
          </>}
          {d.message && <p>{d.message}</p>}
          {d.state === 'saved' && d.reveal && <button type="button" className="download-action" onClick={() => downloads.reveal(d.id)} aria-label={`${revealLabel()}: ${d.name}`}>{revealLabel()}</button>}
          {(d.state === 'error' || d.state === 'cancelled') && <button type="button" className="download-action" onClick={() => downloads.retry(d.id)}>Retry download</button>}
        </li>
      })}</ul>
    </section>, document.body,
  )
}
