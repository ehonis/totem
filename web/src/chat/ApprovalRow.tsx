// A tool call waiting on the owner's approval, in the reply where it was asked
// (T3 Code's TimelinePendingApprovalRow): what the agent wants to run, why Claude
// asked, and "Waiting for approval · Decline · Approve · More". Once decided it
// stays as one line saying what happened. chat/approvals.ts has the rules.
import { useCallback, useRef, useState } from 'react'
import type { ApprovalDecision, ApprovalPart } from './types'
import { approvalOptions, approvalOutcome } from './approvals'
import { getState, respondToApproval } from './store'
import { Logo } from './WorkLog'
import { TI, useDismiss } from './ui'
import { IconDots, IconShield, IconShieldCheck, IconShieldX } from './icons'

export default function ApprovalRow({ part, messageId, live }: { part: ApprovalPart; messageId: string; live: boolean }) {
  const [busy, setBusy] = useState(false)
  const [more, setMore] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  useDismiss(more, moreRef, useCallback(() => setMore(false), []))
  const pending = part.status === 'pending'
  const canRespond = pending && live
  const decide = async (decision: ApprovalDecision) => {
    const threadId = getState().activeId
    if (busy || !threadId) return
    setMore(false)
    setBusy(true)
    await respondToApproval(threadId, messageId, part.id, decision)
    setBusy(false)
  }
  const { primary, more: extra } = approvalOptions(part)
  const detail = part.detail && part.detail !== part.title ? part.detail : ''

  if (!pending) {
    const ok = part.status === 'approved'
    return (
      <div className={`vc-approval settled ${part.status}`} title={part.reason || undefined}>
        <span className="vc-approval-icon"><TI icon={ok ? IconShieldCheck : IconShieldX} size={15} /></span>
        <span className="vc-approval-line"><span className="vc-approval-title">{part.title}</span>{detail && <code>{detail}</code>}</span>
        <span className="vc-approval-outcome">{approvalOutcome(part)}</span>
      </div>
    )
  }

  return (
    <div className="vc-approval pending" role="group" aria-label="Approval request">
      <div className="vc-approval-head">
        <span className="vc-approval-icon">{part.logo ? <Logo logo={part.logo} kind="mcp" size={15} /> : <TI icon={IconShield} size={15} />}</span>
        <span className="vc-approval-title">{part.title}{part.app && <span className="vc-approval-app"> · {part.app}</span>}{part.subagent && <span className="vc-approval-app"> · sub-agent</span>}</span>
      </div>
      {(detail || part.input) && <code className="vc-approval-detail" tabIndex={0}>{detail || part.input}</code>}
      {part.reason && <div className="vc-approval-reason">{part.reason}</div>}
      <div className="vc-approval-actions">
        {canRespond ? (
          <>
            <span className="vc-approval-waiting"><TI icon={IconShield} size={13} />Waiting for approval</span>
            <span className="vc-approval-dot" aria-hidden>·</span>
            {primary.map((o) => (
              <button key={o.decision} type="button" className={`vc-approval-btn ${o.decision === 'accept' ? 'primary' : ''}`} disabled={busy} onClick={() => void decide(o.decision)}>{o.label}</button>
            ))}
            <div className="vc-approval-more" ref={moreRef}>
              <button type="button" className="vc-approval-btn" disabled={busy} aria-haspopup="menu" aria-expanded={more} aria-label="More approval options" onClick={() => setMore((m) => !m)}><TI icon={IconDots} size={14} /></button>
              {more && (
                <div className="vc-menu vc-approval-menu" role="menu">
                  {extra.map((o) => (
                    <button key={o.decision} type="button" role="menuitem" className={o.decision === 'cancel' ? 'danger' : ''} onClick={() => void decide(o.decision)}>{o.label}</button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <span className="vc-approval-gone">The reply that asked has ended, so this can no longer be answered.</span>
        )}
      </div>
    </div>
  )
}
