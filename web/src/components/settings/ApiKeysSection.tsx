import React, { useState } from 'react'
import { AuthError, saveAiSettings } from '../../api'
import type { AiSettings as AiSettingsData } from '../../api'
import { SettingsRow as Row, SettingsSection } from './ui'

// API keys the agent CLIs accept in place of a subscription sign-in
// (data/ai-settings.json; ai/settings.mjs). Values in the server environment win.
export default function ApiKeys({ data, onSaved, onAuthError }: { data: AiSettingsData | null; onSaved: (d: AiSettingsData) => void; onAuthError: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function save(name: string, value: string | null) {
    setSaving(true)
    setError('')
    try {
      onSaved(await saveAiSettings({ keys: { [name]: value } }))
      setDrafts((d) => ({ ...d, [name]: '' }))
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }
  if (!data) return null
  return (
    <SettingsSection id="api-keys" title="API keys" description="Optional when a CLI is signed in with a subscription. Saved on the server and passed to the CLIs that read them.">
      {data.keys.map((k) => (
        <Row
          key={k.name}
          id={`key-${k.name.toLowerCase()}`}
          title={k.label}
          description={<>Used by {k.providers.join(' and ')}. {k.source === 'env' ? <>Set in the server environment ({k.masked}); change it there.</> : k.source === 'settings' ? `Saved (${k.masked}).` : 'Not set.'}</>}
          control={k.source === 'env' ? <code>{k.name}</code> : (
            <form className="s-form" onSubmit={(e) => { e.preventDefault(); if (drafts[k.name]) save(k.name, drafts[k.name]) }}>
              <input className="s-input wide" type="password" autoComplete="off" aria-label={k.label} placeholder={k.source ? 'Replace…' : 'Paste key'}
                value={drafts[k.name] || ''} onChange={(e) => setDrafts((d) => ({ ...d, [k.name]: e.target.value }))} />
              <button className="btn" type="submit" disabled={saving || !drafts[k.name]}>Save</button>
              {k.source === 'settings' && <button className="btn danger" type="button" disabled={saving} onClick={() => save(k.name, null)}>Remove</button>}
            </form>
          )}
        />
      ))}
      {error && <p className="s-error">{error}</p>}
    </SettingsSection>
  )
}

