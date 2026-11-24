import React from 'react'
import { UserMessage, AssistantMessage } from './Message'
import HandoffMark from './HandoffMark'
import { providerSwitches } from './handoff'
import { isCompactionTurn } from './context'
import { discardUnsent, editAndResend, providerById, regenerate, retryUnsent } from './store'
import type { Attachment, ChatMessage, ModelRow, ProviderRow } from './types'

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
  /**
   * Put an unsent message's words and files back into a draft: discarded, or
   * (`refusedIn`, the chat's id) retried and refused by the bridge.
   */
  onDiscarded: (text: string, attachments?: Attachment[], refusedIn?: string) => void
  /** Older messages the bridge has (history.ts): offer them, say they are coming, or that they failed. */
  earlier?: 'more' | 'loading' | 'error'
  /** Read the page before the first message here. Stable, so the log stays memoized. */
  onLoadEarlier?: () => void
}

const UserRow = React.memo(function UserRow({ threadId, m, busy, onDiscarded }: { threadId: string | null; m: ChatMessage; busy: boolean; onDiscarded: (text: string, attachments?: Attachment[], refusedIn?: string) => void }) {
  const unsent = !!(m.unsent && threadId && !busy)
  return (
    <UserMessage
      m={m}
      canEdit={!busy && !m.id.startsWith('local-')}
      onEdit={(text) => { if (threadId) editAndResend(threadId, m.id, text) }}
      onRetry={unsent ? () => retryUnsent(threadId!, () => onDiscarded(m.content, m.attachments, threadId!)) : undefined}
      onDiscard={unsent ? () => { const text = discardUnsent(threadId!); if (text || m.attachments?.length) onDiscarded(text, m.attachments) } : undefined}
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

/** The top of a chat loaded a window at a time: T3 Code's "Load earlier turns". */
function EarlierControl({ state, onLoad }: { state: 'more' | 'loading' | 'error'; onLoad?: () => void }) {
  return (
    <div className="vc-history">
      {state === 'loading'
        ? <span className="vc-history-note vc-shimmer" role="status">Loading earlier messages…</span>
        : <button type="button" className="vc-btn sm ghost vc-history-btn" onClick={onLoad}>{state === 'error' ? 'Couldn’t load earlier messages · Try again' : 'Load earlier messages'}</button>}
    </div>
  )
}

export default React.memo(function MessageLog({ threadId, messages, busy, activity, provider, providers, models, onDiscarded, earlier, onLoadEarlier }: Props) {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  // The chat moving to another account (chat/handoff.ts): a divider where each move happened.
  const switches = providerSwitches(messages)
  return (
    <div className="vc-log">
      {earlier && <EarlierControl state={earlier} onLoad={onLoadEarlier} />}
      {messages.map((m, i) => {
        const live = busy && i === messages.length - 1
        const isLast = m === lastAssistant && i === messages.length - 1
        // `/compact` (context.ts): its reply's divider stands for the whole turn.
        const compaction = isCompactionTurn(m) || isCompactionTurn(messages[i - 1])
        if (isCompactionTurn(m) && !m.unsent) return switches.has(m.id) ? <HandoffMark key={m.id} s={switches.get(m.id)!} /> : null
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
                  canRegenerate={isLast && !busy && !!threadId && !compaction}
                />}
          </React.Fragment>
        )
      })}
    </div>
  )
})
