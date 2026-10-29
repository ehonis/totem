import React from 'react'
import { providerById } from './store'
import { ProviderLogo, TI } from './ui'
import { IconArrowRight } from './icons'
import type { Switch } from './handoff'

// Where a chat moved to another account: a divider in the log above the turn
// that moved, or (pending) a row over the composer before the next message
// goes, as T3 Code shows a provider handoff.
export default function HandoffMark({ s, pending = false }: { s: Switch; pending?: boolean }) {
  const from = providerById(s.from)
  const to = providerById(s.to)
  const name = (id: string, row?: { name: string }) => row?.name || id
  return (
    <div className={`vc-handoff ${pending ? 'pending' : ''}`} role={pending ? 'status' : 'separator'}>
      <span className="vc-handoff-label">{pending ? 'Handoff with your next message' : 'Context handed off'}</span>
      <span className="vc-handoff-who">
        <ProviderLogo driver={from?.driver} name={from?.name} size={13} />{name(s.from, from)}
        <TI icon={IconArrowRight} size={13} />
        <ProviderLogo driver={to?.driver} name={to?.name} size={13} />{name(s.to, to)}
      </span>
    </div>
  )
}
