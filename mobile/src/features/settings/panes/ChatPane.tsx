// Settings → Chat (web ChatSettings.tsx): when quiet chats settle, and who
// writes chat titles. "Pick for me" keeps Totem's own rule. Auto, Instant and
// Thinking are retired upstream; the composer's model sheet is the only choice.
import React, { useEffect } from 'react'
import { useChat, ensureModels, savePrefs, providerById, type ChatPrefs } from '../../../lib/chat/store'
import { visibleModels, EFFORT_LABELS } from '../../../lib/chat/models'
import { pushError } from '../../../lib/toast'
import { PaneHead, SectionTitle, Select, SettingList, SettingRow } from '../ui'

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
      <SettingRow title={title} desc={hint}>
        <Select
          value={value.provider}
          onChange={(v) => save({ provider: v, model: '', effort: '' })}
          options={[
            { value: '', label: 'Pick for me' },
            ...providers.map((p) => {
              const st = (caps as any)?.providers?.[p.id]?.state
              return { value: p.id, label: `${p.name}${st === 'missing' ? ' (not installed)' : st === 'logged-out' ? ' (signed out)' : ''}`, disabled: st === 'missing' || st === 'logged-out' }
            }),
          ]}
        />
      </SettingRow>
      {row?.supportsModelPicker ? (
        <SettingRow title={`${title} model`} desc={row.name}>
          <Select
            value={value.model}
            onChange={(v) => save({ model: v, effort: '' })}
            options={[{ value: '', label: 'Account default' }, ...list.map((m) => ({ value: m.id, label: m.name }))]}
          />
        </SettingRow>
      ) : null}
      {current?.efforts && current.efforts.length > 0 ? (
        <SettingRow title="Title effort" desc="Lower is faster.">
          <Select
            value={value.effort}
            onChange={(v) => save({ effort: v })}
            options={[{ value: '', label: 'Model default' }, ...current.efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] || e }))]}
          />
        </SettingRow>
      ) : null}
    </>
  )
}

export default function ChatPane() {
  const prefs = useChat((s) => s.prefs)
  const providers = useChat((s) => s.providers)
  useEffect(() => { for (const p of providers) ensureModels(p.id) }, [providers])
  const save = (patch: Partial<ChatPrefs>) => savePrefs(patch).catch((e) => pushError(e.message))
  return (
    <>
      <PaneHead desc="How the chat list tidies itself and who names chats. New chats start on your default model (Settings → AI); pick another in the composer." />

      <SectionTitle title="Chat list" />
      <SettingList>
        <SettingRow title="Settle quiet chats" desc="A chat with no activity for this long moves to its list’s Settled shelf on its own, as in T3 Code. Pinned chats, and chats you un-settle by hand, stay put.">
          <Select
            value={String(prefs.autoSettleDays ?? 3)}
            onChange={(v) => save({ autoSettleDays: Number(v) })}
            options={[
              ...[1, 2, 3, 7, 14, 30].map((d) => ({ value: String(d), label: `After ${d} ${d === 1 ? 'day' : 'days'}` })),
              { value: '0', label: 'Never' },
            ]}
          />
        </SettingRow>
      </SettingList>

      <SectionTitle title="Totems" />
      <SettingList>
        <SettingRow title="Let chats bring in totems" desc="Any chat’s agent can find your totems and ask one when a request is its job; it joins the chat and answers under its own name, from its own memory and tools. Group chats you start yourself work either way.">
          <Select
            value={prefs.totemsInChat === false ? 'off' : 'on'}
            onChange={(v) => save({ totemsInChat: v === 'on' })}
            options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
          />
        </SettingRow>
      </SettingList>

      <SectionTitle title="Titles" />
      <SettingList>
        <SettingRow title="Name chats automatically" desc="A few words in Title Case, the way Codex names threads, written in the background by a very small model.">
          <Select
            value={prefs.titles?.off ? 'off' : 'on'}
            onChange={(v) => save({ titles: { ...prefs.titles, off: v === 'off' } } as any)}
            options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off (use the first message)' }]}
          />
        </SettingRow>
        {!prefs.titles?.off ? <Lane lane="titles" title="Title account" hint="Pick for me uses Codex’s GPT 6 Luna at low effort (about 4 seconds, a fraction of a cent)." /> : null}
      </SettingList>
    </>
  )
}
