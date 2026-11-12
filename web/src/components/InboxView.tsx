import React, { useCallback, useEffect, useRef, useState } from 'react'
import { getInbox, resolveInboxItem, releaseInboxItem, getApprovalCodeStatus, AuthError, ApiError } from '../api'
import { approvalBanner, useHasApprovalCode, APPROVAL_REFUSALS, type ApprovalCodeStatus } from '../approvalCode'
import { notifyInboxChanged } from '../useInboxCount'
import { useErrorToast, pushError, pushSuccess } from '../toast'
import { copyText } from '../clipboard'
import IconBrandLinkedin from '@tabler/icons-react/dist/esm/icons/IconBrandLinkedin.mjs'
import Markdown from './Markdown'
import {
  Hi, ArrowPathIcon, CheckCircleIcon, XMarkIcon, InboxStackIcon, CalendarDaysIcon,
  DocumentTextIcon, CircleStackIcon, ChevronRightIcon, WarnIcon, TrophyIcon,
  CommandLineIcon, ChatBubbleOvalLeftIcon, EnvelopeIcon, PaperAirplaneIcon, PencilSquareIcon, GlobeAltIcon,
  ArrowTopRightOnSquareIcon, ClipboardDocumentIcon,
} from '../icons'

// Tabler's stroke is 2; Heroicons' outline is 1.5, so the two sit together at 1.5.
const LinkedinIcon = (props: any) => <IconBrandLinkedin stroke={1.5} {...props} />

// Per-kind glyph for the destination chip, so "where is this going" reads at a
// glance. Unknown kinds (future sources) fall back to the generic inbox icon.
// `agent` is a retired kind that now files a plain issue, same as `github`.
export const KIND_ICON: Record<string, any> = { todo: DocumentTextIcon, calendar: CalendarDaysIcon, agent: CircleStackIcon, github: CircleStackIcon, goal: TrophyIcon, command: CommandLineIcon, prompt: CommandLineIcon, imessage: ChatBubbleOvalLeftIcon, email: EnvelopeIcon, away: GlobeAltIcon, linkedin: LinkedinIcon }

// Chips summarise the line; anything long or verbatim (the issue body, the gh
// command, the raw inbox line) belongs in the details drop-down instead.
// For a drafted message, `recipient` is the chip; `to` (a chat guid) and the text
// file path are noise.
// An email's file path is noise too; the email itself is shown in full below.
// `thread` and `run` name the chat that staged it, linked on the card instead.
// A LinkedIn card's link and file are shown on the card itself.
const CHIP_SKIP = new Set(['when', 'src', 'prompt', 'prompt_ref', 'issue', 'source', 'goal', 'metric', 'to', 'message', 'email', 'thread', 'run', 'card', 'target'])

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

// A staged email laid out the way it will arrive: subject, the address lines,
// the body exactly as written, and the message it answers quoted underneath, as
// a mail client would. Plain text only, so this is precisely what is sent.
function EmailPreview({ email }: { email: any }) {
  const q = email.inReplyTo
  return (
    <div className="inbox-email">
      <div className="inbox-email-subject">{email.subject}</div>
      <dl className="inbox-email-head">
        <dt>From</dt><dd>{email.from || email.account}</dd>
        <dt>To</dt><dd>{email.to}</dd>
        {email.cc && <><dt>Cc</dt><dd>{email.cc}</dd></>}
        {email.bcc && <><dt>Bcc</dt><dd>{email.bcc}</dd></>}
      </dl>
      <div className="inbox-email-body">{email.body}</div>
      {q && (
        <div className="inbox-email-quote">
          <div className="inbox-email-quote-head">On {q.date || 'an earlier date'}, {q.from || 'they'} wrote:</div>
          {q.snippet}
        </div>
      )}
    </div>
  )
}

