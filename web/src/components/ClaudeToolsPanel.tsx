import React, { useEffect, useMemo, useState } from 'react'
import { api, AuthError } from '../api'
import { Hi, ArrowPathIcon, ChevronDownIcon } from '../icons'

// Claude's own connectors (claude.ai connectors, its MCP servers, plugins) and a
// switch for each server and tool. Pulled from Claude Code itself; whatever is
// on may run in chats without a permission prompt, whatever is off is denied
// (providers/claude-tools.mjs).

interface ToolRow { name: string; enabled: boolean }
interface ServerRow {
  name: string
  prefix: string
  source: string
  status: string
  accounts: string[]
  enabled: boolean
  enabledCount: number
  tools: ToolRow[]
}
interface Payload {
  servers: ServerRow[]
  accounts: Record<string, { pulledAt: string | null; error: string | null; servers: number }>
  claudeAccounts: { id: string; name: string }[]
}

const SOURCE_LABEL: Record<string, string> = { claudeai: 'claude.ai connector', plugin: 'Plugin', user: 'MCP server', project: 'Project MCP', local: 'MCP server' }
const STATUS_LABEL: Record<string, string> = { 'needs-auth': 'Needs sign-in', pending: 'Was still connecting', failed: 'Failed' }

const displayName = (name: string) => name.replace(/^claude\.ai\s+/i, '').replace(/^plugin:[^:]+:/, '')

function ago(iso: string | null) {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

function Switch({ on, disabled, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className={`provider-switch ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} aria-pressed={on} aria-label={label} title={label}>
      <span />
    </button>
  )
}

export default function ClaudeToolsPanel({ onAuthError }: { onAuthError?: () => void }) {
  const [data, setData] = useState<Payload | null>(null)
  const [pulling, setPulling] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const fail = (e: any) => { if (e instanceof AuthError) onAuthError?.(); else setError(e?.message || String(e)) }
  useEffect(() => { api<Payload>('/api/claude-tools').then(setData).catch(fail) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function pull() {
    setPulling(true); setError('')
    try { setData(await api<Payload>('/api/claude-tools/pull', { method: 'POST' })) } catch (e) { fail(e) } finally { setPulling(false) }
  }
  async function toggle(body: { server?: string; tool?: string; all?: boolean; enabled: boolean }) {
    setBusy(true); setError('')
    try {
      setData(await api<Payload>('/api/claude-tools/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const needle = q.trim().toLowerCase()
  const servers = useMemo(() => (data?.servers || []).map((s) => {
    if (!needle || s.name.toLowerCase().includes(needle)) return s
    const tools = s.tools.filter((t) => t.name.toLowerCase().includes(needle))
    return tools.length ? { ...s, tools } : null
  }).filter(Boolean) as ServerRow[], [data, needle])

  const accounts = data?.claudeAccounts || []
  const pulls = accounts.map((a) => ({ ...a, ...(data?.accounts[a.id] || { pulledAt: null, error: null, servers: 0 }) }))
  const total = (data?.servers || []).reduce((n, s) => n + s.tools.length, 0)
  const on = (data?.servers || []).reduce((n, s) => n + s.enabledCount, 0)

  return (
    <div className="app-group claude-tools">
      <div className="settings-section-title"><span /><strong>Claude tools</strong></div>
      <div className="claude-tools-head">
        <p className="app-row-hint">
          The connectors your Claude account brings with it: claude.ai connectors, its own MCP servers and plugins.
          Anything switched on here runs in chats without a permission prompt. Anything switched off is blocked, whatever the chat's access setting.
        </p>
        <div className="claude-tools-actions">
          <button className="btn compact primary" disabled={pulling || !accounts.length} onClick={pull}>
            <Hi icon={ArrowPathIcon} size={14} className={pulling ? 'spin' : ''} /> {pulling ? 'Pulling…' : data?.servers.length ? 'Pull again' : 'Pull tools'}
          </button>
          {data?.servers.length ? (
            <>
              <button className="btn compact" disabled={busy || on === total} onClick={() => toggle({ all: true, enabled: true })}>All on</button>
              <button className="btn compact" disabled={busy || on === 0} onClick={() => toggle({ all: true, enabled: false })}>All off</button>
            </>
          ) : null}
        </div>
      </div>

      {!accounts.length && <p className="app-row-hint">No Claude account is set up. Add one in Settings → Providers.</p>}
      {pulls.map((a) => (
        <p key={a.id} className={`app-row-hint ${a.error ? 'claude-tools-error' : ''}`}>
          {accounts.length > 1 ? <strong>{a.name}: </strong> : null}
          {a.error ? `Pull failed: ${a.error}` : a.pulledAt ? `Pulled ${ago(a.pulledAt)}, ${a.servers} servers.` : 'Not pulled yet.'}
        </p>
      ))}
      {error && <p className="app-row-hint claude-tools-error">{error}</p>}

      {data?.servers.length ? (
        <>
          <input className="claude-tools-search" type="search" placeholder={`Filter ${total} tools`} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="app-list">
            {servers.map((s) => {
              const expanded = open === s.prefix || !!needle
              return (
                <section key={s.prefix} className={`app-row ${expanded ? 'open' : ''} ${s.enabled ? '' : 'disabled'}`}>
                  <div className="claude-tools-row">
                    <button className="app-row-head" onClick={() => setOpen(open === s.prefix ? null : s.prefix)} aria-expanded={expanded}>
                      <span className="app-row-title">
                        <strong>{displayName(s.name)}</strong>
                        <span>{SOURCE_LABEL[s.source] || s.source || 'MCP server'}{STATUS_LABEL[s.status] ? ` · ${STATUS_LABEL[s.status]}` : ''}</span>
                      </span>
                      <span className="app-row-status">
                        <span className={`app-row-chip ${s.enabled && s.enabledCount ? 'on' : ''}`}>
                          {!s.enabled ? 'Off' : s.tools.length ? `${s.enabledCount}/${s.tools.length} on` : 'On'}
                        </span>
                      </span>
                      <Hi icon={ChevronDownIcon} size={16} className={`app-row-caret ${expanded ? 'up' : ''}`} />
                    </button>
                    <Switch on={s.enabled} disabled={busy} label={`${s.enabled ? 'Turn off' : 'Turn on'} ${displayName(s.name)}`} onChange={(v) => toggle({ server: s.name, enabled: v })} />
                  </div>
                  {expanded && (
                    <div className="app-row-body">
                      {s.tools.length ? (
                        <ul className="claude-tools-list">
                          {s.tools.map((t) => (
                            <li key={t.name}>
                              <code>{t.name}</code>
                              <Switch on={t.enabled} disabled={busy} label={`${t.enabled ? 'Turn off' : 'Turn on'} ${t.name}`} onChange={(v) => toggle({ server: s.name, tool: t.name, enabled: v })} />
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="app-row-hint">
                          {s.status === 'needs-auth' ? 'Sign in to this connector in Claude first, then pull again.' : 'No tools listed yet. The server may still have been connecting; pull again to list them.'}
                          {s.enabled ? ' While it is on, every tool it offers is allowed.' : ''}
                        </p>
                      )}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </>
      ) : null}
    </div>
  )
}
