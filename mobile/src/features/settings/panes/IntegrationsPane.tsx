// Settings → Integrations (web IntegrationsSettings.tsx): the OAuth apps Totem
// talks to directly (WHOOP, Strava, the task sheet). Each needs an app in the
// provider's console; this takes its client ID and secret, shows the redirect URI
// to paste there, and starts the connection in the in-app browser.
import React, { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as Clipboard from 'expo-clipboard'
import {
  ApiError, AuthError, connectStrava, connectWhoop, getIntegrations, getStravaStatus, getWhoopStatus, saveIntegrations,
  type IntegrationField, type IntegrationInfo, type IntegrationsPayload,
} from '../../../lib/api'
import { pushToast } from '../../../lib/toast'
import { colors, fonts } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Press, Spinner } from '../../../ui/kit'
import { tap } from '../../../ui/haptics'
import { Note, PaneHead, SectionTitle, SettingList, SettingRow } from '../ui'
import { Field } from './AiPane'

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))

const CONNECT: Partial<Record<IntegrationInfo['id'], () => Promise<any>>> = { whoop: connectWhoop, strava: connectStrava }
const STATUS: Partial<Record<IntegrationInfo['id'], () => Promise<any>>> = { whoop: getWhoopStatus, strava: getStravaStatus }

/** A value to paste into a console: monospace, and a tap copies it. */
function Code({ text }: { text: string }) {
  return (
    <Press onPress={() => { tap(); void Clipboard.setStringAsync(text); pushToast('Copied', 'info') }} accessibilityHint="Copies it">
      <T size={12} mono color={colors.text} style={{ fontFamily: fonts.mono }} selectable>{text}</T>
    </Press>
  )
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
    <SettingRow
      title={field.label}
      stacked={field.source !== 'env'}
      desc={`${field.name} ${field.source === 'env' ? `— set in the server environment (${field.masked}); change it there.`
        : field.source === 'settings' ? `— saved here (${field.masked}).` : '— not set.'}`}
    >
      {field.source !== 'env' ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field style={{ flex: 1 }} secureTextEntry={!!field.secret} autoComplete="off" placeholder={field.source ? 'Replace…' : 'Paste value'} value={draft} onChangeText={onDraft} />
          <Btn title="Save" disabled={saving || !draft.trim()} onPress={onSave} />
          {field.source === 'settings' ? <Btn kind="danger" title="Remove" disabled={saving} onPress={onClear} /> : null}
        </View>
      ) : null}
    </SettingRow>
  )
}

export default function IntegrationsPane() {
  const [data, setData] = useState<IntegrationsPayload | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [states, setStates] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const fail = useCallback((e: unknown) => { if (!(e instanceof AuthError)) setError(errorText(e)) }, [])

  const refreshStates = useCallback((payload: IntegrationsPayload) => {
    for (const i of payload.integrations) {
      const status = STATUS[i.id]
      if (!status) {
        setStates((st) => ({ ...st, [i.id]: i.configured ? 'Configured.' : 'Not configured.' }))
        continue
      }
      status()
        .then((s: { detail?: string; connected?: boolean }) => setStates((st) => ({ ...st, [i.id]: s.detail || (s.connected ? 'Connected.' : 'Not connected.') })))
        .catch(() => setStates((st) => ({ ...st, [i.id]: 'Not connected.' })))
    }
  }, [])

  useEffect(() => { getIntegrations().then((d) => { setData(d); refreshStates(d) }).catch(fail) }, [fail, refreshStates])

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
      if (r?.authUrl) await WebBrowser.openBrowserAsync(r.authUrl)
      else if (r?.error) setError(r.error)
      if (data) refreshStates(data)
    } catch (e) {
      fail(e)
    }
  }

  const head = <PaneHead desc="Services Totem connects to with its own OAuth app. Everything here is off until you add credentials. Google Calendar, Plaud, GitHub and other MCP servers are set up under Connections." />
  if (!data) return <>{head}{error ? <Note text={error} error /> : <Spinner />}</>

  const field = (f: IntegrationField) => (
    <FieldRow
      key={f.name}
      field={f}
      saving={saving}
      draft={drafts[f.name] || ''}
      onDraft={(v) => setDrafts((d) => ({ ...d, [f.name]: v }))}
      onSave={() => save({ [f.name]: (drafts[f.name] || '').trim() })}
      onClear={() => save({ [f.name]: null })}
    />
  )

  return (
    <>
      {head}
      <Note text={error} error />

      <SectionTitle title="This install" />
      <SettingList>{field(data.publicUrl)}</SettingList>
      <Note text="The address you open Totem at from other devices, e.g. https://totem.example.com. Redirect URIs below are built from it; without it they point at localhost, which only works from a browser on Totem's machine." />

      {data.integrations.map((i) => (
        <React.Fragment key={i.id}>
          <SectionTitle title={i.label} />
          <SettingList>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: colors.line }}>
              <View style={{ flex: 1, gap: 4 }}>
                <T size={14} weight={600}>{i.configured ? (states[i.id] || 'Checking…') : 'Not connected'}</T>
                {i.redirectUri ? (
                  <>
                    <T size={12} muted lineHeight={17}>Create an app at {i.console} and set its redirect URI to:</T>
                    <Code text={i.redirectUri} />
                    {i.callbackDomain ? <><T size={12} muted>Strava asks for the bare domain:</T><Code text={i.callbackDomain} /></> : null}
                    {i.redirectFromEnv ? <T size={12} muted>This redirect URI comes from the server environment.</T> : null}
                  </>
                ) : (
                  <T size={12} muted lineHeight={17}>
                    Create a service account at Google Cloud, share the spreadsheet with it as Editor, and fill in the fields below. See {i.docs}.
                    {i.restartRequired ? ' Restart Totem after changing these.' : ''}
                  </T>
                )}
              </View>
              {CONNECT[i.id] ? <Btn kind="primary" title="Connect" disabled={!i.configured} onPress={() => connect(i.id)} /> : null}
            </View>
            {i.fields.map(field)}
            {i.credentialsFile ? (
              <SettingRow
                title="Service-account JSON"
                desc={`${i.credentialsFile.name} — set in the server environment only (it is a file path the server reads). ${
                  i.credentialsFile.state === 'found' ? 'Found.' : i.credentialsFile.state === 'missing' ? 'Set, but the file does not exist.' : 'Not set.'}`}
              />
            ) : null}
          </SettingList>
        </React.Fragment>
      ))}
    </>
  )
}
