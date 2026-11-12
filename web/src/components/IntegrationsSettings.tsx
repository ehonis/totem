import React, { useCallback, useEffect, useState } from 'react'
import { ApiError, AuthError, getIntegrations, saveIntegrations } from '../api'
import type { IntegrationField, IntegrationInfo, IntegrationsPayload } from '../api'
import { INTEGRATIONS_SAVED } from '../cliproxy/api'
import { SettingsRow, SettingsSection } from './settings/ui'

/*
 * The values Totem keeps in data/integrations.json: the public URL and the
 * services it talks to with its own credentials. There is no Integrations pane
 * any more; each block is drawn where it belongs: the public URL under General,
 * the task sheet under Tasks, CLIProxy under Providers. Values set in
 * the server environment win and are read-only here.
 */

function errorText(e: unknown) {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

let shared: IntegrationsPayload | null = null
const listeners = new Set<(p: IntegrationsPayload) => void>()

/** The integrations payload, shared by every block on screen. */
export function useIntegrations(onAuthError: () => void) {
  const [data, setData] = useState<IntegrationsPayload | null>(shared)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const fail = useCallback((e: unknown) => {
    if (e instanceof AuthError) return onAuthError()
    setError(errorText(e))
  }, [onAuthError])

  useEffect(() => {
    listeners.add(setData)
    getIntegrations().then((p) => { shared = p; listeners.forEach((fn) => fn(p)) }).catch(fail)
    return () => { listeners.delete(setData) }
  }, [fail])

  const save = useCallback(async (values: Record<string, string | null>) => {
    setSaving(true)
    setError('')
    try {
      const next = await saveIntegrations(values)
      shared = next
      listeners.forEach((fn) => fn(next))
      window.dispatchEvent(new Event(INTEGRATIONS_SAVED))
      return true
    } catch (e) {
      fail(e)
      return false
    } finally {
      setSaving(false)
    }
  }, [fail])

  return { data, error, saving, save }
}

// What goes in each field, as its placeholder (the bridge's labels name them).
const PLACEHOLDERS: Record<string, string> = {
  TASK_SHEET_ID: 'The long ID from the sheet’s URL',
  TASK_SHEET_TAB: 'e.g. Action items',
  TASK_SHEET_ASSIGNEES: 'e.g. Sam, SB',
  TASK_SHEET_TITLE: 'Defaults to the spreadsheet’s title',
  TASK_SHEET_ACCOUNT: 'Only with several Drive accounts',
  CLIPROXY_URL: 'https://proxy.example.com',
  CLIPROXY_MANAGEMENT_KEY: 'A scoped management key',
}

function sourceLine(field: IntegrationField) {
  if (field.source === 'env') return <>Set in the server environment ({field.masked}); change it there.</>
  if (field.source === 'settings') return <>Saved{field.secret ? ` (${field.masked})` : ''}.</>
  return 'Not set.'
}

/** One value: a field, Save, and Remove once it is saved here. */
export function IntegrationFieldRow({ id, field, description, placeholder, saving, onSave }: {
  id?: string
  field: IntegrationField
  description?: React.ReactNode
  placeholder?: string
  saving: boolean
  onSave: (value: string | null) => Promise<boolean>
}) {
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(false), 2500); return () => clearTimeout(t) }, [saved])
  const [removed, setRemoved] = useState(false)
  const commit = (value: string | null) => onSave(value).then((ok) => { if (ok) { setDraft(''); setSaved(value !== null); setRemoved(value === null) } })
  useEffect(() => { if (!removed) return; const t = setTimeout(() => setRemoved(false), 2500); return () => clearTimeout(t) }, [removed])
  const fromEnv = field.source === 'env'
  const shown = !field.secret && field.source ? field.masked || '' : ''
  return (
    <SettingsRow
      id={id}
      title={field.label}
      description={<>{description}{description ? ' ' : ''}{sourceLine(field)}</>}
      status={saved ? <span className="s-ok">Saved</span> : removed ? <span className="muted">Removed</span> : undefined}
      control={fromEnv ? <code>{field.name}</code> : (
        <form className="s-form" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) commit(draft.trim()) }}>
          <input
            className="s-input wide"
            type={field.secret ? 'password' : 'text'}
            autoComplete="off"
            aria-label={field.label}
            placeholder={shown || placeholder || (field.source ? 'Replace…' : PLACEHOLDERS[field.name] || (field.secret ? 'Paste value' : 'Enter value'))}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="btn" type="submit" disabled={saving || !draft.trim()}>Save</button>
          {field.source === 'settings' && <button className="btn danger" type="button" disabled={saving} onClick={() => commit(null)}>Remove</button>}
        </form>
      )}
    />
  )
}

/**
 * One integration (the task sheet, CLIProxy) as a section of rows. `children` are
 * extra rows after the fields; as a function they get the integration as shown.
 */
export function IntegrationSection({ id, which, title, description, onAuthError, children }: {
  id?: string
  which: IntegrationInfo['id']
  title: string
  description?: React.ReactNode
  onAuthError: () => void
  children?: React.ReactNode | ((info: IntegrationInfo) => React.ReactNode)
}) {
  const { data, error, saving, save } = useIntegrations(onAuthError)
  const info = data?.integrations.find((i) => i.id === which)
  if (!data) return error ? <SettingsSection id={id} title={title}><p className="s-error">{error}</p></SettingsSection> : null
  if (!info) return null
  return (
    <SettingsSection
      id={id}
      title={title}
      description={description}
      action={<span className={`pill ${info.configured ? 'pill-ok' : ''}`}>{info.configured ? 'Connected' : 'Not connected'}</span>}
    >
      {info.fields.map((f) => (
        <IntegrationFieldRow key={f.name} id={`${which}-${f.name.toLowerCase()}`} field={f} saving={saving} onSave={(v) => save({ [f.name]: v })} />
      ))}
      {typeof children === 'function' ? children(info) : children}
      {(info.blurb || info.docs) && (
        <p className="muted">
          {info.blurb}
          {info.docs && <> See <code>{info.docs}</code>.</>}
          {info.restartRequired && ' Restart Totem after changing these.'}
        </p>
      )}
      {error && <p className="s-error">{error}</p>}
    </SettingsSection>
  )
}
