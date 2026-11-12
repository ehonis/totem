import React from 'react'
import IconCornerUpLeft from '@tabler/icons-react/dist/esm/icons/IconCornerUpLeft.mjs'
import { TI } from '../../chat/ui'

// The building blocks every Settings pane is drawn with, after T3 Code's
// settings: a section is a heading over one bordered group, and a group is rows
// divided by hairlines, each a title and one line of description on the left and
// its control on the right. Rows keep the `.setting-row` / `.setting-copy` /
// `.setting-control` class names because "Chat about this" reads a pane by them
// (chat/about/settingsOutline.ts).

/** A pane's column: one width for every pane, so headings never jump between them. */
export function SettingsPage({ children }: { children: React.ReactNode }) {
  return <div className="sp">{children}</div>
}

export function SettingsSection({ id, title, description, action, plain, children }: {
  id?: string
  title?: React.ReactNode
  description?: React.ReactNode
  /** Right side of the heading: a refresh, an Add button. */
  action?: React.ReactNode
  /** Children draw their own surface (a list of cards, an editor). */
  plain?: boolean
  children: React.ReactNode
}) {
  return (
    <section id={id} className="ss" tabIndex={id ? -1 : undefined}>
      {(title || action) && (
        <div className="ss-head">
          <div className="ss-titles">
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {action && <div className="ss-action">{action}</div>}
        </div>
      )}
      {plain ? children : <div className="setting-list sg">{children}</div>}
    </section>
  )
}

export function SettingsRow({ id, title, description, status, control, onReset, stack, children }: {
  id?: string
  title: React.ReactNode
  description?: React.ReactNode
  /** A short live reading under the description (a test result, "Saved"). */
  status?: React.ReactNode
  control?: React.ReactNode
  /** Shown only when the value differs from its default. */
  onReset?: () => void
  /** The control takes the full width under the copy (swatches, a form). */
  stack?: boolean
  /** Anything below the row's head, full width. */
  children?: React.ReactNode
}) {
  return (
    <div id={id} tabIndex={id ? -1 : undefined} className={`setting-row sr${stack ? ' sr-stack' : ''}`}>
      <div className="setting-copy">
        <div className="sr-title">
          <strong>{title}</strong>
          {onReset && (
            <button type="button" className="sr-reset" onClick={onReset} title="Reset to default" aria-label={`Reset ${typeof title === 'string' ? title : 'setting'} to default`}>
              <TI icon={IconCornerUpLeft} size={13} />
            </button>
          )}
        </div>
        {description && <span className="sr-desc">{description}</span>}
        {status && <span className="sr-status">{status}</span>}
      </div>
      {control && <div className="setting-control">{control}</div>}
      {children && <div className="sr-body">{children}</div>}
    </div>
  )
}

/** The one on/off switch Settings uses. */
export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

/** A callout inside a pane: why something is off, what to do about it. */
export function SettingsNote({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: React.ReactNode }) {
  return <div className={`s-note ${tone}`} role={tone === 'error' ? 'alert' : undefined}>{children}</div>
}

/** A pane that is still loading, or could not load. */
export function SettingsLoading({ error }: { error?: string }) {
  return <SettingsPage><p className={error ? 's-error' : 'muted'}>{error || 'Loading…'}</p></SettingsPage>
}
