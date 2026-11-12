import type { SheetFeed } from '../todos/types'

// Settings -> Tasks › Task sheet: the read-only feed's state in one line (set up or
// not, when it was last read, and any error). docs/task-sheet.md.

function ago(iso: string, now: number) {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function sheetFeedLine(feed: SheetFeed, now = Date.now()): string {
  if (feed.configured === false) return `Not set up. ${feed.reason || ''}`.trim()
  const rows = `${feed.items.length} open ${feed.items.length === 1 ? 'row' : 'rows'}`
  const read = feed.fetchedAt ? `read ${ago(feed.fetchedAt, now)}` : ''
  if (feed.error) return `${read ? `Showing ${rows} ${read}.` : 'Not read yet.'} Last read failed: ${feed.error}`
  return `${rows[0].toUpperCase()}${rows.slice(1)} for you, ${read || 'not read yet'}.`
}