// Something to do on LinkedIn, which the owner does himself: what they wrote, the
// draft (his to edit before copying; nothing here sends it), and the link. Totem
// never acts on LinkedIn, so Open and Copy are the whole of the action; the card's
// Mark done only records that he did it.
export function LinkedinCard({ card }: { card: { action: string; url: string; author: string; excerpt?: string; draft?: string } }) {
  const [draft, setDraft] = useState(card.draft || '')
  useEffect(() => { setDraft(card.draft || '') }, [card.draft])
  const copy = async () => {
    if (await copyText(draft)) pushSuccess('Copied. Paste it on LinkedIn.')
    else pushError('Could not copy; select the text and copy it yourself.')
  }
  const what = { like: 'Like this post', repost: 'Repost this', comment: 'Comment on this post', reply: 'Reply', connect: 'Send a connection request' }[card.action] || card.action
  return (
    <div className="inbox-email inbox-linkedin">
      <div className="inbox-email-subject">{what}</div>
      <div className="inbox-linkedin-author">{card.author}</div>
      {card.excerpt && <div className="inbox-email-quote">{card.excerpt}</div>}
      {card.action !== 'like' && (
        <label className="inbox-linkedin-draft">
          <span className="inbox-detail-label">{card.action === 'connect' ? 'Note (optional, 300 characters)' : card.action === 'repost' ? 'Your words (optional)' : 'Draft, yours to edit'}</span>
          {/* Sized for a phone's width; a wider screen just has room to spare. */}
          <textarea value={draft} rows={Math.min(8, Math.max(3, Math.ceil(draft.length / 40) + 1))} onChange={(e) => setDraft(e.target.value)} />
        </label>
      )}
      <div className="inbox-linkedin-actions">
        <a className="btn compact" href={card.url} target="_blank" rel="noopener noreferrer"><Hi icon={ArrowTopRightOnSquareIcon} size={14} /> Open on LinkedIn</a>
        {card.action !== 'like' && draft.trim() && (
          <button type="button" className="btn compact" onClick={() => void copy()}><Hi icon={ClipboardDocumentIcon} size={14} /> Copy {card.action === 'connect' ? 'note' : card.action === 'reply' ? 'reply' : 'text'}</button>
        )}
      </div>
    </div>
  )
}

