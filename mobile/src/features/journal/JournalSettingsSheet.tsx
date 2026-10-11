// Journal settings (web/src/journal/JournalSettings.tsx) as a form sheet. Same
// fields, same copy, same patch; the three <select>s are native menus.
import React, { useEffect, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Spinner } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { ExclamationTriangleIcon, Hi } from '../../lib/icons'
import { AuthError, getAgentModels, getJournal, updateJournalSettings } from '../../lib/api'
import { clearSecretStored } from '../../lib/connection'
import { pushError, pushSuccess } from '../../lib/toast'
import type { AgentProvider, JournalSettings } from '../../lib/journal/types'
import { emitSettingsChanged, getCachedSettings } from './store'
import { SelectField } from './bits'
import { Field, FieldInput, SheetFrame, actionStyle } from '../productivity/SheetFrame'

export default function JournalSettingsSheet() {
  const [settings, setSettings] = useState<JournalSettings | null>(() => getCachedSettings())
  useEffect(() => {
    if (settings) return
    getJournal().then((d) => setSettings(d.settings)).catch((e) => {
      if (e instanceof AuthError) { void clearSecretStored(); return }
      pushError(e?.message || 'Settings could not load.')
    })
  }, [settings])
  if (settings) return <SettingsForm settings={settings} />
  return (
    <SheetFrame kicker="Voice journal" title="Journal settings" onClose={() => router.back()}>
      <Spinner />
    </SheetFrame>
  )
}

