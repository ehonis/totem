// mark_chat_done: the agent's word that a one-off request is finished ("add a
// task for X", and the task is made), on each chat run's /agent-mcp beside
// ask_questions. It sets `doneAt` on the thread and nothing else. The lists
// read it (web/src/chat/settle.ts): until the owner has read the reply the row
// offers a one-tap Settle, and once it is read the chat settles by itself. His
// next message clears it (startChatTurn), as it does every other settle field.

export const DONE_TOOL = 'mark_chat_done'

export const DONE_TOOL_DESCRIPTOR = {
  name: DONE_TOOL,
  title: 'Mark this chat done',
  description:
    'Mark this chat as finished. Call it when this reply fully completes a one-off request (for example ' +
    '"add a task for X" and the task is made) and nothing is left to discuss and you are not waiting on the owner. ' +
    'Call it before you write your answer, then write the whole answer as your reply: the owner sees only your reply text, ' +
    'never your thinking, and the reply is the text after your last tool call. ' +
    'The owner gets a one-tap Settle on the chat, and it moves to the Settled shelf by itself once they have read your reply. ' +
    'Do not call it when you asked a question, need anything from the owner, hit an error, or the conversation is ongoing. ' +
    'It changes nothing else. Never mention in your reply that you marked the chat done.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Mark this chat done', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}

// Opus has been seen writing its whole answer as thinking, calling this, and then
// replying only "I've marked this chat as done." The owner never sees thinking,
// so the result says plainly what is still owed, harder when the reply has no
// text at all yet (`answered`, from the run's reply so far).
export function doneResult({ answered = true } = {}) {
  return answered
    ? 'Marked done. The owner sees only your reply text, never your thinking. If your full answer is not already in your ' +
      'reply text, write it now. Do not mention that you marked the chat done.'
    : 'Marked done. The owner has not seen any answer yet: your thinking is never shown to them. Write your complete answer ' +
      'to their request now, as your reply. Do not mention that you marked the chat done.'
}

export const DONE_RULES =
  `ONE-OFF REQUESTS: When this reply fully completes a one-off request and nothing is left to discuss, call ${DONE_TOOL} ` +
  '(in the totem-browser server, or browser__mark_chat_done through totem-gateway) once, so the chat settles after the owner reads it. ' +
  'Call it before you write your answer, then write the answer in full as reply text; never answer only "marked done". ' +
  'Never call it if you asked something, are waiting on the owner, something failed, or the conversation is still going.'
