// An inbox proposal this chat's agent staged, in the reply that staged it
// (chat/inbox-outcome.mjs on the bridge). Pending, it is the Inbox card in the
// chat's own approval style: what accepting does, its details, and Deny, Accept
// (Send, Open in T3 Code) and Save as draft, through the Inbox's own resolve
// route with this device's approval code. The note goes to the agent with the
// decision; Reply sends it alone and leaves the proposal open. Decided, it is
// one line saying what happened, and the agent hears it as the owner's message.
import { useEffect, useState } from 'react'
import { getInbox, releaseInboxItem, replyInboxItem, resolveInboxItem, ApiError } from '../api'
import { APPROVAL_REFUSALS } from '../approvalCode'
import { notifyInboxChanged } from '../useInboxCount'
import { pushError } from '../toast'
import { InboxDetails, LinkedinCard } from '../components/InboxView'
import type { InboxPart } from './types'
import { getState, patchMessagePart, resumeRuns, syncThreads } from './store'
import { inboxOutcome, resultOf, statusFor } from './inboxCards'
import { TI } from './ui'
import { IconArrowBackUp, IconChevronRight, IconShield, IconShieldCheck, IconShieldX } from './icons'

// One listing shared by every card on screen, refreshed when it is a few seconds old.
let listing: { at: number; items: Promise<any[]> } | null = null
function inboxItems(fresh = false): Promise<any[]> {
  if (fresh || !listing || Date.now() - listing.at > 5000) {
    const items = getInbox().then((r: any) => r.items || [])
    listing = { at: Date.now(), items }
    items.catch(() => { listing = null })
  }
  return listing.items
}

/** One proposal, from the shared listing, or a fresh one when it was staged after that was read. */
async function findItem(id: string): Promise<any | null> {
  return (await inboxItems()).find((x) => x.id === id) || (await inboxItems(true)).find((x) => x.id === id) || null
}

/** The bridge starts the chat's next turn just after answering; pick it up here. */
function followTheChat() {
  setTimeout(() => { syncThreads().then(resumeRuns) }, 700)
}

