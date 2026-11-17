import React from 'react'
import { compactionLabel } from './context'
import type { CompactionPart } from './types'
import { TI } from './ui'
import { IconAlertCircle, IconArrowRight, IconArrowsDiagonalMinimize2 } from './icons'

// Where the context was compacted (T3 Code's timeline divider): a rule across the
// log, "Context compacted 412k → 38k tokens", shimmering while it runs and red if
// it failed. A `/compact` turn is only this; a compaction the CLI ran mid-reply
// sits among that reply's steps.
export default function CompactionMark({ p }: { p: CompactionPart }) {
  const l = compactionLabel(p)
  const label = l.tokens ? `${l.text} ${l.tokens.before} → ${l.tokens.after} tokens` : l.text
  return (
    <div className={`vc-compaction ${l.failed ? 'failed' : ''} ${l.active ? 'active' : ''}`} role="separator" aria-label={p.reason ? `${label}: ${p.reason}` : label}>
      <span className="vc-compaction-label">
        <TI icon={l.failed ? IconAlertCircle : IconArrowsDiagonalMinimize2} size={13} />
        {l.tokens ? <>{l.text} {l.tokens.before}<TI icon={IconArrowRight} size={12} />{l.tokens.after} tokens</> : l.text}
        {p.reason && <span className="vc-compaction-reason">· {p.reason}</span>}
      </span>
    </div>
  )
}
