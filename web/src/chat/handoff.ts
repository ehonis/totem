import type { ChatMessage } from './types'

// A chat can move between accounts mid-way (start on Codex, carry on with
// Claude). The bridge hands the new account what it missed (planHistory in
// chat/turn.mjs); this marks where in the transcript each move happened, so the
// log shows a divider above the turn that moved.

// What the picker says when a started chat is about to change account.
export function handoffNote(from: string, to: string): string {
  return `${to} takes over from ${from}. It reads the chat so far and carries on from there.`
}

export interface Switch { from: string; to: string }

// Keyed by the id of the message the divider sits above: the owner's message
// that started the first turn on the new account (or the reply itself when no
// message of the owner's precedes it). The first reply has nothing to move
// from, and replies with no recorded provider (older threads) neither start nor
// break a run.
export function providerSwitches(messages: ChatMessage[]): Map<string, Switch> {
  const out = new Map<string, Switch>()
  let last = ''
  let turn = ''
  for (const m of messages) {
    if (m.role === 'user') { turn = m.id; continue }
    if (!m.provider) continue
    if (last && m.provider !== last) out.set(turn || m.id, { from: last, to: m.provider })
    last = m.provider
    turn = ''
  }
  return out
}
