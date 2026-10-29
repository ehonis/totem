import React, { useCallback, useEffect, useState } from 'react'
import { ApiError, AuthError, getIntegrations, saveIntegrations } from '../api'
import type { IntegrationField, IntegrationsPayload } from '../api'

/*
 * Settings -> Integrations: the public URL and the services Totem talks to with
 * its own credentials (the Google Sheet task sync). WHOOP and Strava are not
 * here: Bushido holds those grants and Totem reads them from it. Values in the
 * server environment win and are read-only here. MCP-based connections (Google
 * Calendar, Plaud, GitHub, …) live in Studio -> Connections.
 */

function errorText(e: unknown) {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

function FieldRow({ field, draft, onDraft, onSave, onClear, saving }: {
  field: IntegrationField
  draft: string
  onDraft: (v: string) => void
  onSave: () => void
  onClear: () => void
  saving: boolean
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <strong>{field.label}</strong>
        <span>
          <code>{field.name}</code>{' '}
          {field.source === 'env' && <>— set in the server environment ({field.masked}); change it there.</>}
          {field.source === 'settings' && <>— saved here ({field.masked}).</>}
          {!field.source && '— not set.'}
        </span>
      </div>
      {field.source !== 'env' && (
        <div className="setting-control flex gap-2">
          <input className="model-select" type={field.secret ? 'password' : 'text'} autoComplete="off"
            placeholder={field.source ? 'Replace…' : 'Paste value'} value={draft} onChange={(e) => onDraft(e.target.value)} />
          <button className="btn" disabled={saving || !draft.trim()} onClick={onSave}>Save</button>
          {field.source === 'settings' && <button className="btn danger" disabled={saving} onClick={onClear}>Remove</button>}
        </div>
      )}
    </div>
  )
}

export default function IntegrationsSettings({ onAuthError }: { onAuthError: () => void }) {
  const [data, setData] = useState<IntegrationsPayload | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const fail = useCallback((e: unknown) => {
    if (e instanceof AuthError) return onAuthError()
    setError(errorText(e))
  }, [onAuthError])

  useEffect(() => {
    getIntegrations().then(setData).catch(fail)
  }, [fail])

  async function save(values: Record<string, string | null>) {
    setSaving(true)
    setError('')
    try {
      const next = await saveIntegrations(values)
      setData(next)
      setDrafts((d) => { const out = { ...d }; for (const k of Object.keys(values)) delete out[k]; return out })
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  if (!data) {
    return (
      <div className="settings-pane">
        <header className="settings-pane-head"><h2>Integrations</h2></header>
        <p className="text-muted">{error || 'Loading…'}</p>
      </div>
    )
  }

  const field = (f: IntegrationField) => (
    <FieldRow key={f.name} field={f} saving={saving} draft={drafts[f.name] || ''}
      onDraft={(v) => setDrafts((d) => ({ ...d, [f.name]: v }))}
      onSave={() => save({ [f.name]: (drafts[f.name] || '').trim() })}
      onClear={() => save({ [f.name]: null })} />
  )

  return (
    <div className="settings-pane">
      <header className="settings-pane-head">
        <h2>Integrations</h2>
        <p>
          Services Totem connects to with its own credentials. Everything here is off until you add them. Google
          Calendar, Plaud, GitHub and other MCP servers are set up in Studio → Connections.
        </p>
      </header>
      {error && <p className="text-[var(--danger,#e5484d)]">{error}</p>}

      <div className="settings-section-title"><span /><strong>This install</strong></div>
      <div className="setting-list">
        {field(data.publicUrl)}
        <p className="text-muted m-0 px-1">
          The address you open Totem at from other devices, e.g. https://totem.example.com. The first-run setup link
          is built from it, and behind a proxy that rewrites the host, requests naming it still count as same-origin.
        </p>
      </div>

      {data.integrations.map((i) => (
        <React.Fragment key={i.id}>
          <div className="settings-section-title"><span /><strong>{i.label}</strong></div>
          <div className="setting-list">
            <div className="setting-row">
              <div className="setting-copy">
                <strong>{i.configured ? 'Configured.' : 'Not connected'}</strong>
                <span>
                  Create a service account at <a href={i.console} target="_blank" rel="noreferrer">Google Cloud</a>, share
                  the spreadsheet with it as Editor, and fill in the fields below. See <code>{i.docs}</code>.
                  {i.restartRequired && ' Restart Totem after changing these.'}
                </span>
              </div>
            </div>
            {i.fields.map(field)}
            {i.credentialsFile && (
              <div className="setting-row">
                <div className="setting-copy">
                  <strong>Service-account JSON</strong>
                  <span>
                    <code>{i.credentialsFile.name}</code> — set in the server environment only (it is a file path the
                    server reads). {i.credentialsFile.state === 'found' ? 'Found.' : i.credentialsFile.state === 'missing' ? 'Set, but the file does not exist.' : 'Not set.'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}
