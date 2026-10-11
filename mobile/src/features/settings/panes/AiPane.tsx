// Settings → AI (web AiSettings.tsx): which agent CLI answers by default, whether
// each is installed and signed in, the default model, API keys, and a one-line
// test. Accounts and per-account environments live under Providers.
import React, { useCallback, useEffect, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { ApiError, AuthError, getAiSettings, getChatModels, saveAiSettings, testAi, type AiSettings as AiSettingsData } from '../../../lib/api'
import { colors, fonts } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Press, Spinner } from '../../../ui/kit'
import { tap } from '../../../ui/haptics'
import { Note, PaneHead, SectionTitle, Select, SettingList, SettingRow } from '../ui'

type TestResult = { ok: boolean; ms: number; reply?: string; error?: string }

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))

function stateLabel(p: AiSettingsData['providers'][number]) {
  if (!p.installed) return 'Not installed'
  if (p.loggedIn === true) return 'Signed in'
  if (p.loggedIn === false) return 'Not signed in'
  return 'Installed'
}

export function Field(props: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      selectionColor={colors.accent}
      keyboardAppearance="dark"
      autoCapitalize="none"
      autoCorrect={false}
      {...props}
      style={[st.field, props.style]}
    />
  )
}

export default function AiPane() {
  const [data, setData] = useState<AiSettingsData | null>(null)
  const [error, setError] = useState('')
  const [models, setModels] = useState<{ id: string; label?: string; name?: string }[]>([])
  const [model, setModel] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [tests, setTests] = useState<Record<string, TestResult | 'running'>>({})
  const [saving, setSaving] = useState(false)

  const fail = useCallback((e: unknown) => { if (!(e instanceof AuthError)) setError(errorText(e)) }, [])

  useEffect(() => {
    getAiSettings().then((d) => { setData(d); setModel(d.defaultModel || '') }).catch(fail)
  }, [fail])

  useEffect(() => {
    if (!data?.defaultProvider) return
    getChatModels(data.defaultProvider)
      .then((r: { models?: { id: string; label?: string; name?: string }[] }) => setModels(r.models || []))
      .catch(() => setModels([]))
  }, [data?.defaultProvider])

  async function save(patch: Parameters<typeof saveAiSettings>[0]) {
    setSaving(true)
    setError('')
    try {
      const next = await saveAiSettings(patch)
      setData(next)
      setModel(next.defaultModel || '')
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  async function runTest(provider: string) {
    setTests((t) => ({ ...t, [provider]: 'running' }))
    try {
      const r = await testAi(provider)
      setTests((t) => ({ ...t, [provider]: r }))
    } catch (e) {
      setTests((t) => ({ ...t, [provider]: { ok: false, ms: 0, error: errorText(e) } }))
    }
  }

  const head = <PaneHead desc="Totem runs its AI through a command-line agent installed on its machine. Pick the default one, sign it in (or give it an API key), choose a model, and test it." />
  if (!data) return <>{head}{error ? <Note text={error} error /> : <Spinner label="Checking which AI tools are installed…" />}</>

  return (
    <>
      {head}
      {!data.configured ? (
        <SettingList>
          <SettingRow
            title="No AI is set up yet"
            desc="Install one of the CLIs below and sign it in on Totem's machine, or add an API key. Until then chat, the phone shortcut and AI jobs answer with a pointer back to this page; everything else works."
          />
        </SettingList>
      ) : null}
      <Note text={error} error />

      <SectionTitle title="Default provider" />
      <SettingList>
        {data.providers.map((p) => {
          const test = tests[p.id]
          const on = data.defaultProvider === p.id
          return (
            <View key={p.id} style={st.row}>
              <Press
                disabled={saving}
                onPress={() => { tap(); void save({ defaultProvider: p.id, defaultModel: null }) }}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                style={{ flex: 1, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}
              >
                <View style={[st.radio, on && { borderColor: colors.accent }]}>{on ? <View style={st.dot} /> : null}</View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T size={14} weight={600}>{p.label}</T>
                  <T size={12} muted lineHeight={17}>
                    {stateLabel(p)}{p.detail ? ` — ${p.detail}` : ''}{p.fix ? ` · fix: ${p.fix}` : ''}
                  </T>
                  {test && test !== 'running' ? (
                    <T size={12} lineHeight={17} color={test.ok ? colors.muted : colors.red}>
                      {test.ok ? `Test passed in ${(test.ms / 1000).toFixed(1)}s.` : `Test failed: ${test.error || test.reply || 'no reply'}`}
                    </T>
                  ) : null}
                </View>
              </Press>
              <Btn compact title={test === 'running' ? 'Testing…' : 'Test'} disabled={test === 'running' || !p.installed} onPress={() => runTest(p.id)} />
            </View>
          )
        })}
      </SettingList>

      <SectionTitle title="Model" />
      <SettingList>
        <SettingRow title="Default model" desc="Leave empty to use the CLI's own default." stacked>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {models.length ? (
              <Select
                style={{ flex: 1 }}
                value={model}
                placeholder="CLI default"
                onChange={setModel}
                options={[{ value: '', label: 'CLI default' }, ...models.map((m) => ({ value: m.id, label: m.label || m.name || m.id }))]}
              />
            ) : (
              <Field style={{ flex: 1 }} value={model} placeholder="CLI default" onChangeText={setModel} />
            )}
            <Btn title="Save" disabled={saving || model === (data.defaultModel || '')} onPress={() => save({ defaultModel: model.trim() || null })} />
          </View>
        </SettingRow>
      </SettingList>

      <SectionTitle title="API keys" />
      <SettingList>
        {data.keys.map((k) => (
          <SettingRow
            key={k.name}
            title={k.label}
            stacked={k.source !== 'env'}
            desc={`${k.name}, passed to ${k.providers.join(' and ')}. ${
              k.source === 'env' ? `Set in the server environment (${k.masked}); change it there.`
                : k.source === 'settings' ? `Saved here (${k.masked}).`
                  : 'Not set. Optional if the CLI is signed in with a subscription.'}`}
          >
            {k.source !== 'env' ? (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Field
                  style={{ flex: 1 }}
                  secureTextEntry
                  autoComplete="off"
                  placeholder={k.source ? 'Replace…' : 'Paste key'}
                  value={drafts[k.name] || ''}
                  onChangeText={(v) => setDrafts((d) => ({ ...d, [k.name]: v }))}
                />
                <Btn title="Save" disabled={saving || !drafts[k.name]} onPress={() => save({ keys: { [k.name]: drafts[k.name] } }).then(() => setDrafts((d) => ({ ...d, [k.name]: '' })))} />
                {k.source === 'settings' ? <Btn kind="danger" title="Remove" disabled={saving} onPress={() => save({ keys: { [k.name]: null } })} /> : null}
              </View>
            ) : null}
          </SettingRow>
        ))}
      </SettingList>
    </>
  )
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: colors.line },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  field: {
    minHeight: 40, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.bg2, color: colors.text, fontFamily: fonts[400], fontSize: 15,
  },
})
