import React, { useState } from 'react'
import { Hi } from '../icons'
import { STUDIO_ICON_OPTIONS, iconFor } from '../studio'

// Shared icon chooser for anything in Studio that carries a glyph — jobs and
// skills both do. Lifted out of JobsView when Skills grew an editor, so the two
// tabs can't drift into offering different icon sets.
export default function IconPicker({
  value,
  onChange,
  fallback = 'clock',
  label = 'Choose icon',
}: {
  value: string
  onChange: (name: string) => void
  fallback?: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const Current = iconFor(value, fallback)
  return (
    <div className="icon-picker">
      <button
        type="button"
        className={`icon-picker-trigger ${open ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
      >
        <Hi icon={Current} size={18} />
      </button>
      {open && (
        <div className="icon-picker-popover">
          <div className="icon-grid">
            {STUDIO_ICON_OPTIONS.map((name) => (
              <button
                key={name}
                type="button"
                className={`icon-choice ${name === value ? 'selected' : ''}`}
                onClick={() => { onChange(name); setOpen(false) }}
                title={name}
                aria-label={`Use ${name} icon`}
              >
                <Hi icon={iconFor(name)} size={20} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
