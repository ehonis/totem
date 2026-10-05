import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { WarnIcon } from '../icons'
import { listVoices, preferredVoice, setPreferredVoice, speechRate, setSpeechRate, speechSupported } from '../chat/speech'

// Settings → Voice. Two engines: Realtime (OpenAI, the ChatGPT-style one, costs a
// few cents a conversation) and Local (whisper.cpp on the box plus this device's
// voices, free). "Auto" uses Realtime when a key is configured.

interface Status {
  realtime: { configured: boolean; model: string; voice: string; voices: string[]; models: { id: string; name: string; note: string }[] }
  local: { ready: boolean }
  settings: { engine: 'auto' | 'realtime' | 'local'; model: string; voice: string }
  spend: { today: number; month: number }
}

const money = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)

export default function VoiceSettings() {
  const [s, setS] = useState<Status | null>(null)
  const [deviceVoice, setDeviceVoice] = useState(preferredVoice()?.name || '')
  const [rate, setRate] = useState(speechRate())
  const load = () => api<Status>('/api/voice/status').then(setS).catch(() => {})
  useEffect(() => { load() }, [])
  async function save(patch: Partial<Status['settings']>) {
    await api('/api/voice/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    load()
  }
  if (!s) return <div className="settings-pane"><header className="settings-pane-head"><h2>Voice</h2></header></div>
  const rt = s.realtime
  return (
    <div className="settings-pane">
      <header className="settings-pane-head">
        <h2>Voice</h2>
        <p>How Totem talks in voice mode. Realtime is the ChatGPT-style one: it hears you, answers in a natural voice, lets you cut in, and uses your apps while you talk.</p>
      </header>

      {!rt.configured && (
        <div className="shortcut-warn">
          <WarnIcon />
          <span>
            Realtime needs an OpenAI API key (a ChatGPT subscription doesn’t include API use). Create one at
            platform.openai.com, add <code>OPENAI_API_KEY=…</code> to <code>.env</code> on the box, and restart the bridge.
            Until then voice mode uses the free local engine.
          </span>
        </div>
      )}

      <div className="settings-section-title"><span /><strong>Engine</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy">
            <strong>Voice engine</strong>
            <span>Auto uses Realtime when a key is set, and local otherwise.</span>
          </div>
          <div className="setting-control">
            <select className="model-select" value={s.settings.engine} onChange={(e) => save({ engine: e.target.value as any })}>
              <option value="auto">Auto</option>
              <option value="realtime" disabled={!rt.configured}>Realtime (OpenAI)</option>
              <option value="local">Local (free)</option>
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>Realtime model</strong>
            <span>{rt.models.find((m) => m.id === rt.model)?.note}</span>
          </div>
          <div className="setting-control">
            <select className="model-select" value={rt.model} onChange={(e) => save({ model: e.target.value })} disabled={!rt.configured}>
              {rt.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>Realtime voice</strong>
            <span>Marin and Cedar sound the most natural.</span>
          </div>
          <div className="setting-control">
            <select className="model-select" value={rt.voice} onChange={(e) => save({ voice: e.target.value })} disabled={!rt.configured}>
              {rt.voices.map((v) => <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>)}
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>Spend</strong>
            <span>Estimated from each response’s token usage at list prices.</span>
          </div>
          <div className="setting-control"><span className="muted">{money(s.spend.today)} today · {money(s.spend.month)} this month</span></div>
        </div>
      </div>

      <div className="settings-section-title"><span /><strong>Local voice</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy">
            <strong>Transcription</strong>
            <span>whisper.cpp on the box. {s.local.ready ? 'Installed.' : 'Not installed: run scripts/install-whisper.sh.'}</span>
          </div>
        </div>
        {speechSupported() && (
          <>
            <div className="setting-row">
              <div className="setting-copy">
                <strong>Reading voice</strong>
                <span>This device’s voice for local voice mode and “Read aloud”. Enhanced or Premium voices sound far better; download them in your device’s settings.</span>
              </div>
              <div className="setting-control">
                <select className="model-select" value={deviceVoice} onChange={(e) => { setPreferredVoice(e.target.value); setDeviceVoice(e.target.value) }}>
                  {listVoices().map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                </select>
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-copy"><strong>Speaking rate</strong><span>{rate.toFixed(2)}×</span></div>
              <div className="setting-control">
                <input type="range" min={0.8} max={1.4} step={0.05} value={rate} onChange={(e) => { const r = Number(e.target.value); setRate(r); setSpeechRate(r) }} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
