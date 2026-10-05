import React, { useCallback, useEffect, useState } from 'react'
import { Hi, ChevronDownIcon, CloudIcon, NewspaperIcon } from '../icons'
import { getStudio, setStudioConnection, AuthError } from '../api'
import { pushError, pushSuccess } from '../toast'

// Built-in data connections are keyless HTTP data sources the bridge reads
// directly (no MCP server, no sign-in). They live in the Connections tab so they
// enable/configure like everything else, but they're a separate, lighter tier
// from the MCP apps above. State is persisted to the bridge via /api/studio.
const ICONS = { weather: CloudIcon, news: NewspaperIcon }

const FIELDS = {
  weather: [
    { key: 'location', label: 'Location label', type: 'text', placeholder: 'New York, NY' },
    { key: 'lat', label: 'Latitude', type: 'number', placeholder: '40.7128' },
    { key: 'lon', label: 'Longitude', type: 'number', placeholder: '-74.0060' },
  ],
  news: [
    { key: 'aiQuery', label: 'AI headlines query', type: 'text', placeholder: 'artificial intelligence when:1d' },
    { key: 'worldQuery', label: 'World headlines query', type: 'text', placeholder: 'world news when:1d' },
    { key: 'maxItems', label: 'Headlines per topic (1–10)', type: 'number', placeholder: '5' },
  ],
}

interface DataConnectionCardProps {
  conn: any
  busy: boolean
  expanded: boolean
  onToggle: (conn: any, enabled: boolean) => void
  onExpand: () => void
  onSave: (conn: any, form: any) => void
}

function DataConnectionCard({ conn, busy, expanded, onToggle, onExpand, onSave }: DataConnectionCardProps) {
  const Icon = ICONS[conn.id] || CloudIcon
  const fields = FIELDS[conn.id] || []
  const [form, setForm] = useState(conn)
  useEffect(() => { setForm(conn) }, [conn])
  const dirty = fields.some((f) => String(form[f.key] ?? '') !== String(conn[f.key] ?? ''))

  return (
    <section className={`app-row ${expanded ? 'open' : ''} ${conn.enabled ? '' : 'disabled'}`}>
      <button className="app-row-head" onClick={onExpand} aria-expanded={expanded}>
        <span className="connection-icon fallback" style={{ width: 30, height: 30, background: conn.id === 'weather' ? '#2f80ed' : '#8a5cf6' }}>
          <Hi icon={Icon} size={17} />
        </span>
        <span className="app-row-title">
          <strong>{conn.name}</strong>
          <span>{conn.provider} · data</span>
        </span>
        <span className="app-row-status">
          <span className={`app-row-chip ${conn.enabled ? 'on' : ''}`}>{conn.enabled ? 'On' : 'Off'}</span>
        </span>
        <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${expanded ? 'up' : ''}`} />
      </button>

      {expanded && (
        <div className="app-row-body">
          <div className="app-row-controls">
            <button
              className={`provider-switch ${conn.enabled ? 'on' : ''}`}
              disabled={busy}
              onClick={() => onToggle(conn, !conn.enabled)}
              title={conn.enabled ? 'Disable this data source' : 'Enable this data source'}
              aria-label={`${conn.enabled ? 'Disable' : 'Enable'} ${conn.name}`}
            >
              <span />
            </button>
            <span className="app-row-controls-label">
              {conn.enabled ? 'Enabled · read by the morning brief' : 'Disabled'}
            </span>
          </div>
          <p className="app-row-desc">{conn.description}</p>
          <div className="catalog-form">
            {fields.map((f) => (
              <label className="catalog-field" key={f.key}>
                <span>{f.label}</span>
                <input
                  type={f.type}
                  value={form[f.key] ?? ''}
                  placeholder={f.placeholder || ''}
                  onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </label>
            ))}
            <button className="btn compact primary" disabled={busy || !dirty} onClick={() => onSave(conn, form)}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

interface DataConnectionsPanelProps {
  onAuthError?: () => void
}

export default function DataConnectionsPanel({ onAuthError }: DataConnectionsPanelProps) {
  const [conns, setConns] = useState<any>(null)
  const [expanded, setExpanded] = useState<any>(null)
  const [busy, setBusy] = useState<any>(null)

  const load = useCallback(async () => {
    try { setConns((await getStudio()).dataConnections || []) }
    catch (e) { if (e instanceof AuthError) return onAuthError?.(); setConns([]) }
  }, [onAuthError])

  useEffect(() => { load() }, [load])

  async function apply(id, patch, okMsg?) {
    setBusy(id)
    try {
      setConns((await setStudioConnection(id, patch)).dataConnections || [])
      if (okMsg) pushSuccess(okMsg)
    } catch (e) {
      if (e instanceof AuthError) onAuthError?.()
      else pushError('Could not update connection')
    } finally {
      setBusy(null)
    }
  }

  const toggle = (conn, enabled) => apply(conn.id, { enabled })

  function save(conn, form) {
    const patch = {}
    for (const f of FIELDS[conn.id] || []) {
      patch[f.key] = f.type === 'number' ? Number(form[f.key]) : form[f.key]
    }
    apply(conn.id, patch, `Saved ${conn.name}`)
  }

  if (!conns?.length) return null

  return (
    <div className="app-group">
      <div className="settings-section-title"><span /><strong>Built-in data</strong></div>
      <p className="app-row-hint">
        Keyless data sources Totem reads directly — no MCP server, no sign-in. The morning brief uses these.
      </p>
      <div className="app-list">
        {conns.map((c) => (
          <DataConnectionCard
            key={c.id}
            conn={c}
            busy={busy === c.id}
            expanded={expanded === c.id}
            onExpand={() => setExpanded(expanded === c.id ? null : c.id)}
            onToggle={toggle}
            onSave={save}
          />
        ))}
      </div>
    </div>
  )
}
