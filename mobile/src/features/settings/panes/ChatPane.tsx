// Settings → Chat (web ChatSettings.tsx): what sending does mid-reply, when quiet
// chats settle, whether chats bring in totems, and who writes chat titles ("Pick
// for me" keeps Totem's own rule). The chat's colour glow is a device setting,
// under Appearance.
import React, { useEffect } from 'react'
import { useChat, ensureModels, savePrefs, providerById, type ChatPrefs } from '../../../lib/chat/store'
import { visibleModels, EFFORT_LABELS } from '../../../lib/chat/models'
import { pushError } from '../../../lib/toast'
import { T } from '../../../ui/Text'
import { openPane } from '../open'
import { Link, Picker, Row, Section, Switch } from '../ui'

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
      <Row
        id="title-account"
        title={title}
        description={hint}
        control={
          <Picker
            label={title}
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
        }
      />
      {row?.supportsModelPicker ? (
        <Row
          title="Title model"
          description={`On ${row.name}.`}
          control={
            <Picker
              label="Title model"
              value={value.model}
              onChange={(v) => save({ model: v, effort: '' })}
              options={[{ value: '', label: 'Account default' }, ...list.map((m) => ({ value: m.id, label: m.name }))]}
            />
          }
        />
      ) : null}
      {current?.efforts && current.efforts.length > 0 ? (
        <Row
          title="Title effort"
          description="Lower is faster."
          control={
            <Picker
              label="Title effort"
              value={value.effort}
              onChange={(v) => save({ effort: v })}
              options={[{ value: '', label: 'Model default' }, ...current.efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] || e }))]}
            />
          }
        />
      ) : null}
    </>
  )
}

export default function ChatPane() {
  const prefs = useChat((s) => s.prefs)
  const providers = useChat((s) => s.providers)
  useEffect(() => { for (const p of providers) ensureModels(p.id) }, [providers])
  const save = (patch: Partial<ChatPrefs>) => savePrefs(patch).catch((e) => pushError(e.message))
  const titlesOn = !prefs.titles?.off
  return (
    <>
      <Section
        title="Sending"
        description={
          <T size={12.5} muted lineHeight={17}>
            New chats start on your default model, set under <Link title="Providers" onPress={() => openPane('providers', 'default-model')} />; pick another in the composer.
          </T>
        }
      >
        <Row
          id="follow-up"
          title="While a reply is running"
          description="What Send does with a new message. A long press on Send does the other one, and a queued message can still be sent as a steer."
          control={
            <Picker
              label="While a reply is running"
              value={prefs.followUp ?? 'queue'}
              onChange={(v) => save({ followUp: v as 'queue' | 'steer' })}
              options={[{ value: 'queue', label: 'Queue it for after' }, { value: 'steer', label: 'Steer the reply' }]}
            />
          }
        />
      </Section>

      <Section title="Chat list">
        <Row
          id="auto-settle"
          title="Settle quiet chats"
          description="A chat with no activity for this long moves to its list’s Settled shelf. Pinned chats, and ones you un-settle by hand, stay put."
          control={
            <Picker
              label="Settle quiet chats"
              value={String(prefs.autoSettleDays ?? 3)}
              onChange={(v) => save({ autoSettleDays: Number(v) })}
              options={[
                ...[1, 2, 3, 7, 14, 30].map((d) => ({ value: String(d), label: `After ${d} ${d === 1 ? 'day' : 'days'}` })),
                { value: '0', label: 'Never' },
              ]}
            />
          }
        />
      </Section>

      <Section title="Totems">
        <Row
          id="totems-in-chat"
          title="Let chats bring in totems"
          description="A chat’s agent can ask one of your totems when a request is its job; it answers under its own name, from its own memory and tools. Group chats you start yourself work either way."
          control={<Switch label="Let chats bring in totems" value={prefs.totemsInChat !== false} onChange={(v) => save({ totemsInChat: v })} />}
        />
      </Section>

      <Section title="Titles">
        <Row
          id="titles"
          title="Name chats automatically"
          description="A few words in Title Case, written in the background by a very small model. Off, a chat is named after its first message."
          control={<Switch label="Name chats automatically" value={titlesOn} onChange={(v) => save({ titles: { ...prefs.titles, off: !v } } as any)} />}
        />
        {titlesOn ? <Lane lane="titles" title="Title account" hint="Pick for me uses a small, cheap model at low effort: a few seconds and a fraction of a cent a chat." /> : null}
      </Section>
    </>
  )
}
