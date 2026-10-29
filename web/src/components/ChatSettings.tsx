import React, { useEffect } from 'react'
import { useChat, ensureModels, savePrefs, providerById, type ChatPrefs } from '../chat/store'
import { visibleModels, EFFORT_LABELS } from '../chat/models'
import { pushError } from '../toast'
import { useSettings, setSetting } from '../settings'

// Settings → Chat: when quiet chats settle, the chat's glow (this device only),
// whether chats bring in totems, and who writes chat titles.
// "Pick for me" keeps Totem's own rule.

function Lane({ lane, title, hint }: { lane: 'titles'; title: string; hint: string }) {
  const prefs = useChat((s) => s.prefs)
  const providers = useChat((s) => s.providers)
  const models = useChat((s) => s.models)
  const caps = useChat((s) => s.caps)
  const value = prefs[lane]
  useEffect(() => { if (value.provider) ensureModels(value.provider) }, [value.provider])
  const row = value.provider ? providerById(value.provider) : null
  const list = value.provider ? visibleModels(models[value.provider]) : []
  const current = list.find((m) => m.id === value.model)
  const save = (patch: Partial<ChatPrefs['titles']>) => savePrefs({ [lane]: { ...value, ...patch } } as any).catch((e) => pushError(e.message))
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
      {current?.efforts && current.efforts.length > 0 && (
        <div className="setting-row">
          <div className="setting-copy"><strong>Title effort</strong><span>Lower is faster.</span></div>
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
  const glowOn = useSettings().chatGlow
  return (
    <div className="settings-pane">
      <header className="settings-pane-head">
        <h2>Chat</h2>
        <p>What sending does mid-reply, how the chat list tidies itself, how a chat looks, and who names chats. New chats start on your default model (Settings → AI); pick another in the composer.</p>
      </header>

      <div className="settings-section-title"><span /><strong>Sending</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy"><strong>Follow-up behaviour</strong><span>Queue follow-ups while the agent runs or steer the current run. Press Ctrl/⌘ + Enter (or Ctrl/⌘-click send) to do the opposite for one message. A queued message can still be sent as a steer from the queue.</span></div>
          <div className="setting-control">
            <select className="model-select" aria-label="Follow-up behaviour" value={prefs.followUp ?? 'queue'} onChange={(e) => save({ followUp: e.target.value as 'queue' | 'steer' })}>
              <option value="queue">Queue</option>
              <option value="steer">Steer</option>
            </select>
          </div>
        </div>
      </div>

      <div className="settings-section-title"><span /><strong>Chat list</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy"><strong>Settle quiet chats</strong><span>A chat with no activity for this long moves to its list’s Settled shelf on its own, as in T3 Code. Pinned chats, and chats you un-settle by hand, stay put.</span></div>
          <div className="setting-control">
            <select className="model-select" value={String(prefs.autoSettleDays ?? 3)} onChange={(e) => save({ autoSettleDays: Number(e.target.value) })}>
              {[1, 2, 3, 7, 14, 30].map((d) => <option key={d} value={d}>After {d} {d === 1 ? 'day' : 'days'}</option>)}
              <option value="0">Never</option>
            </select>
          </div>
        </div>
      </div>

      <div className="settings-section-title"><span /><strong>Appearance</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy"><strong>Colour glow</strong><span>Each chat’s moving colour glow. It keeps the graphics card busy for as long as a chat is open; turn it off for a plain background. Applies to this device only.</span></div>
          <div className="setting-control">
            <select className="model-select" value={glowOn ? 'on' : 'off'} onChange={(e) => setSetting('chatGlow', e.target.value === 'on')}>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </div>
        </div>
      </div>

      <div className="settings-section-title"><span /><strong>Totems</strong></div>
      <div className="setting-list">
        <div className="setting-row">
          <div className="setting-copy"><strong>Let chats bring in totems</strong><span>Any chat’s agent can find your totems and ask one when a request is its job; it joins the chat and answers under its own name, from its own memory and tools. Group chats you start yourself work either way.</span></div>
          <div className="setting-control">
            <select className="model-select" value={prefs.totemsInChat === false ? 'off' : 'on'} onChange={(e) => save({ totemsInChat: e.target.value === 'on' })}>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </div>
        </div>
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
