// Settings → Providers (web ProvidersView.tsx, settings/ProviderDefaults.tsx,
// settings/ApiKeysSection.tsx): the default account and model, each agent CLI
// account (opened on its own pushed screen, app/settings/provider.tsx), the API
// keys the CLIs accept in place of a sign-in, and CLIProxy.
import React, { useEffect, useState } from 'react'
import { View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { AuthError, getAiSettings, saveAiSettings, type AiSettings } from '../../../lib/api'
import { ArrowPathIcon, Hi, PlusIcon } from '../../../lib/icons'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Press } from '../../../ui/kit'
import { ProviderLogo } from '../../chat/ui'
import { IntegrationSection } from '../integrations'
import {
  FALLBACK_PROVIDER, accountLine, addAccount, changeDefaultModel, ensureModels, loadProviders, makeDefault,
  toggleEnabled, useProviders, type Provider,
} from '../providers/store'
import { Code, Field, Loading, Note, Notice, Picker, Pill, Row, Section, Switch } from '../ui'

export const openAccount = (id: string) => router.push({ pathname: '/settings/provider', params: { id } })

function Defaults() {
  const { data, saving, models, loading } = useProviders()
  const providers: Provider[] = data?.providers || []
  const def = providers.find((p) => p.default) || null
  useEffect(() => { if (def?.supportsModelPicker) ensureModels(def.id) }, [def?.id, def?.supportsModelPicker])
  const candidates = providers.filter((p) => p.installed && (p.enabled || p.default))
  const checked = data?.generatedAt ? new Date(data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  const list: any[] = def ? models[def.id] || [] : []
  // defaultModel may carry param brackets (composer-2.5[fast=true]); match on the bare id.
  const baseId = (data?.defaultModel || '').split('[')[0]
  const modelOptions = [
    ...(!baseId ? [{ value: '', label: 'Provider default' }] : []),
    ...(baseId && !list.some((m) => m.id === baseId) ? [{ value: baseId, label: baseId }] : []),
    ...list.map((m) => ({ value: m.id, label: `${m.name}${m.recommended ? ' (recommended)' : ''}` })),
  ]
  return (
    <Section
      id="defaults"
      title="Defaults"
      description="What a new chat, the phone shortcut and a totem run on when they name no account."
      action={
        <Press haptic onPress={() => void loadProviders()} disabled={loading} hitSlop={8} accessibilityRole="button" accessibilityLabel="Check accounts again" style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          {checked ? <T size={12} muted>Checked {checked}</T> : null}
          <Hi icon={ArrowPathIcon} size={15} color={colors.muted} />
        </Press>
      }
    >
      <Row
        id="default-account"
        title="Default account"
        description={def && def.id !== FALLBACK_PROVIDER
          ? `When it hits a usage limit, requests fall back to ${providers.find((p) => p.id === FALLBACK_PROVIDER)?.name || 'OpenCode'}.`
          : 'Only accounts that are installed and switched on can be the default.'}
        control={
          <Picker
            label="Default account"
            value={def?.id || ''}
            disabled={!!saving}
            placeholder="None"
            options={candidates.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(id) => { const p = providers.find((x) => x.id === id); if (p) void makeDefault(p) }}
          />
        }
      />
      {def?.supportsModelPicker ? (
        <Row
          id="default-model"
          title="Default model"
          description={`On ${def.name}. A chat can still pick another in the composer.`}
          control={
            <Picker
              label="Default model"
              value={baseId}
              disabled={saving === 'defaultModel'}
              options={modelOptions}
              onChange={(m) => { if (m && m !== baseId) changeDefaultModel(m) }}
            />
          }
        />
      ) : null}
    </Section>
  )
}

function Accounts() {
  const { data, saving } = useProviders()
  const providers: Provider[] = data?.providers || []
  const drivers: any[] = (data?.drivers || []).filter((d: any) => d.multiAccount)
  return (
    <Section
      id="accounts"
      title="Accounts"
      description="The agent CLIs on the server. Claude and Codex can hold several logins, each with its own config directory, models and quota."
    >
      {providers.length === 0 ? <Row title="No agent CLIs found on this server." /> : null}
      {providers.map((p) => (
        <Row
          key={p.id}
          title={p.name}
          icon={<ProviderLogo driver={p.driver} name={p.name} size={18} />}
          description={accountLine(p)}
          status={p.default || !p.enabled ? (
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
              {p.default ? <Pill label="Default" tone="ok" /> : null}
              {!p.enabled ? <Pill label="Off" /> : null}
            </View>
          ) : undefined}
          onPress={() => openAccount(p.id)}
          chevron
          control={
            // The default account is always on: an unqualified request runs on it.
            <Switch
              label={`${p.enabled ? 'Disable' : 'Enable'} ${p.name}`}
              value={!!p.enabled}
              disabled={p.default || !p.installed || saving === p.id}
              onChange={() => toggleEnabled(p)}
            />
          }
        />
      ))}
      {drivers.map((d) => (
        <Row
          key={d.driver}
          title={`Add a ${d.name} account`}
          tone="accent"
          icon={<Hi icon={PlusIcon} size={16} color={colors.accent} />}
          disabled={saving === `add:${d.driver}`}
          onPress={() => { void addAccount(d).then((id) => { if (id) openAccount(id) }) }}
        />
      ))}
    </Section>
  )
}

// API keys the agent CLIs accept in place of a subscription sign-in
// (data/ai-settings.json; ai/settings.mjs). Values in the server environment win.
function ApiKeys({ data, onSaved }: { data: AiSettings | null; onSaved: (d: AiSettings) => void }) {
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
      if (!(e instanceof AuthError)) setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }
  if (!data) return null
  return (
    <Section
      id="api-keys"
      title="API keys"
      description="Optional when a CLI is signed in with a subscription. Saved on the server and passed to the CLIs that read them."
      footer={error ? <Note text={error} error /> : undefined}
    >
      {data.keys.map((k) => (
        <Row
          key={k.name}
          id={`key-${k.name.toLowerCase()}`}
          title={k.label}
          stacked={k.source !== 'env'}
          description={`Used by ${k.providers.join(' and ')}. ${k.source === 'env' ? `Set in the server environment (${k.masked}); change it there.` : k.source === 'settings' ? `Saved (${k.masked}).` : 'Not set.'}`}
          control={k.source === 'env' ? <Code>{k.name}</Code> : (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Field
                style={{ flex: 1 }}
                secureTextEntry
                autoComplete="off"
                accessibilityLabel={k.label}
                placeholder={k.source ? 'Replace…' : 'Paste key'}
                value={drafts[k.name] || ''}
                onChangeText={(v) => setDrafts((d) => ({ ...d, [k.name]: v }))}
                returnKeyType="done"
                onSubmitEditing={() => { if (drafts[k.name]) void save(k.name, drafts[k.name]) }}
              />
              <Btn title="Save" disabled={saving || !drafts[k.name]} onPress={() => void save(k.name, drafts[k.name])} />
              {k.source === 'settings' ? <Btn kind="danger" title="Remove" disabled={saving} onPress={() => void save(k.name, null)} /> : null}
            </View>
          )}
        />
      ))}
    </Section>
  )
}

