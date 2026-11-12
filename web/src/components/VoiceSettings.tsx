import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { listVoices, preferredVoice, setPreferredVoice, speechRate, setSpeechRate, speechSupported } from '../chat/speech'
import { pushError } from '../toast'
import { SettingsLoading, SettingsNote, SettingsPage, SettingsRow, SettingsSection } from './settings/ui'

// Settings → Voice. Two engines: Realtime (OpenAI, the ChatGPT-style one, a few
// cents a conversation) and Local (whisper.cpp on the server plus this device's
// voices, free). "Auto" uses Realtime when an OpenAI key is set.

interface Status {
  realtime: { configured: boolean; model: string; voice: string; voices: string[]; models: { id: string; name: string; note: string }[] }
  local: { ready: boolean }
  settings: { engine: 'auto' | 'realtime' | 'local'; model: string; voice: string }
  spend: { today: number; month: number }
}

const money = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)

/** This device's voices, which Chrome loads after the page does. */
function useDeviceVoices() {
  const [voices, setVoices] = useState(() => listVoices())
  useEffect(() => {
    if (!speechSupported()) return
    const update = () => setVoices(listVoices())
    speechSynthesis.addEventListener?.('voiceschanged', update)
    update()
    return () => speechSynthesis.removeEventListener?.('voiceschanged', update)
  }, [])
  return voices
}

export default function VoiceSettings({ onNavigate }: { onNavigate?: (section: string, hash?: string | null) => void }) {
  const [s, setS] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const voices = useDeviceVoices()
  const [deviceVoice, setDeviceVoice] = useState(preferredVoice()?.name || '')
  const [rate, setRate] = useState(speechRate())

  const load = () => api<Status>('/api/voice/status').then(setS).catch((e) => setError(e.message))
  useEffect(() => { load() }, [])
  useEffect(() => { if (!deviceVoice && voices[0]) setDeviceVoice(preferredVoice()?.name || '') }, [voices, deviceVoice])

  async function save(patch: Partial<Status['settings']>) {
    try {
      await api('/api/voice/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      load()
    } catch (e: any) { pushError(e.message) }
  }

  function preview() {
    if (!speechSupported()) return
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance('This is how Totem sounds reading a reply aloud.')
    const v = voices.find((x) => x.name === deviceVoice)
    if (v) u.voice = v
    u.rate = rate
    speechSynthesis.speak(u)
  }

  if (!s) return <SettingsLoading error={error} />
  const rt = s.realtime
  return (
    <SettingsPage>
      {!rt.configured && (
        <SettingsNote tone="warn">
          <span>
            Realtime needs an OpenAI API key; a ChatGPT subscription does not include API use. Add one under{' '}
            {onNavigate ? <button type="button" className="s-link" onClick={() => onNavigate('providers', 'api-keys')}>Providers › API keys</button> : 'Providers › API keys'}.
            Until then voice mode uses the free local engine.
          </span>
        </SettingsNote>
      )}

      <SettingsSection title="Voice mode" description="How Totem listens and answers when you talk to it.">
        <SettingsRow
          id="voice-engine"
          title="Engine"
          description="Realtime hears you, answers in a natural voice, lets you cut in and uses your apps as you talk. Local is free and runs on your server. Auto picks Realtime when it can."
          status={rt.configured ? `Realtime spend: ${money(s.spend.today)} today · ${money(s.spend.month)} this month (estimated at list prices).` : undefined}
          control={
            <select className="model-select" aria-label="Voice engine" value={s.settings.engine} onChange={(e) => save({ engine: e.target.value as Status['settings']['engine'] })}>
              <option value="auto">Auto</option>
              <option value="realtime" disabled={!rt.configured}>Realtime (OpenAI)</option>
              <option value="local">Local (free)</option>
            </select>
          }
        />
        {rt.configured && (
          <>
            <SettingsRow
              id="realtime-model"
              title="Realtime model"
              description={rt.models.find((m) => m.id === rt.model)?.note}
              control={
                <select className="model-select" aria-label="Realtime model" value={rt.model} onChange={(e) => save({ model: e.target.value })}>
                  {rt.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              }
            />
            <SettingsRow
              id="realtime-voice"
              title="Realtime voice"
              description="Marin and Cedar sound the most natural."
              control={
                <select className="model-select" aria-label="Realtime voice" value={rt.voice} onChange={(e) => save({ voice: e.target.value })}>
                  {rt.voices.map((v) => <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>)}
                </select>
              }
            />
          </>
        )}
        <SettingsRow
          id="transcription"
          title="Local transcription"
          description={s.local.ready
            ? 'whisper.cpp on the server, for local voice mode and dictation.'
            : <>whisper.cpp on the server, for local voice mode and dictation. Install it with <code>scripts/install-whisper.sh</code>.</>}
          control={<span className={`pill ${s.local.ready ? 'pill-ok' : 'pill-warn'}`}>{s.local.ready ? 'Installed' : 'Not installed'}</span>}
        />
      </SettingsSection>

      {speechSupported() && (
        <SettingsSection title="Reading aloud" description="This device’s own voice, for local voice mode and Read aloud. Saved on this device only.">
          <SettingsRow
            id="reading-voice"
            title="Voice"
            description="Enhanced or Premium voices sound far better; download them in your device’s settings."
            control={
              <>
                <select className="model-select" aria-label="Reading voice" value={deviceVoice} onChange={(e) => { setPreferredVoice(e.target.value); setDeviceVoice(e.target.value) }}>
                  {voices.length ? voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>) : <option value="">Loading voices…</option>}
                </select>
                <button type="button" className="btn" onClick={preview}>Play</button>
              </>
            }
          />
          <SettingsRow
            id="speaking-rate"
            title="Speaking rate"
            description={`${rate.toFixed(2)}×`}
            control={
              <input type="range" aria-label="Speaking rate" min={0.7} max={1.6} step={0.05} value={rate}
                onChange={(e) => { const r = Number(e.target.value); setRate(r); setSpeechRate(r) }} />
            }
          />
        </SettingsSection>
      )}
    </SettingsPage>
  )
}
