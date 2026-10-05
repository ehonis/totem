import React, { useCallback, useEffect, useRef, useState } from 'react'
import { getInbox, resolveInboxItem, AuthError } from '../api'
import { notifyInboxChanged } from '../useInboxCount'
import { useErrorToast, pushError } from '../toast'
import Markdown from './Markdown'
import {
  Hi, ArrowPathIcon, CheckCircleIcon, XMarkIcon, InboxStackIcon, CalendarDaysIcon,
  DocumentTextIcon, CircleStackIcon, ChevronRightIcon, WarnIcon, TrophyIcon,
  CommandLineIcon,
} from '../icons'

// Per-kind glyph for the destination chip, so "where is this going" reads at a
// glance. Unknown kinds (future sources) fall back to the generic inbox icon.
// `agent` is a retired kind that now files a plain issue, same as `github`.
const KIND_ICON = { todo: DocumentTextIcon, calendar: CalendarDaysIcon, agent: CircleStackIcon, github: CircleStackIcon, goal: TrophyIcon, command: CommandLineIcon, prompt: CommandLineIcon }

// Chips summarise the line; anything long or verbatim (the issue body, the gh
// command, the raw inbox line) belongs in the details drop-down instead.
const CHIP_SKIP = new Set(['when', 'src', 'prompt', 'prompt_ref', 'issue', 'source', 'goal', 'metric'])

function metaEntries(item) {
  const out = []
  if (item.when) out.push(['when', item.when])
  if (item.src) out.push(['src', item.src])
  if (item.meta?.repo) out.push(['repo', item.meta.repo])
  if (item.meta?.type) out.push(['type', item.meta.type])
  for (const [k, v] of Object.entries(item.meta || {})) {
    if (CHIP_SKIP.has(k) || !v || out.some(([seen]) => seen === k)) continue
    out.push([k, v])
  }
  return out
}

