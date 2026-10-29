// browser/handoff.mjs — the agent handing the chat's browser to the owner.
//
// Some pages need the owner, not the agent: a sign-in, a captcha, a code sent to
// his phone. The agent calls `preview_handoff` with what it needs; the browser
// panel opens with a banner and lets him click and type into the page; the call
// waits (the run's clock held, as for ask_questions) until he presses Done or
// Skip, then the agent carries on in the same reply. If the call cannot wait that
// long (Codex's live window, a CLI that gave up), the handoff stays up and Done
// sends a message instead, which resumes the session.

export const HANDOFF_TOOL = 'preview_handoff'

export const HANDOFF_TOOL_DESCRIPTOR = {
  name: HANDOFF_TOOL,
  title: 'Hand the browser to the owner',
  description:
    "Give the owner control of this chat's browser for something only they should do on the current page: sign in, " +
    'enter a one-time code, solve a captcha, accept a consent screen. The browser panel opens beside the chat with your ' +
    'reason, and the owner clicks and types into the page directly. The call waits until the owner says they are done ' +
    '(or skips it), then returns; call preview_snapshot to see the page and carry on. Open the page first. Never ask the ' +
    'owner for a password or code in the chat instead.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'What the owner should do, in a few words, e.g. "Sign in to Gmail".' },
    },
    required: ['reason'],
    additionalProperties: false,
  },
  annotations: { title: 'Hand the browser to the owner', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}

export const HANDOFF_RULE =
  `When a page needs the owner (a sign-in, a one-time code, a captcha), open it and call ${HANDOFF_TOOL} with what he ` +
  'should do; it waits until he is done in the browser panel, then snapshot and carry on.'

export const normalizeReason = (input) => (typeof input?.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ').slice(0, 160) : '') || 'Take over the browser'

export const handoffDone = (reason, page) =>
  `The owner is done: "${reason}". The page is now ${page.url || 'blank'}${page.title ? ` (${page.title})` : ''}. ` +
  'Call preview_snapshot to see it, then carry on.'

export const handoffSkipped = (reason) =>
  `The owner skipped "${reason}" and did not do it. Do not try it yourself; carry on without it or tell him what is blocked.`

export const HANDOFF_LATER =
  'The owner has not finished in the browser yet. The panel stays open for him, and when he is done his next message will ' +
  'say so. End this reply now with one short sentence saying you are waiting on him in the browser.'

export const HANDOFF_GONE =
  'The call ended before the owner finished. The panel stays open for him; his next message will say when he is done. ' +
  'Finish this reply saying you are waiting on him in the browser.'

/** The message sent for him when Done is pressed after the call stopped waiting. */
export const handoffMessage = (reason, done) =>
  done ? `I'm done in the browser (${reason}). Carry on.` : `I skipped that in the browser (${reason}). Carry on without it.`
