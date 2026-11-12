import React from 'react'
import { UserMessage, AssistantMessage } from './Message'
import HandoffMark from './HandoffMark'
import { providerSwitches } from './handoff'
import { discardUnsent, editAndResend, providerById, regenerate, retryUnsent } from './store'
import type { ChatMessage, ModelRow, ProviderRow } from './types'

// The chat's messages. Memoized, with every row memoized too and given only
// stable props, so typing in the composer (the draft is the chat view's state)
// re-renders none of them, and a streaming reply re-renders only itself. The
// rows reach the store's actions themselves rather than taking closures from the
// chat view, which would be new on every render.

interface Props {
  threadId: string | null
  messages: ChatMessage[]
  busy: boolean
  /** The run's activity line, for the live reply only. */
  activity?: string
  /** The chat's account, for replies that do not name their own. */
  provider: string
  providers: ProviderRow[]
  models: Record<string, ModelRow[]>
  /** Put a discarded unsent message's text back in the composer. */
  onDiscarded: (text: string) => void
}

const UserRow = React.memo(function UserRow({ threadId, m, busy, onDiscarded }: { threadId: string | null; m: ChatMessage; busy: boolean; onDiscarded: (text: string) => void }) {
  const unsent = !!(m.unsent && threadId && !busy)
  return (
    <UserMessage
      m={m}
      canEdit={!busy && !m.id.startsWith('local-')}
      onEdit={(text) => { if (threadId) editAndResend(threadId, m.id, text) }}
      onRetry={unsent ? () => retryUnsent(threadId!) : undefined}
      onDiscard={unsent ? () => { const text = discardUnsent(threadId!); if (text) onDiscarded(text) } : undefined}
    />
  )
})

const AssistantRow = React.memo(function AssistantRow({ threadId, m, live, activity, provider, modelName, isLast, canRegenerate }: {
  threadId: string | null; m: ChatMessage; live: boolean; activity?: string; provider?: ProviderRow; modelName?: string; isLast: boolean; canRegenerate: boolean
}) {
  return (
    <AssistantMessage
      m={m}
      live={live}
      activity={activity}
      provider={provider}
      modelName={modelName}
      isLast={isLast}
      onRegenerate={canRegenerate ? () => regenerate(threadId!) : undefined}
    />
  )
})

/** A raw id ("gpt-6.1-sol", "composer-2.5[fast=true]") as its catalog name. */
function modelName(models: Record<string, ModelRow[]>, provider?: string, model?: string) {
  if (!provider || !model) return undefined
  const id = model.split('[')[0]
  return models[provider]?.find((x) => x.id === id)?.name
}

export default React.memo(function MessageLog({ threadId, messages, busy, activity, provider, providers, models, onDiscarded }: Props) {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  // The chat moving to another account (chat/handoff.ts): a divider where each move happened.
  const switches = providerSwitches(messages)
  return (
    <div className="vc-log">
      {messages.map((m, i) => {
        const live = busy && i === messages.length - 1
        const isLast = m === lastAssistant && i === messages.length - 1
        return (
          <React.Fragment key={m.id}>
            {switches.has(m.id) && <HandoffMark s={switches.get(m.id)!} />}
            {m.role === 'user'
              ? <UserRow threadId={threadId} m={m} busy={busy} onDiscarded={onDiscarded} />
              : <AssistantRow
                  threadId={threadId}
                  m={m}
                  live={live}
                  activity={live ? activity : undefined}
                  provider={providerById(m.provider || provider) || providers.find((p) => p.driver === m.provider)}
                  modelName={modelName(models, m.provider, m.model)}
                  isLast={isLast}
                  canRegenerate={isLast && !busy && !!threadId}
                />}
          </React.Fragment>
        )
      })}
    </div>
  )
})
