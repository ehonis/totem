import React, { useCallback, useEffect, useState } from 'react'
import {
  ApiError, AuthError, connectStrava, connectWhoop, getIntegrations, getStravaStatus, getWhoopStatus, saveIntegrations,
} from '../api'
import type { IntegrationField, IntegrationInfo, IntegrationsPayload } from '../api'

/*
 * Settings -> Integrations: the OAuth apps Totem talks to directly (WHOOP,
 * Strava). Each needs an app created in the provider's developer console; this
 * page takes its client ID and secret, shows the redirect URI to paste there, and
 * starts the connection. Values in the server environment win and are read-only
 * here. MCP-based connections (Google Calendar, Plaud, GitHub, …) live in
 * Studio -> Connections.
 */

function errorText(e: unknown) {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

const CONNECT: Partial<Record<IntegrationInfo['id'], () => Promise<any>>> = { whoop: connectWhoop, strava: connectStrava }
const STATUS: Partial<Record<IntegrationInfo['id'], () => Promise<any>>> = { whoop: getWhoopStatus, strava: getStravaStatus }

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
  const [states, setStates] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const fail = useCallback((e: unknown) => {
    if (e instanceof AuthError) return onAuthError()
    setError(errorText(e))
  }, [onAuthError])

  const refreshStates = useCallback((payload: IntegrationsPayload) => {
    for (const i of payload.integrations) {
      const status = STATUS[i.id]
      if (!status) {
        setStates((st) => ({ ...st, [i.id]: i.configured ? 'Configured.' : 'Not configured.' }))
        continue
      }
      status()
        .then((s: { state?: string; detail?: string; connected?: boolean }) =>
          setStates((st) => ({ ...st, [i.id]: s.detail || (s.connected ? 'Connected.' : 'Not connected.') })))
        .catch(() => setStates((st) => ({ ...st, [i.id]: 'Not connected.' })))
    }
  }, [])

  useEffect(() => {
    getIntegrations().then((d) => { setData(d); refreshStates(d) }).catch(fail)
  }, [fail, refreshStates])

  async function save(values: Record<string, string | null>) {
    setSaving(true)
    setError('')
    try {
      const next = await saveIntegrations(values)
      setData(next)
      setDrafts((d) => { const out = { ...d }; for (const k of Object.keys(values)) delete out[k]; return out })
      refreshStates(next)
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  async function connect(id: IntegrationInfo['id']) {
    setError('')
    try {
      const r = await CONNECT[id]?.()
      if (r?.authUrl) window.open(r.authUrl, '_blank', 'noopener')
      else if (r?.error) setError(r.error)
    } catch (e) {
      fail(e)
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
          Services Totem connects to with its own OAuth app. Everything here is off until you add credentials. Google
          Calendar, Plaud, GitHub and other MCP servers are set up in Studio → Connections.
        </p>
      </header>
      {error && <p className="text-[var(--danger,#e5484d)]">{error}</p>}

      <div className="settings-section-title"><span /><strong>This install</strong></div>
      <div className="setting-list">
        {field(data.publicUrl)}
        <p className="text-muted m-0 px-1">
          The address you open Totem at from other devices, e.g. https://totem.example.com. Redirect URIs below are
          built from it; without it they point at localhost, which only works from a browser on this machine.
        </p>
      </div>

      {data.integrations.map((i) => (
        <React.Fragment key={i.id}>
          <div className="settings-section-title"><span /><strong>{i.label}</strong></div>
          <div className="setting-list">
            <div className="setting-row">
              <div className="setting-copy">
                <strong>{i.configured ? (states[i.id] || 'Checking…') : 'Not connected'}</strong>
                {i.redirectUri ? (
                  <span>
                    Create an app at <a href={i.console} target="_blank" rel="noreferrer">{i.console}</a> and set its
                    redirect URI to <code>{i.redirectUri}</code>
                    {i.callbackDomain ? <> (Strava asks for the bare domain: <code>{i.callbackDomain}</code>)</> : null}.
                    {i.redirectFromEnv && ' This redirect URI comes from the server environment.'}
                  </span>
                ) : (
                  <span>
                    Create a service account at <a href={i.console} target="_blank" rel="noreferrer">Google Cloud</a>, share
                    the spreadsheet with it as Editor, and fill in the fields below. See <code>{i.docs}</code>.
                    {i.restartRequired && ' Restart Totem after changing these.'}
                  </span>
                )}
              </div>
              {CONNECT[i.id] && (
                <div className="setting-control">
                  <button className="btn primary" disabled={!i.configured} onClick={() => connect(i.id)}>Connect</button>
                </div>
              )}
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
