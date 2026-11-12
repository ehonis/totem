// Settings → Voice (web VoiceSettings.tsx). Two engines: Realtime (OpenAI, the
// ChatGPT-style one, a few cents a conversation) and Local (whisper.cpp on the
// server, free). "Auto" uses Realtime when an OpenAI key is set. The web's
// Reading aloud section picks one of the browser's speech voices; the app has no
// read-aloud, so it is left out.
import React, { useCallback, useEffect, useState } from 'react'
import { api, AuthError } from '../../../lib/api'
import { pushError } from '../../../lib/toast'
import { T } from '../../../ui/Text'
import { openPane } from '../open'
import { Code, Link, Loading, Notice, Picker, Pill, Row, Section } from '../ui'

interface Status {
  realtime: { configured: boolean; model: string; voice: string; voices: string[]; models: { id: string; name: string; note: string }[] }
  local: { ready: boolean }
  settings: { engine: 'auto' | 'realtime' | 'local'; model: string; voice: string }
  spend: { today: number; month: number }
}

const money = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)

export default function VoicePane() {
  const [s, setS] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => api<Status>('/api/voice/status').then(setS).catch((e) => { if (!(e instanceof AuthError)) setError(e.message) }), [])
  useEffect(() => { void load() }, [load])

  async function save(patch: Partial<Status['settings']>) {
    try {
      await api('/api/voice/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      void load()
    } catch (e: any) { pushError(e.message) }
  }

  if (!s) return <Loading error={error} />
  const rt = s.realtime
  return (
    <>
      {!rt.configured ? (
        <Notice tone="warn">
          <T size={13} lineHeight={19}>
            Realtime needs an OpenAI API key; a ChatGPT subscription does not include API use. Add one under{' '}
            <Link title="Providers › API keys" onPress={() => openPane('providers', 'api-keys')} />.
            Until then voice mode uses the free local engine.
          </T>
        </Notice>
      ) : null}

      <Section title="Voice mode" description="How Totem listens and answers when you talk to it.">
        <Row
          id="voice-engine"
          title="Engine"
          description="Realtime hears you, answers in a natural voice, lets you cut in and uses your apps as you talk. Local is free and runs on your server. Auto picks Realtime when it can."
          status={rt.configured ? <T size={12.5} muted lineHeight={17}>Realtime spend: {money(s.spend.today)} today · {money(s.spend.month)} this month (estimated at list prices).</T> : undefined}
          control={
            <Picker
              label="Voice engine"
              value={s.settings.engine}
              onChange={(v) => save({ engine: v as Status['settings']['engine'] })}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'realtime', label: 'Realtime (OpenAI)', disabled: !rt.configured },
                { value: 'local', label: 'Local (free)' },
              ]}
            />
          }
        />
        {rt.configured ? (
          <>
            <Row
              id="realtime-model"
              title="Realtime model"
              description={rt.models.find((m) => m.id === rt.model)?.note}
              control={<Picker label="Realtime model" value={rt.model} onChange={(v) => save({ model: v })} options={rt.models.map((m) => ({ value: m.id, label: m.name }))} />}
            />
            <Row
              id="realtime-voice"
              title="Realtime voice"
              description="Marin and Cedar sound the most natural."
              control={<Picker label="Realtime voice" value={rt.voice} onChange={(v) => save({ voice: v })} options={rt.voices.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))} />}
            />
          </>
        ) : null}
        <Row
          id="transcription"
          title="Local transcription"
          description={s.local.ready
            ? 'whisper.cpp on the server, for local voice mode and dictation.'
            : <T size={12.5} muted lineHeight={17}>whisper.cpp on the server, for local voice mode and dictation. Install it with scripts/install-whisper.sh.</T>}
          control={<Pill label={s.local.ready ? 'Installed' : 'Not installed'} tone={s.local.ready ? 'ok' : 'warn'} />}
        />
      </Section>
      {!s.local.ready ? <Section plain><Code>scripts/install-whisper.sh</Code></Section> : null}
    </>
  )
}