// Everything the bridge says accepting will actually do: the payload fields, the
// literal gh command for issues, and the finished issue body rendered as it will
// appear on GitHub. Expanded on demand so the list stays scannable.
export function InboxDetails({ item }: { item: any }) {
  const p = item.preview || {}
  const isMessage = item.kind === 'imessage'
  const isIssue = Boolean(p.body) && !isMessage
  return (
    <div className="inbox-details">
      {p.summary && <div className="inbox-details-lede">{p.summary}</div>}
      {p.error && <div className="inbox-details-err inline-warn"><WarnIcon /> {p.error}</div>}
      {p.email && <EmailPreview email={p.email} />}
      {p.linkedin && <LinkedinCard card={p.linkedin} />}
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
      {isMessage && p.body && (
        <div className="inbox-detail-block">
          <div className="inbox-detail-label">Message, exactly as it will be sent</div>
          <pre className="inbox-command" style={{ whiteSpace: 'pre-wrap' }}>{p.body}</pre>
        </div>
      )}
      {isIssue && (
        <div className="inbox-detail-block">
          <div className="inbox-detail-label">{item.kind === 'prompt' ? 'Prompt' : 'Issue body'}</div>
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
  /** For a held card: show it with the open ones after all. */
  onRelease?: (item: any) => void
}

function InboxCard({ item, busy, focused, onResolve, onRelease }: InboxCardProps) {
  const KindIcon = KIND_ICON[item.kind] || InboxStackIcon
  // A card arrived at from a notification opens with its details already showing:
  // the whole point of the deep link is to read what will run before saying yes.
  // An email opens showing itself: reading it is the decision.
  const isEmail = item.kind === 'email'
  // A LinkedIn card opens showing its draft and link too: they are the action.
  const isLinkedin = item.kind === 'linkedin'
  const [open, setOpen] = useState(focused || isEmail || isLinkedin)
  const isPrompt = item.kind === 'prompt'
  // Refused (a hidden character) or unreadable as staged: the bridge refuses the
  // accept, and never reads the file again to send it, so there is nothing to accept.
  const blocked = Boolean(item.refused || item.preview?.error)
  const detailLabel = item.kind === 'imessage' ? 'message' : isEmail ? 'email' : isPrompt ? 'prompt' : isLinkedin ? 'post and draft' : item.preview?.body ? 'proposed issue' : 'details'
  // A prompt is accepted by opening it as a new T3 Code thread. The tab opens in
  // the click itself, before the resolve call, or Safari blocks it as a popup.
  const t3Url: string | undefined = isPrompt ? item.preview?.openUrl : undefined
  const accept = () => {
    if (t3Url) window.open(t3Url, '_blank', 'noopener')
    onResolve(item, 'accept')
  }
  return (
    <div className={`inbox-card${open ? ' open' : ''}${focused ? ' focused' : ''}`} id={`inbox-${item.id}`}>
      <div className="inbox-card-row">
        <div className="inbox-card-main">
          <div className="inbox-card-top">
            <span className="inbox-dest" title={`Will be added to ${item.destination}`}>
              <Hi icon={KindIcon} size={13} /> {item.destination}
            </span>
            <span className="inbox-source">{item.source}</span>
            {item.chat && <a className="inbox-source" href={`/chat?thread=${encodeURIComponent(item.chat.threadId)}`} title="Open the chat that asked; it hears what you decide">from a chat</a>}
            <span className="inbox-id">{item.id}</span>
          </div>
          <div className="inbox-title">{item.title}</div>
          {item.refused && <div className="inbox-details-err inline-warn"><WarnIcon /> Refused: {item.refused}</div>}
          {item.held && (
            <div className="inbox-meta-chip muted">
              You denied the same proposal ({item.held.id}) on {new Date(item.held.deniedAt).toLocaleDateString()}, so it is not asking again.
            </div>
          )}
          <div className="inbox-meta">
            {metaEntries(item).map(([k, v]) => (
              <span key={k} className="inbox-meta-chip"><span className="inbox-meta-key">{k}</span> {v}</span>
            ))}
            {!item.when && item.kind !== 'github' && item.kind !== 'agent' && !isEmail && !isLinkedin && (
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
          {item.held && onRelease ? (
            <button className="btn compact" disabled={busy} title="Decide it after all" onClick={() => onRelease(item)}>Show anyway</button>
          ) : (
          <button
            className="inbox-btn accept"
            disabled={busy || (isPrompt && !t3Url) || blocked}
            title={item.kind === 'imessage' ? `Send this message to ${item.meta?.recipient || 'them'}`
              : isEmail ? `Send this email to ${item.meta?.recipient || 'them'} now`
                : isPrompt ? 'Open this prompt in a new T3 Code thread'
                  : isLinkedin ? 'Mark done - you did it on LinkedIn' : `Accept - add to ${item.destination}`}
            aria-label={isEmail ? 'Send email' : isPrompt ? 'Open in T3 Code' : isLinkedin ? 'Mark done' : 'Accept'}
            onClick={accept}
          >
            <Hi icon={isEmail ? PaperAirplaneIcon : CheckCircleIcon} size={20} />
          </button>
          )}
          {isEmail && !item.held && !blocked && (
            <button
              className="inbox-btn draft"
              disabled={busy}
              title={`Save as a draft in ${item.meta?.account || 'Gmail'} instead, to finish and send from Gmail`}
              aria-label="Save as draft"
              onClick={() => onResolve(item, 'draft')}
            >
              <Hi icon={PencilSquareIcon} size={19} />
            </button>
          )}
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
  const [approval, setApproval] = useState<ApprovalCodeStatus | null>(null)
  const hasCode = useHasApprovalCode()

  // Surface load failures as a bottom-left toast instead of an inline banner.
  useErrorToast(error)

  const loadApproval = useCallback(() => { getApprovalCodeStatus().then(setApproval).catch(() => {}) }, [])
  useEffect(() => { loadApproval() }, [loadApproval])

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
      const res = await resolveInboxItem(item.id, action, item.digest)
      // Drop the resolved item out of the list; it won't come back from the API.
      setItems((prev) => prev.filter((it) => it.id !== item.id))
      notifyInboxChanged()
      setNotice({
        text: action === 'accept'
          ? item.kind === 'linkedin' ? `Marked done: “${item.title}”`
            : `${item.kind === 'email' ? 'Sent' : 'Accepted'} “${item.title}” - ${res.note || `added to ${item.destination}`}`
          : action === 'draft'
            ? `Saved “${item.title}” as a draft - ${res.note}`
            : `Skipped “${item.title}”`,
      })
    } catch (e) {
      if (e instanceof AuthError) return onAuthError()
      // Refused by the approval gate: the banner says what this device is missing.
      if (e instanceof ApiError && APPROVAL_REFUSALS.has(e.code)) loadApproval()
      pushError(`Couldn't ${action} “${item.title}”: ${e.message}`)
      // It may have changed, been held, or been settled as uncertain: show it as it is now.
      load()
    } finally {
      setBusyId(null)
    }
  }, [onAuthError, loadApproval, load])

  const onRelease = useCallback(async (item) => {
    setBusyId(item.id)
    try {
      await releaseInboxItem(item.id)
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, held: null } : it)))
      notifyInboxChanged()
    } catch (e) {
      if (e instanceof AuthError) return onAuthError()
      pushError(`Couldn't show “${item.title}”: ${e.message}`)
    } finally {
      setBusyId(null)
    }
  }, [onAuthError])

  const waiting = items.filter((it) => !it.held)
  const held = items.filter((it) => it.held)
  const banner = approvalBanner(approval, hasCode)

  return (
    <div className="view">
      <div className="view-head">
        <h1>Inbox {waiting.length ? <span className="muted">· {waiting.length}</span> : null}</h1>
        <button className="btn compact" onClick={load} title="Refresh">
          <Hi icon={ArrowPathIcon} size={15} />
        </button>
      </div>

      <p className="inbox-lede muted">
        Proposals waiting on your yes/no. Accept adds the item to its destination; deny skips it.
        Every item is already written in full — open its details to read the exact task, event, or
        GitHub issue that gets created.
      </p>

      {banner && (
        <div className={`inbox-notice${banner.tone === 'warn' ? ' err' : ''}`}>
          <WarnIcon /> {banner.text} <a className="link-btn" href="/settings/security#approval-code">Settings → Security → Approval code</a>
        </div>
      )}

      {notice && (
        <div className="inbox-notice ok">
          {notice.text}
          <button className="link-btn" onClick={() => setNotice(null)}>dismiss</button>
        </div>
      )}

      {loading ? (
        <div className="empty">Loading proposals…</div>
      ) : waiting.length === 0 && held.length === 0 ? (
        <div className="empty">
          <Hi icon={InboxStackIcon} size={28} /><br />
          Inbox zero. Nothing waiting on your decision.
        </div>
      ) : (
        <div className="inbox-list">
          {/* Disable every card's buttons while any resolve is in flight, so a
              second click can't race the first against the same inbox file. */}
          {waiting.map((item) => (
            <InboxCard
              key={item.id}
              item={item}
              busy={busyId !== null}
              focused={item.id === focusId}
              onResolve={onResolve}
            />
          ))}
          {held.length > 0 && (
            <>
              <div className="inbox-detail-label">Held · {held.length}</div>
              <p className="inbox-lede muted">Proposals you denied in the last week, made again. They stay here instead of asking you twice.</p>
              {held.map((item) => (
                <InboxCard
                  key={item.id}
                  item={item}
                  busy={busyId !== null}
                  focused={item.id === focusId}
                  onResolve={onResolve}
                  onRelease={onRelease}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