export default function InboxCardRow({ part, messageId }: { part: InboxPart; messageId: string }) {
  const pending = part.status === 'pending'
  const [item, setItem] = useState<any>(null)
  const [missing, setMissing] = useState(false)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!pending) return
    let live = true
    findItem(part.id).then((found) => {
      if (!live) return
      setItem(found)
      setMissing(!found)
    }).catch(() => {})
    return () => { live = false }
  }, [pending, part.id])

  if (!pending) {
    const ok = part.status === 'accepted' || part.status === 'draft'
    return (
      <div className={`vc-approval settled ${ok ? 'approved' : part.status === 'denied' ? 'declined' : ''}`} title={`Inbox ${part.id}`}>
        <span className="vc-approval-icon"><TI icon={ok ? IconShieldCheck : IconShieldX} size={15} /></span>
        <span className="vc-approval-line"><span className="vc-approval-title">{part.title}</span></span>
        <span className="vc-approval-outcome">{inboxOutcome(part)}</span>
      </div>
    )
  }

  const threadId = getState().activeId
  const isEmail = part.kind === 'email'
  const t3Url: string | undefined = part.kind === 'prompt' ? item?.preview?.openUrl : undefined
  const blocked = !item || Boolean(item.refused || item.preview?.error) || (part.kind === 'prompt' && !t3Url)
  const words = note.trim()

  const decide = async (action: 'accept' | 'deny' | 'draft') => {
    if (busy || !item || !threadId) return
    // A prompt is accepted by opening it in T3 Code, in the click itself (Safari blocks it otherwise).
    if (action === 'accept' && t3Url) window.open(t3Url, '_blank', 'noopener')
    setBusy(true)
    try {
      const res: any = await resolveInboxItem(item.id, action, item.digest, words || undefined)
      const result = action === 'deny' ? '' : resultOf(res?.note)
      patchMessagePart(threadId, messageId, part.id, { status: statusFor(action), ...(words ? { note: words } : {}), ...(result ? { result } : {}), decidedAt: Date.now() })
      notifyInboxChanged()
      listing = null
      followTheChat()
    } catch (e: any) {
      const fix = e instanceof ApiError && APPROVAL_REFUSALS.has(e.code) ? ' Set this device’s approval code in Settings → Security.' : ''
      pushError(`Couldn't ${action === 'deny' ? 'deny' : action === 'draft' ? 'save' : 'accept'} “${part.title}”: ${e.message}${fix}`)
      // It may have changed, been held, or been settled elsewhere: show it as it is now.
      inboxItems(true).then((items) => { const found = items.find((x) => x.id === part.id); setItem(found || null); setMissing(!found) }).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const reply = async () => {
    if (busy || !words || !threadId) return
    setBusy(true)
    try {
      await replyInboxItem(part.id, words)
      setNote('')
      followTheChat()
    } catch (e: any) {
      pushError(`Couldn't send your reply: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const release = async () => {
    setBusy(true)
    try {
      await releaseInboxItem(part.id)
      setItem((x: any) => (x ? { ...x, held: null } : x))
      notifyInboxChanged()
    } catch (e: any) {
      pushError(`Couldn't show “${part.title}”: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vc-approval pending vc-inbox-card" role="group" aria-label={`Inbox proposal ${part.id}`}>
      <div className="vc-approval-head">
        <span className="vc-approval-icon"><TI icon={IconShield} size={15} /></span>
        <span className="vc-approval-title">{part.title}<span className="vc-approval-app"> · {item?.destination || part.kind} · {part.id}</span></span>
      </div>
      {item?.preview?.summary && <div className="vc-approval-reason">{item.preview.summary}</div>}
      {item?.refused && <div className="vc-approval-reason vc-inbox-warn">Refused: {item.refused}</div>}
      {item?.held && <div className="vc-approval-reason">You denied the same proposal ({item.held.id}) on {new Date(item.held.deniedAt).toLocaleDateString()}, so it is not asking again.</div>}
      {missing && <div className="vc-approval-reason">Not in the Inbox any more: it was decided elsewhere, or is still being written. <a href={`/inbox#${part.id}`}>Open the Inbox</a></div>}
      {item && (
        <button type="button" className={`vc-inbox-disclose${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <TI icon={IconChevronRight} size={13} />{open ? 'Hide details' : 'Show details'}
        </button>
      )}
      {/* A LinkedIn card's post, draft and link are the action itself, so they show without opening. */}
      {!open && item?.preview?.linkedin && <div className="vc-inbox-details"><LinkedinCard card={item.preview.linkedin} /></div>}
      {open && item && <div className="vc-inbox-details"><InboxDetails item={item} /></div>}
      {item && (
        <textarea
          className="vc-inbox-note"
          rows={1}
          value={note}
          maxLength={2000}
          placeholder="Note for the agent (optional), sent with your decision or on its own with Reply"
          aria-label="Note for the agent"
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <div className="vc-approval-actions">
        <span className="vc-approval-waiting"><TI icon={IconShield} size={13} />Waiting for your approval</span>
        {item && <span className="vc-approval-dot" aria-hidden>·</span>}
        {item?.held ? (
          <button type="button" className="vc-approval-btn" disabled={busy} onClick={() => void release()}>Show anyway</button>
        ) : item && (
          <>
            <button type="button" className="vc-approval-btn" disabled={busy} onClick={() => void decide('deny')}>Deny</button>
            {isEmail && !blocked && <button type="button" className="vc-approval-btn" disabled={busy} onClick={() => void decide('draft')}>Save as draft</button>}
            <button type="button" className="vc-approval-btn primary" disabled={busy || blocked} onClick={() => void decide('accept')}>
              {isEmail ? 'Send' : part.kind === 'imessage' ? 'Send' : part.kind === 'prompt' ? 'Open in T3 Code' : part.kind === 'linkedin' ? 'Mark done' : 'Accept'}
            </button>
          </>
        )}
        {item && (
          <button type="button" className="vc-approval-btn" disabled={busy || !words} title="Send the note to the agent; the proposal stays open" onClick={() => void reply()}>
            <TI icon={IconArrowBackUp} size={13} />Reply
          </button>
        )}
      </div>
    </div>
  )
}