function SettingsForm({ settings }: { settings: JournalSettings }) {
  const [minutes, setMinutes] = useState(String(settings.ingestDelayMinutes))
  const [keepDays, setKeepDays] = useState(String(settings.keepAudioDays))
  const [vocab, setVocab] = useState(settings.vocabulary)
  const [provider, setProvider] = useState(settings.provider)
  const [model, setModel] = useState(settings.model)
  const [effort, setEffort] = useState(settings.effort)
  const [providers, setProviders] = useState<AgentProvider[] | null>(null)
  const [catalogError, setCatalogError] = useState('')
  const [busy, setBusy] = useState(false)

  // The catalog is a few CLI calls behind the bridge, so the form is usable before
  // it lands: the current choice is shown as-is until the real list replaces it.
  useEffect(() => {
    let cancelled = false
    getAgentModels()
      .then((data) => { if (!cancelled) setProviders(data.providers) })
      .catch((e) => { if (!cancelled) setCatalogError(e instanceof Error ? e.message : 'Model list unavailable.') })
    return () => { cancelled = true }
  }, [])

  const chosen = useMemo(
    () => providers?.find((p) => p.provider === (provider || providers.find((x) => x.isDefault)?.provider)) || null,
    [providers, provider],
  )
  const defaultProviderName = providers?.find((p) => p.isDefault)?.name || 'the default'
  const chosenModel = chosen?.models.find((m) => m.id === model) || null
  const reasoningLevels = chosenModel?.reasoningLevels?.length ? chosenModel.reasoningLevels : []
  const recommended = chosen?.models.find((m) => m.recommended)

  const dirty =
    Number(minutes) !== settings.ingestDelayMinutes ||
    Number(keepDays) !== settings.keepAudioDays ||
    vocab !== settings.vocabulary ||
    provider !== settings.provider ||
    model !== settings.model ||
    effort !== settings.effort

  const submit = async () => {
    setBusy(true)
    try {
      const { settings: next } = await updateJournalSettings({
        ingestDelayMinutes: Number(minutes),
        keepAudioDays: Number(keepDays),
        vocabulary: vocab,
        provider,
        model,
        // A reasoning level the chosen model does not offer is worse than none.
        effort: reasoningLevels.includes(effort) ? effort : '',
      })
      emitSettingsChanged(next)
      success()
      pushSuccess('Journal settings saved.')
      router.back()
    } catch (e) {
      if (e instanceof AuthError) { void clearSecretStored(); return }
      pushError(e instanceof Error ? e.message : 'Settings could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const providerOptions = [
    { value: '', label: `Default (${defaultProviderName})` },
    ...(providers || []).map((p) => ({ value: p.provider, label: `${p.name}${p.state !== 'ready' && p.state !== 'unknown' ? ` — ${p.state}` : ''}` })),
  ]
  // Before the catalog lands, a saved choice still shows by its id.
  if (provider && !providerOptions.some((o) => o.value === provider)) providerOptions.push({ value: provider, label: provider })
  const modelOptions = [
    { value: '', label: chosen ? `Default${recommended ? ` (${recommended.name})` : ''}` : 'Default' },
    // A model saved before the catalog moved on still shows, rather than silently
    // reading as "Default" while the digest uses it.
    ...(model && !chosen?.models.some((m) => m.id === model) ? [{ value: model, label: `${model} (not in the current list)` }] : []),
    ...(chosen?.models || []).map((m) => ({ value: m.id, label: `${m.name}${m.recommended ? ' — recommended' : ''}` })),
  ]
  const effortOptions = [
    { value: '', label: `Default${chosenModel?.defaultReasoning ? ` (${chosenModel.defaultReasoning})` : ''}` },
    ...reasoningLevels.map((level) => ({ value: level, label: level })),
  ]

  const close = () => router.back()
  return (
    <SheetFrame
      kicker="Voice journal"
      title="Journal settings"
      onClose={close}
      actions={(
        <>
          <Btn title="Cancel" onPress={close} style={actionStyle} />
          <Btn title={busy ? 'Saving…' : 'Save'} kind="primary" disabled={!dirty || busy} onPress={submit} style={actionStyle} />
        </>
      )}
    >
      <Field label="Don’t-ingest window" help="The digest waits this long so you can stop it. Zero runs it as soon as the transcript exists.">
        <View style={st.row}>
          <FieldInput value={minutes} onChangeText={setMinutes} keyboardType="number-pad" style={{ width: 92 }} />
          <T size={12.5} muted>minutes after Save</T>
        </View>
      </Field>

      <Field
        label="Keep recordings for"
        help="The transcript is the permanent record; the audio is a grace period in case you want to keep a copy. Zero deletes it the moment the words exist. Individual entries can be kept for good from their ⋯ menu."
      >
        <View style={st.row}>
          <FieldInput value={keepDays} onChangeText={setKeepDays} keyboardType="number-pad" style={{ width: 92 }} />
          <T size={12.5} muted>days after transcribing</T>
        </View>
      </Field>

      <Field label="Names & words to spell right" help="Handed to whisper as a hint. People, places, products — anything it keeps mishearing.">
        <FieldInput
          value={vocab}
          onChangeText={setVocab}
          multiline
          scrollEnabled={false}
          placeholder="Names, places and projects you mention…"
          style={{ minHeight: 64 }}
        />
      </Field>

      <View style={st.fieldset}>
        <T size={11} muted>Which AI digests an entry</T>
        <Field label="Agent">
          <SelectField title="Agent" value={provider} options={providerOptions} onChange={(v) => { setProvider(v); setModel(''); setEffort('') }} />
        </Field>
        <Field label="Model">
          <SelectField title="Model" value={model} options={modelOptions} disabled={!chosen} onChange={(v) => { setModel(v); setEffort('') }} />
        </Field>
        {reasoningLevels.length > 0 && (
          <Field label="Thinking">
            <SelectField title="Thinking" value={effort} options={effortOptions} onChange={setEffort} />
          </Field>
        )}
        {chosen && chosen.state !== 'ready' && chosen.state !== 'unknown' && (
          <Warn text={`${chosen.name} is ${chosen.state}${chosen.fix ? ` — ${chosen.fix}` : ''}. Digests will fail until that is fixed.`} />
        )}
        {catalogError ? <Warn text={catalogError} /> : null}
        <T size={11.5} muted lineHeight={17}>
          Leave these on Default to follow the Providers tab. The digest is a background job with a 30-minute
          budget, so a slower, more careful model is a fair trade here.
        </T>
      </View>

    </SheetFrame>
  )
}

function Warn({ text }: { text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
      <Hi icon={ExclamationTriangleIcon} size={13} color={colors.amber} style={{ marginTop: 2 }} />
      <T size={12} color={colors.amber} style={{ flex: 1 }}>{text}</T>
    </View>
  )
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fieldset: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 12, gap: 10 },
})
