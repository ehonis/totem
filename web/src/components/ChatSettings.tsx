import React, { useEffect } from 'react'
import { useChat, ensureModels, savePrefs, providerById, type ChatPrefs } from '../chat/store'
import { visibleModels, EFFORT_LABELS, LEVEL_NAMES } from '../chat/models'
import { pushError } from '../toast'

// Settings → Chat. The global choices behind the chat's model chip: what a new
// chat starts on, and which account and model Instant and Thinking use (Auto
// picks between those two per message). "Pick for me" keeps Totem's own rules.

function Lane({ lane, title, hint }: { lane: 'instant' | 'thinking' | 'titles'; title: string; hint: string }) {
  const prefs = useChat((s) => s.prefs)
  const providers = useChat((s) => s.providers)
  const models = useChat((s) => s.models)
  const caps = useChat((s) => s.caps)
  const value = prefs[lane] as ChatPrefs['instant']
  useEffect(() => { if (value.provider) ensureModels(value.provider) }, [value.provider])
  const row = value.provider ? providerById(value.provider) : null
  const list = value.provider ? visibleModels(models[value.provider]) : []
  const current = list.find((m) => m.id === value.model)
  const save = (patch: Partial<ChatPrefs['instant']>) => savePrefs({ [lane]: { ...value, ...patch } } as any).catch((e) => pushError(e.message))
  return (
    <>
      <div className="setting-row">
        <div className="setting-copy"><strong>{title}</strong><span>{hint}</span></div>
        <div className="setting-control">
          <select className="model-select" value={value.provider} onChange={(e) => save({ provider: e.target.value, model: '', effort: '' })}>
            <option value="">Pick for me</option>
            {providers.map((p) => {
              const st = caps?.providers?.[p.id]?.state
              return <option key={p.id} value={p.id} disabled={st === 'missing' || st === 'logged-out'}>{p.name}{st === 'missing' ? ' (not installed)' : st === 'logged-out' ? ' (signed out)' : ''}</option>
            })}
          </select>
        </div>
      </div>
      {row?.supportsModelPicker && (
        <div className="setting-row">
          <div className="setting-copy"><strong>{title} model</strong><span>{row.name}</span></div>
          <div className="setting-control">
            <select className="model-select" value={value.model} onChange={(e) => save({ model: e.target.value, effort: '' })}>
              <option value="">Account default</option>
              {list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
      )}
      {(lane === 'instant' || lane === 'titles') && current?.efforts && current.efforts.length > 0 && (
        <div className="setting-row">
          <div className="setting-copy"><strong>{lane === 'titles' ? 'Title effort' : 'Instant effort'}</strong><span>Lower is faster.</span></div>
          <div className="setting-control">
            <select className="model-select" value={value.effort} onChange={(e) => save({ effort: e.target.value })}>
              <option value="">Model default</option>
              {current.efforts.map((e) => <option key={e} value={e}>{EFFORT_LABELS[e] || e}</option>)}
            </select>
          </div>
        </div>
      )}
    </>
  )
}

export default function ChatSettings() {
  const prefs = useChat((s) => s.prefs)
  const providers = useChat((s) => s.providers)
  useEffect(() => { for (const p of providers) ensureModels(p.id) }, [providers])
  const save = (patch: Partial<ChatPrefs>) => savePrefs(patch).catch((e) => pushError(e.message))
  return (
    <div className="settings-pane">
      <header className="settings-pane-head">
        <h2>Chat</h2>
        <p>Defaults for new chats and the models behind Auto, Instant and Thinking. A chat keeps the account it started on; start a new chat to switch.</p>
      </header>

      <div className="settings-section-title"><span /><strong>New chats</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy"><strong>Start in</strong><span>Auto decides per message between Instant and Thinking.</span></div>
          <div className="setting-control">
            <select className="model-select" value={prefs.defaultPreset} onChange={(e) => save({ defaultPreset: e.target.value as any })}>
              <option value="auto">Auto</option>
              <option value="instant">Instant</option>
              <option value="thinking">Thinking</option>
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy"><strong>Thinking effort</strong><span>Where the Thinking slider starts.</span></div>
          <div className="setting-control">
            <select className="model-select" value={String(prefs.defaultLevel)} onChange={(e) => save({ defaultLevel: Number(e.target.value) })}>
              {['1', '2', '3', '4', '5'].map((l) => <option key={l} value={l}>{LEVEL_NAMES[l]}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="settings-section-title"><span /><strong>Instant</strong></div>
      <div className="setting-list">
        <Lane lane="instant" title="Instant account" hint="Quick answers. Pick for me uses the fastest signed-in account." />
      </div>

      <div className="settings-section-title"><span /><strong>Thinking</strong></div>
      <div className="setting-list">
        <Lane lane="thinking" title="Thinking account" hint="Careful answers at the effort you set. Pick for me uses your default account if it reasons, else Codex or Claude." />
      </div>

      <div className="settings-section-title"><span /><strong>Titles</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy"><strong>Name chats automatically</strong><span>A few words in Title Case, the way Codex names threads, written in the background by a very small model.</span></div>
          <div className="setting-control">
            <select className="model-select" value={prefs.titles?.off ? 'off' : 'on'} onChange={(e) => save({ titles: { ...prefs.titles, off: e.target.value === 'off' } } as any)}>
              <option value="on">On</option>
              <option value="off">Off (use the first message)</option>
            </select>
          </div>
        </div>
        {!prefs.titles?.off && <Lane lane="titles" title="Title account" hint="Pick for me uses Codex’s GPT 6 Luna at low effort (about 4 seconds, a fraction of a cent)." />}
      </div>
    </div>
  )
}