export default function ProvidersPane(_: { target?: string }) {
  const { data, error } = useProviders()
  const [ai, setAi] = useState<AiSettings | null>(null)
  useEffect(() => { getAiSettings().then(setAi).catch(() => {}) }, [])
  // Coming back from an account's screen keeps what it saved; a refetch picks up sign-ins done in a terminal.
  useFocusEffect(React.useCallback(() => { void loadProviders() }, []))

  return (
    <>
      {ai && !ai.configured ? (
        <Notice tone="warn">
          <T size={13} lineHeight={19}>
            <T size={13} weight={600}>No AI is set up yet. </T>
            Sign one of the CLIs below in on the server (its sign-in command is on the account), or add an API key.
            Until then chat, the phone shortcut and totems answer with a pointer back here; everything else works.
          </T>
        </Notice>
      ) : null}
      {!data ? <Loading error={error || undefined} /> : (
        <>
          <Defaults />
          <Accounts />
          <ApiKeys data={ai} onSaved={setAi} />
          <IntegrationSection
            id="cliproxy"
            which="cliproxy"
            title="CLIProxy"
            description="A proxy that pools several subscription logins behind one endpoint. Once it is connected, its accounts and quota show on the web dashboard’s CLIProxy page."
          />
        </>
      )}
    </>
  )
}
