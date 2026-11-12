// The values Totem keeps in data/integrations.json (web IntegrationsSettings.tsx):
// the public URL and the services it talks to with its own credentials. There is
// no Integrations pane any more; each block is drawn where it belongs: the public
// URL under General, the task sheet under Tasks, CLIProxy under
// Providers. Values set in the server environment win and are read-only here.
import React, { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import {
  ApiError, AuthError, getIntegrations, saveIntegrations,
  type IntegrationField, type IntegrationInfo, type IntegrationsPayload,
} from '../../lib/api'
import { getConnection, subscribeConnection } from '../../lib/connection'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { Code, Field, Loading, Note, Pill, Row, Section } from './ui'

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))

let shared: IntegrationsPayload | null = null
const listeners = new Set<(p: IntegrationsPayload) => void>()

// Another server or a sign-out: the old server's values must not show for the new one.
let connectedTo = `${getConnection().baseUrl}|${getConnection().secret}`
subscribeConnection(() => {
  const now = `${getConnection().baseUrl}|${getConnection().secret}`
  if (now !== connectedTo) { connectedTo = now; shared = null }
})

/** The integrations payload, shared by every block on screen. */
export function useIntegrations() {
  const [data, setData] = useState<IntegrationsPayload | null>(shared)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const fail = useCallback((e: unknown) => { if (!(e instanceof AuthError)) setError(errorText(e)) }, [])

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
  if (field.source === 'env') return `Set in the server environment (${field.masked}); change it there.`
  if (field.source === 'settings') return `Saved${field.secret ? ` (${field.masked})` : ''}.`
  return 'Not set.'
}

/** One value: a field, Save, and Remove once it is saved here. */
export function IntegrationFieldRow({ id, field, description, placeholder, saving, onSave }: {
  id?: string
  field: IntegrationField
  description?: string
  placeholder?: string
  saving: boolean
  onSave: (value: string | null) => Promise<boolean>
}) {
  const [draft, setDraft] = useState('')
  const [said, setSaid] = useState<'' | 'saved' | 'removed'>('')
  useEffect(() => { if (!said) return; const t = setTimeout(() => setSaid(''), 2500); return () => clearTimeout(t) }, [said])
  const commit = (value: string | null) => onSave(value).then((ok) => {
    if (!ok) return
    setDraft('')
    setSaid(value === null ? 'removed' : 'saved')
    if (value !== null) success()
  })
  const fromEnv = field.source === 'env'
  const shown = !field.secret && field.source ? field.masked || '' : ''
  return (
    <Row
      id={id}
      title={field.label}
      stacked={!fromEnv}
      description={`${description ? `${description} ` : ''}${sourceLine(field)}`}
      status={said === 'saved' ? <T size={12.5} color={colors.green}>Saved</T> : said === 'removed' ? <T size={12.5} muted>Removed</T> : undefined}
      control={fromEnv ? <Code>{field.name}</Code> : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field
            style={{ flex: 1 }}
            secureTextEntry={!!field.secret}
            autoComplete="off"
            keyboardType={field.name.endsWith('_URL') ? 'url' : 'default'}
            accessibilityLabel={field.label}
            placeholder={shown || placeholder || (field.source ? 'Replace…' : PLACEHOLDERS[field.name] || (field.secret ? 'Paste value' : 'Enter value'))}
            value={draft}
            onChangeText={setDraft}
            returnKeyType="done"
            onSubmitEditing={() => { if (draft.trim()) void commit(draft.trim()) }}
          />
          <Btn title="Save" disabled={saving || !draft.trim()} onPress={() => void commit(draft.trim())} />
          {field.source === 'settings' ? <Btn kind="danger" title="Remove" disabled={saving} onPress={() => void commit(null)} /> : null}
        </View>
      )}
    />
  )
}

/**
 * One integration (the task sheet, CLIProxy) as a section of rows. `children` are
 * extra rows after the fields; as a function they get the integration as shown.
 */
export function IntegrationSection({ id, which, title, description, children }: {
  id?: string
  which: IntegrationInfo['id']
  title: string
  description?: string
  children?: React.ReactNode | ((info: IntegrationInfo) => React.ReactNode)
}) {
  const { data, error, saving, save } = useIntegrations()
  const info = data?.integrations.find((i) => i.id === which)
  if (!data) return <Section id={id} title={title}><Loading error={error} /></Section>
  if (!info) return null
  const rest = [info.docs ? `See ${info.docs}.` : '', info.restartRequired ? 'Restart Totem after changing these.' : ''].filter(Boolean).join(' ')
  const help = info.blurb ? `${info.blurb} ${rest}` : rest
  return (
    <Section
      id={id}
      title={title}
      action={<Pill label={info.configured ? 'Connected' : 'Not connected'} tone={info.configured ? 'ok' : undefined} />}
      description={[description, help].filter(Boolean).join(' ')}
      footer={error ? <Note text={error} error /> : undefined}
    >
      {info.fields.map((f) => (
        <IntegrationFieldRow key={f.name} id={`${which}-${f.name.toLowerCase()}`} field={f} saving={saving} onSave={(v) => save({ [f.name]: v })} />
      ))}
      {typeof children === 'function' ? children(info) : children}
    </Section>
  )
}
