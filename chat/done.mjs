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
    'Mark this chat as finished. Call it at the end of a reply that fully completes a one-off request (for example ' +
    '"add a task for X" and the task is made) when nothing is left to discuss and you are not waiting on the owner. ' +
    'The owner gets a one-tap Settle on the chat, and it moves to the Settled shelf by itself once they have read your reply. ' +
    'Do not call it when you asked a question, need anything from the owner, hit an error, or the conversation is ongoing. ' +
    'It changes nothing else; still write your reply as usual.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Mark this chat done', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}

export const DONE_RESULT = 'Marked done. The chat will settle once the owner has read your reply. Finish your reply as usual.'

export const DONE_RULES =
  `ONE-OFF REQUESTS: When this reply fully completes a one-off request and nothing is left to discuss, call ${DONE_TOOL} ` +
  '(in the totem-browser server, or browser__mark_chat_done through totem-gateway) once, so the chat settles after the owner reads it. ' +
  'Never call it if you asked something, are waiting on the owner, something failed, or the conversation is still going.'
