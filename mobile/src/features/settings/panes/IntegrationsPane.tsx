// Settings → Integrations (web IntegrationsSettings.tsx): the public URL and the
// services Totem talks to with its own credentials (the task sheet; WHOOP and
// Strava are read from Bushido, which holds those grants).
import React, { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import {
  ApiError, AuthError, getIntegrations, saveIntegrations,
  type IntegrationField, type IntegrationsPayload,
} from '../../../lib/api'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Spinner } from '../../../ui/kit'
import { Note, PaneHead, SectionTitle, SettingList, SettingRow } from '../ui'
import { Field } from './AiPane'

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))

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
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const fail = useCallback((e: unknown) => { if (!(e instanceof AuthError)) setError(errorText(e)) }, [])

  useEffect(() => { getIntegrations().then(setData).catch(fail) }, [fail])

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

  const head = <PaneHead desc="Services Totem connects to with its own credentials. Everything here is off until you add them. Google Calendar, Plaud, GitHub and other MCP servers are set up under Connections." />
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
      <Note text="The address you open Totem at from other devices, e.g. https://totem.example.com. The first-run setup link is built from it, and behind a proxy that rewrites the host, requests naming it still count as same-origin." />

      {data.integrations.map((i) => (
        <React.Fragment key={i.id}>
          <SectionTitle title={i.label} />
          <SettingList>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: colors.line }}>
              <View style={{ flex: 1, gap: 4 }}>
                <T size={14} weight={600}>{i.configured ? 'Configured.' : 'Not connected'}</T>
                <T size={12} muted lineHeight={17}>
                  Create a service account at Google Cloud, share the spreadsheet with it as Editor, and fill in the fields below. See {i.docs}.
                  {i.restartRequired ? ' Restart Totem after changing these.' : ''}
                </T>
              </View>
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
