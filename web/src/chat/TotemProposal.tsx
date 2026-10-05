import React, { useState } from 'react'
import { api } from '../api'
import { pushError } from '../toast'
import { getState, patchMessagePart } from './store'
import type { TotemProposalPart } from './types'
import { TI } from './ui'
import { IconSparkles, IconCheck } from './icons'

/**
 * A change the agent proposed to one of the owner's totems (totems/core.mjs).
 * Nothing changes until he taps Accept: the confirm-only rule for anything inferred.
 */
export default function TotemProposal({ part, messageId }: { part: TotemProposalPart; messageId: string }) {
  const [busy, setBusy] = useState(false)
  async function act(action: 'accept' | 'dismiss') {
    const threadId = getState().activeId
    if (!threadId) return
    setBusy(true)
    try {
      const r = await api<{ status: TotemProposalPart['status'] }>('/api/totems/proposal', { method: 'POST', body: JSON.stringify({ threadId, messageId, partId: part.id, action }) })
      patchMessagePart(threadId, messageId, part.id, { status: r.status })
    } catch (e: any) { pushError(e.message) } finally { setBusy(false) }
  }
  return (
    <div className={`vc-totem-prop ${part.status}`}>
      <div className="vc-totem-prop-head">
        <TI icon={IconSparkles} size={15} />
        <span>{part.totemName ? `Change ${part.totemName}` : 'Change a totem'}</span>
      </div>
      <div className="vc-totem-prop-summary">{part.summary}</div>
      {part.memoryNote && <div className="vc-totem-prop-detail"><b>Remember:</b> {part.memoryNote}</div>}
      {part.instructions && <details className="vc-totem-prop-detail"><summary>New instructions</summary><p>{part.instructions}</p></details>}
      {part.status === 'pending' ? (
        <div className="vc-totem-prop-actions">
          <button type="button" className="vc-btn sm primary" disabled={busy} onClick={() => act('accept')}>Accept</button>
          <button type="button" className="vc-btn sm ghost" disabled={busy} onClick={() => act('dismiss')}>Dismiss</button>
        </div>
      ) : (
        <div className="vc-totem-prop-done">{part.status === 'accepted' ? <><TI icon={IconCheck} size={14} />Applied</> : 'Dismissed'}</div>
      )}
    </div>
  )
}
