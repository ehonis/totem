import React, { useEffect } from 'react'
import { useChat, ensureModels, savePrefs, providerById, type ChatPrefs } from '../chat/store'
import { visibleModels, EFFORT_LABELS } from '../chat/models'
import { pushError } from '../toast'
import { SettingsPage, SettingsRow, SettingsSection, Switch } from './settings/ui'

// Settings → Chat: what sending does mid-reply, when quiet chats settle, whether
// chats bring in totems, and who writes chat titles ("Pick for me" keeps Totem's
// own rule). The chat's colour glow is a device setting, under Appearance.

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
      <SettingsRow id="title-account" title={title} description={hint} control={
          <select className="model-select" aria-label={title} value={value.provider} onChange={(e) => save({ provider: e.target.value, model: '', effort: '' })}>
            <option value="">Pick for me</option>
            {providers.map((p) => {
              const st = caps?.providers?.[p.id]?.state
              return <option key={p.id} value={p.id} disabled={st === 'missing' || st === 'logged-out'}>{p.name}{st === 'missing' ? ' (not installed)' : st === 'logged-out' ? ' (signed out)' : ''}</option>
            })}
          </select>
      } />
      {row?.supportsModelPicker && (
        <SettingsRow title="Title model" description={`On ${row.name}.`} control={
            <select className="model-select" aria-label="Title model" value={value.model} onChange={(e) => save({ model: e.target.value, effort: '' })}>
              <option value="">Account default</option>
              {list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
        } />
      )}
      {current?.efforts && current.efforts.length > 0 && (
        <SettingsRow title="Title effort" description="Lower is faster." control={
            <select className="model-select" aria-label="Title effort" value={value.effort} onChange={(e) => save({ effort: e.target.value })}>
              <option value="">Model default</option>
              {current.efforts.map((e) => <option key={e} value={e}>{EFFORT_LABELS[e] || e}</option>)}
            </select>
        } />
      )}
    </>
  )
}

export default function ChatSettings({ onNavigate }: { onNavigate?: (section: string, hash?: string | null) => void }) {
  const prefs = useChat((s) => s.prefs)
  const providers = useChat((s) => s.providers)
  useEffect(() => { for (const p of providers) ensureModels(p.id) }, [providers])
  const save = (patch: Partial<ChatPrefs>) => savePrefs(patch).catch((e) => pushError(e.message))
  const titlesOn = !prefs.titles?.off
  return (
    <SettingsPage>
      <SettingsSection
        title="Sending"
        description={<>New chats start on your default model, set under {onNavigate ? <button type="button" className="s-link" onClick={() => onNavigate('providers', 'default-model')}>Providers</button> : 'Providers'}; pick another in the composer.</>}
      >
        <SettingsRow
          id="follow-up"
          title="While a reply is running"
          description="What Enter does with a new message. Ctrl/⌘ + Enter does the other one, and a queued message can still be sent as a steer."
          control={
            <select className="model-select" aria-label="While a reply is running" value={prefs.followUp ?? 'queue'} onChange={(e) => save({ followUp: e.target.value as 'queue' | 'steer' })}>
              <option value="queue">Queue it for after</option>
              <option value="steer">Steer the reply</option>
            </select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Chat list">
        <SettingsRow
          id="auto-settle"
          title="Settle quiet chats"
          description="A chat with no activity for this long moves to its list’s Settled shelf. Pinned chats, and ones you un-settle by hand, stay put."
          control={
            <select className="model-select" aria-label="Settle quiet chats" value={String(prefs.autoSettleDays ?? 3)} onChange={(e) => save({ autoSettleDays: Number(e.target.value) })}>
              {[1, 2, 3, 7, 14, 30].map((d) => <option key={d} value={d}>After {d} {d === 1 ? 'day' : 'days'}</option>)}
              <option value="0">Never</option>
            </select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Totems">
        <SettingsRow
          id="totems-in-chat"
          title="Let chats bring in totems"
          description="A chat’s agent can ask one of your totems when a request is its job; it answers under its own name, from its own memory and tools. Group chats you start yourself work either way."
          control={<Switch label="Let chats bring in totems" checked={prefs.totemsInChat !== false} onChange={(v) => save({ totemsInChat: v })} />}
        />
      </SettingsSection>

      <SettingsSection title="Titles">
        <SettingsRow
          id="titles"
          title="Name chats automatically"
          description="A few words in Title Case, written in the background by a very small model. Off, a chat is named after its first message."
          control={<Switch label="Name chats automatically" checked={titlesOn} onChange={(v) => save({ titles: { ...prefs.titles, off: !v } } as any)} />}
        />
        {titlesOn && <Lane lane="titles" title="Title account" hint="Pick for me uses a small, cheap model at low effort: a few seconds and a fraction of a cent a chat." />}
      </SettingsSection>
    </SettingsPage>
  )
}
