import React, { useCallback, useRef, useState } from 'react'
import { TI, useDismiss } from './ui'
import { IconChevronDown, IconCheck, IconLock, IconLockOpen, IconPencilCheck, IconSparkles } from './icons'
import type { Access } from './types'

// What the agent may do in this chat without asking, after T3 Code's control.
// The bridge runs every CLI in print mode, which cannot stop to ask, so "asks"
// here means the action is refused (providers/claude-tools.mjs › ACCESS_MODES).
// Connector tools are governed separately, by Settings → Connections.

const MODES: { id: Access; label: string; hint: string; icon: any }[] = [
  { id: 'supervised', label: 'Supervised', hint: 'Read and use connectors. Commands and file changes are refused.', icon: IconLock },
  { id: 'edits', label: 'Auto-accept edits', hint: 'File edits go through; commands are refused.', icon: IconPencilCheck },
  { id: 'auto', label: 'Auto', hint: 'Providers that can judge routine actions approve them; anything else is refused.', icon: IconSparkles },
  { id: 'full', label: 'Full access', hint: 'Commands and edits without prompts.', icon: IconLockOpen },
]

export default function AccessControl({ value, onChange }: { value?: Access; onChange: (v: Access) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, useCallback(() => setOpen(false), []))
  const current = MODES.find((m) => m.id === value) || MODES[3]
  return (
    <div className="vc-access" ref={ref}>
      <button type="button" className={`vc-chip ${open ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title={`Access: ${current.label}`}>
        <TI icon={current.icon} size={15} />
        <span className="vc-chip-label">{current.label}</span>
        <TI icon={IconChevronDown} size={14} className="vc-chip-caret" />
      </button>
      {open && (
        <div className="vc-effort-pop vc-access-pop" role="menu" aria-label="Access">
          <div className="vc-effort-list">
            {MODES.map((m) => (
              <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === current.id} className={m.id === current.id ? 'current' : ''} onClick={() => { onChange(m.id); setOpen(false) }}>
                <TI icon={m.icon} size={16} />
                <span className="vc-access-text"><span>{m.label}</span><small>{m.hint}</small></span>
                {m.id === current.id && <TI icon={IconCheck} size={15} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
