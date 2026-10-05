/**
 * The bell.
 *
 * Every notification Totem has raised, whether or not it ever reached a phone —
 * a push that could not be delivered is not an event that did not happen — plus
 * what it is *about* to say, and the thumbs that teach it.
 *
 * The rating is the point of the panel. A downvote asks one optional follow-up as
 * chips, because "I disliked this" does not say whether the fact was wrong, the
 * timing was wrong, the wording was wrong, or there were simply too many that
 * day, and those four have opposite fixes. An upvote is one tap with no
 * follow-up: asking for detail on a good notification taxes the behaviour you
 * want.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Hi, BellAlertIcon, XMarkIcon, HandThumbUpIcon, HandThumbDownIcon, ClockIcon } from '../icons'
import {
  getNotificationHistory, markNotificationsRead, rateNotification,
  DOWNVOTE_REASONS, type HistoryItem, type Upcoming,
} from '../push'

const when = (ts: number) => {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const until = (ts: number) => {
  const diff = ts - Date.now()
  if (diff <= 0) return 'any moment'
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `at ${new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

export default function NotificationCenter({ open, onClose, onNavigate }: {
  open: boolean
  onClose: () => void
  onNavigate?: (url: string) => void
}) {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [upcoming, setUpcoming] = useState<Upcoming[]>([])
  const [rating, setRating] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const data = await getNotificationHistory()
      setItems(data.items)
      setUpcoming(data.upcoming)
    } catch {
      // The bell is not worth an error screen; an empty list reads the same as a
      // quiet week, and the Logs tab is where a real failure gets diagnosed.
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    // Mark read on open rather than per item: the badge is "is there anything
    // new", not a to-do list.
    const timer = setTimeout(() => { void markNotificationsRead().then(refresh) }, 1200)
    return () => clearTimeout(timer)
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const vote = async (item: HistoryItem, v: 'up' | 'down', reasons: string[] = []) => {
    setBusy(true)
    // Optimistic: the rating is advisory and a failed write is not worth a modal.
    setItems((prev) => prev.map((i) => i.id === item.id
      ? { ...i, feedback: { vote: v, reasons, at: Date.now() } }
      : i))
    try { await rateNotification(item, v, reasons) } catch { /* advisory */ }
    setRating(null)
    setBusy(false)
    void refresh()
  }

  return (
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <aside className="notif-panel" role="dialog" aria-label="Notifications">
        <header className="notif-head">
          <strong><Hi icon={BellAlertIcon} size={16} /> Notifications</strong>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Hi icon={XMarkIcon} size={16} />
          </button>
        </header>

        {upcoming.length > 0 && (
          <>
            <div className="notif-section"><Hi icon={ClockIcon} size={13} /> Coming up</div>
            {upcoming.map((u) => (
              <div className="notif-row upcoming" key={u.id}>
                <div className="notif-copy">
                  <strong>{u.title}</strong>
                  {u.body && <span>{u.body}</span>}
                </div>
                <span className="notif-when">{until(u.deliverAt)}</span>
              </div>
            ))}
          </>
        )}

        <div className="notif-section">Sent</div>
        {items.length === 0 && (
          <div className="notif-empty">
            Nothing yet. Totem only speaks when it has something specific to say.
          </div>
        )}

        {items.map((item) => (
          <div className={`notif-row${item.read ? '' : ' unread'}`} key={item.id}>
            <div className="notif-copy">
              <strong
                className={item.url ? 'linked' : undefined}
                onClick={() => item.url && onNavigate?.(item.url)}
              >
                {item.title}
              </strong>
              {item.body && <span>{item.body}</span>}
              <span className="notif-meta">
                {when(item.ts)}
                {item.openedAt ? ' · opened' : ''}
                {item.state === 'failed' ? ' · not delivered' : ''}
              </span>

              {rating === item.id && (
                <div className="notif-reasons">
                  <span className="notif-reason-ask">What was wrong with it?</span>
                  {DOWNVOTE_REASONS.map((r) => (
                    <button
                      key={r.id}
                      className="notif-chip"
                      title={r.hint}
                      disabled={busy}
                      onClick={() => vote(item, 'down', [r.id])}
                    >
                      {r.label}
                    </button>
                  ))}
                  {/* Skipping the detail still records the downvote — a thumb with
                      no reason is worth more than a thumb nobody gave. */}
                  <button className="notif-chip ghost" disabled={busy} onClick={() => vote(item, 'down')}>
                    Just less of this
                  </button>
                </div>
              )}
            </div>

            {item.ratable && (
              <div className="notif-vote">
                <button
                  className={`icon-btn${item.feedback?.vote === 'up' ? ' on' : ''}`}
                  aria-label="Useful"
                  disabled={busy}
                  onClick={() => vote(item, 'up')}
                >
                  <Hi icon={HandThumbUpIcon} size={15} />
                </button>
                <button
                  className={`icon-btn${item.feedback?.vote === 'down' ? ' on down' : ''}`}
                  aria-label="Not useful"
                  disabled={busy}
                  onClick={() => setRating(rating === item.id ? null : item.id)}
                >
                  <Hi icon={HandThumbDownIcon} size={15} />
                </button>
              </div>
            )}
          </div>
        ))}
      </aside>
    </>
  )
}
