// Settings → Voice (web VoiceSettings.tsx): the engine voice mode uses, Realtime's
// model and voice, and what it has cost. The web's "Reading voice" and "Speaking
// rate" rows pick a browser speech voice, which the app doesn't use, so they are
// left out.
import React, { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import { api } from '../../../lib/api'
import { WarnIcon } from '../../../lib/icons'
import { pushError } from '../../../lib/toast'
import { colors, alpha } from '../../../theme'
import { T } from '../../../ui/Text'
import { Spinner } from '../../../ui/kit'
import { PaneHead, SectionTitle, Select, SettingList, SettingRow } from '../ui'

interface Status {
  realtime: { configured: boolean; model: string; voice: string; voices: string[]; models: { id: string; name: string; note: string }[] }
  local: { ready: boolean }
  settings: { engine: 'auto' | 'realtime' | 'local'; model: string; voice: string }
  spend: { today: number; month: number }
}

const money = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)

export default function VoicePane() {
  const [s, setS] = useState<Status | null>(null)
  const load = useCallback(() => api<Status>('/api/voice/status').then(setS).catch(() => {}), [])
  useEffect(() => { void load() }, [load])
  async function save(patch: Partial<Status['settings']>) {
    try {
      await api('/api/voice/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      void load()
    } catch (e: any) { pushError(e.message) }
  }
  const head = <PaneHead desc="How Totem talks in voice mode. Realtime is the ChatGPT-style one: it hears you, answers in a natural voice, lets you cut in, and uses your apps while you talk." />
  if (!s) return <>{head}<Spinner /></>
  const rt = s.realtime
  return (
    <>
      {head}

      {!rt.configured ? (
        <View style={{ flexDirection: 'row', gap: 8, padding: 12, marginTop: 10, borderRadius: 10, backgroundColor: alpha(colors.amber, 0.08), borderWidth: 1, borderColor: alpha(colors.amber, 0.3) }}>
          <WarnIcon />
          <T size={13} lineHeight={19} style={{ flex: 1 }}>
            Realtime needs an OpenAI API key (a ChatGPT subscription doesn’t include API use). Create one at
            platform.openai.com, add OPENAI_API_KEY=… to .env on the box, and restart the bridge.
            Until then voice mode uses the free local engine.
          </T>
        </View>
      ) : null}

      <SectionTitle title="Engine" />
      <SettingList>
        <SettingRow title="Voice engine" desc="Auto uses Realtime when a key is set, and local otherwise.">
          <Select
            value={s.settings.engine}
            onChange={(v) => save({ engine: v as any })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'realtime', label: 'Realtime (OpenAI)', disabled: !rt.configured },
              { value: 'local', label: 'Local (free)' },
            ]}
          />
        </SettingRow>
        <SettingRow title="Realtime model" desc={rt.models.find((m) => m.id === rt.model)?.note}>
          <Select value={rt.model} disabled={!rt.configured} onChange={(v) => save({ model: v })} options={rt.models.map((m) => ({ value: m.id, label: m.name }))} />
        </SettingRow>
        <SettingRow title="Realtime voice" desc="Marin and Cedar sound the most natural.">
          <Select value={rt.voice} disabled={!rt.configured} onChange={(v) => save({ voice: v })} options={rt.voices.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))} />
        </SettingRow>
        <SettingRow title="Spend" desc="Estimated from each response’s token usage at list prices.">
          <T size={13} muted align="right">{money(s.spend.today)} today{'\n'}{money(s.spend.month)} this month</T>
        </SettingRow>
      </SettingList>

      <SectionTitle title="Local voice" />
      <SettingList>
        <SettingRow title="Transcription" desc={`whisper.cpp on the box. ${s.local.ready ? 'Installed.' : 'Not installed: run scripts/install-whisper.sh.'}`} />
      </SettingList>
    </>
  )
}