// Everything the bridge says accepting will actually do: the payload fields, the
// literal gh command for issues, and the finished issue body rendered as it will
// appear on GitHub. Expanded on demand so the list stays scannable.
function InboxDetails({ item }: { item: any }) {
  const p = item.preview || {}
  const isIssue = Boolean(p.body)
  return (
    <div className="inbox-details">
      {p.summary && <div className="inbox-details-lede">{p.summary}</div>}
      {p.error && <div className="inbox-details-err inline-warn"><WarnIcon /> {p.error}</div>}
      {p.fields?.length > 0 && (
        <dl className="inbox-fields">
          {p.fields.map(([k, v]: [string, string]) => (
            <React.Fragment key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {p.command && (
        <div className="inbox-detail-block">
          <div className="inbox-detail-label">Runs on accept</div>
          <pre className="inbox-command">{p.command}</pre>
        </div>
      )}
      {isIssue && (
        <div className="inbox-detail-block">
          <div className="inbox-detail-label">Issue body</div>
          <div className="inbox-issue-body"><Markdown text={p.body} /></div>
        </div>
      )}
      {item.raw && (
        <div className="inbox-detail-block">
          <div className="inbox-detail-label">Inbox line</div>
          <pre className="inbox-command muted">{item.raw}</pre>
        </div>
      )}
    </div>
  )
}

interface InboxCardProps {
  item: any
  busy: boolean
  focused: boolean
  onResolve: (item: any, action: string) => void
}

function InboxCard({ item, busy, focused, onResolve }: InboxCardProps) {
  const KindIcon = KIND_ICON[item.kind] || InboxStackIcon
  // A card arrived at from a notification opens with its details already showing:
  // the whole point of the deep link is to read what will run before saying yes.
  const [open, setOpen] = useState(focused)
  const detailLabel = item.preview?.body ? 'proposed issue' : 'details'
  return (
    <div className={`inbox-card${open ? ' open' : ''}${focused ? ' focused' : ''}`} id={`inbox-${item.id}`}>
      <div className="inbox-card-row">
        <div className="inbox-card-main">
          <div className="inbox-card-top">
            <span className="inbox-dest" title={`Will be added to ${item.destination}`}>
              <Hi icon={KindIcon} size={13} /> {item.destination}
            </span>
            <span className="inbox-source">{item.source}</span>
            <span className="inbox-id">{item.id}</span>
          </div>
          <div className="inbox-title">{item.title}</div>
          <div className="inbox-meta">
            {metaEntries(item).map(([k, v]) => (
              <span key={k} className="inbox-meta-chip"><span className="inbox-meta-key">{k}</span> {v}</span>
            ))}
            {!item.when && item.kind !== 'github' && item.kind !== 'agent' && (
              <span className="inbox-meta-chip muted">no date</span>
            )}
          </div>
          <button
            type="button"
            className={`inbox-disclose${open ? ' open' : ''}`}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <Hi icon={ChevronRightIcon} size={13} className="inbox-disclose-chevron" />
            {open ? `Hide ${detailLabel}` : `Show ${detailLabel}`}
          </button>
        </div>
        <div className="inbox-actions">
          <button
            className="inbox-btn accept"
            disabled={busy}
            title={`Accept - add to ${item.destination}`}
            onClick={() => onResolve(item, 'accept')}
          >
            <Hi icon={CheckCircleIcon} size={20} />
          </button>
          <button
            className="inbox-btn deny"
            disabled={busy}
            title="Deny - skip this item"
            onClick={() => onResolve(item, 'deny')}
          >
            <Hi icon={XMarkIcon} size={20} />
          </button>
        </div>
      </div>
      {open && <InboxDetails item={item} />}
    </div>
  )
}

interface InboxViewProps {
  onAuthError: () => void
  /** Proposal id from the URL hash — `/inbox#P12`, which is where a release
   *  notification's "tap to update" lands. */
  focusId?: string | null
}

export default function InboxView({ onAuthError, focusId = null }: InboxViewProps) {
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<any>(null)
  const [busyId, setBusyId] = useState<any>(null) // proposal being resolved
  const [notice, setNotice] = useState<any>(null) // success confirmation { text }

  // Surface load failures as a bottom-left toast instead of an inline banner.
  useErrorToast(error)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { items } = await getInbox()
      setItems(items)
      // Keep the sidebar badge in step with the list actually on screen — the
      // badge polls on its own clock and would otherwise sit a minute behind.
      notifyInboxChanged()
    } catch (e) {
      if (e instanceof AuthError) return onAuthError()
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [onAuthError])

  useEffect(() => { load() }, [load])

  // Scroll the deep-linked proposal into view once the list it is in has
  // rendered. Runs on the id, not on every load, so a background refresh does
  // not yank the page back to it while he is reading something else.
  const scrolledTo = useRef<string | null>(null)
  useEffect(() => {
    if (!focusId || loading || scrolledTo.current === focusId) return
    const el = document.getElementById(`inbox-${focusId}`)
    if (!el) return
    scrolledTo.current = focusId
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusId, loading, items])

  const onResolve = useCallback(async (item, action) => {
    setBusyId(item.id)
    setNotice(null)
    try {
      const res = await resolveInboxItem(item.id, action)
      // Drop the resolved item out of the list; it won't come back from the API.
      setItems((prev) => prev.filter((it) => it.id !== item.id))
      notifyInboxChanged()
      setNotice({
        text: action === 'accept'
          ? `Accepted “${item.title}” - ${res.note || `added to ${item.destination}`}`
          : `Skipped “${item.title}”`,
      })
    } catch (e) {
      if (e instanceof AuthError) return onAuthError()
      pushError(`Couldn't ${action} “${item.title}”: ${e.message}`)
    } finally {
      setBusyId(null)
    }
  }, [onAuthError])

  return (
    <div className="view">
      <div className="view-head">
        <h1>Inbox {items.length ? <span className="muted">· {items.length}</span> : null}</h1>
        <button className="btn compact" onClick={load} title="Refresh">
          <Hi icon={ArrowPathIcon} size={15} />
        </button>
      </div>

      <p className="inbox-lede muted">
        Proposals waiting on your yes/no. Accept adds the item to its destination; deny skips it.
        Every item is already written in full — open its details to read the exact task, event, or
        GitHub issue that gets created.
      </p>

      {notice && (
        <div className="inbox-notice ok">
          {notice.text}
          <button className="link-btn" onClick={() => setNotice(null)}>dismiss</button>
        </div>
      )}

      {loading ? (
        <div className="empty">Loading proposals…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          <Hi icon={InboxStackIcon} size={28} /><br />
          Inbox zero. Nothing waiting on your decision.
        </div>
      ) : (
        <div className="inbox-list">
          {/* Disable every card's buttons while any resolve is in flight, so a
              second click can't race the first against the same inbox file. */}
          {items.map((item) => (
            <InboxCard
              key={item.id}
              item={item}
              busy={busyId !== null}
              focused={item.id === focusId}
              onResolve={onResolve}
            />
          ))}
        </div>
      )}
    </div>
  )
}
