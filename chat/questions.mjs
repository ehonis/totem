// chat/questions.mjs — an agent asking the owner questions mid-reply.
//
// T3 Code's interactive questions: the agent calls a tool with a list of
// questions, each with options; the chat shows them one at a time above the
// composer; the owner picks or types an answer; the answers go back to the agent
// as the tool's result and the reply carries on. T3 catches the CLIs' own tools
// (Claude Code's AskUserQuestion, Codex's request_user_input), which cap a call
// at four and three questions. Totem serves its own tool instead, `ask_questions`
// on each run's /agent-mcp endpoint, so every CLI gets it and there is no cap.
//
// A question outlives the call that asked it. While the run is alive the call
// waits (live) and the run's clock is held, so an hour spent deciding is not an
// hour off the reply's budget. If the run ends first (Stop, a steer that cut the
// call off, a bridge restart, a CLI that gave up on the call), the question stays
// on the reply and answering it sends the answers as the next message, which
// resumes the same session: T3's "message mode".
//
// An answer can carry images or files (uploads, chat/uploads.mjs) with or
// without words. The agent gets each one's path on this machine, the way a
// chat message's attachments reach it, and opens it with its own file tools.

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export const ASK_TOOL = 'ask_questions'

export const ASK_TOOL_DESCRIPTOR = {
  name: ASK_TOOL,
  title: 'Ask the owner',
  description:
    'Ask the owner one or more questions and wait for the answers. Use it when you need the owner to choose between ' +
    'options or tell you something you cannot find out yourself, instead of writing the questions in your reply. Ask ' +
    'everything you need in one call: there is no limit on how many questions or options. The owner sees one question ' +
    'at a time with your options and can always type their own answer instead, so never add an "Other" option. Put the ' +
    'option you recommend first and end its label with " (Recommended)". The owner may answer with an image or file, ' +
    'which comes back as a path to open with your file tools. The call returns the answers; carry on with them.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        description: 'The questions, in the order to ask them. As many as you need.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The full question, ending with a question mark.' },
            header: { type: 'string', description: 'A short label for the question (one to three words), shown as a chip.' },
            options: {
              type: 'array',
              description: 'The choices. Leave out for a question that only takes a typed answer.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'The choice, in one to five words.' },
                  description: { type: 'string', description: 'What choosing it means, or its trade-off.' },
                },
                required: ['label'],
              },
            },
            multiSelect: { type: 'boolean', description: 'True when more than one option can be chosen.' },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
  annotations: { title: 'Ask the owner', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}

/** The tool's input, checked. Throws a message the agent can act on. */
export function normalizeQuestions(input) {
  const list = Array.isArray(input?.questions) ? input.questions : null
  if (!list?.length) throw new Error('questions must be a non-empty array')
  return list.map((q, i) => {
    const question = str(q?.question, 2000)
    if (!question) throw new Error(`question ${i + 1} has no text`)
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o) => (typeof o === 'string' ? { label: str(o, 200) } : { label: str(o?.label, 200), description: str(o?.description, 1000) }))
      .filter((o) => o.label)
      .map((o) => (o.description && o.description !== o.label ? o : { label: o.label }))
    return {
      id: `q${i + 1}`,
      header: str(q?.header, 40) || `Question ${i + 1}`,
      question,
      options,
      ...(q?.multiSelect === true && options.length > 1 ? { multiSelect: true } : {}),
    }
  })
}

/**
 * The owner's answers, checked against the questions. `answers` maps question id
 * to a list of strings (chosen labels, or the owner's own words). Every question
 * needs one, unless `attached` (question id to upload ids) gives it a file.
 */
export function normalizeAnswers(questions, answers, attached = {}) {
  const out = {}
  for (const q of questions) {
    const given = answers?.[q.id]
    const list = (Array.isArray(given) ? given : typeof given === 'string' ? [given] : [])
      .map((a) => str(a, 8000)).filter(Boolean)
    if (!list.length && !attached?.[q.id]?.length) throw Object.assign(new Error(`answer "${q.header}" first`), { status: 400 })
    out[q.id] = q.multiSelect ? list : list.slice(0, 1)
  }
  return out
}

/** Upload ids per question from a request body, valid ids only, at most `max` each. */
export function attachedIds(questions, attached, valid, max = 10) {
  const out = {}
  for (const q of questions) {
    const ids = (Array.isArray(attached?.[q.id]) ? attached[q.id] : []).filter(valid).slice(0, max)
    if (ids.length) out[q.id] = ids
  }
  return out
}

const answerLine = (q, answers) => (answers?.[q.id] || []).join(', ')
const kb = (f) => Math.max(1, Math.round((f.size || 0) / 1024))

/**
 * The tool's result: each question with its answer. `files` maps question id to
 * the uploads sent with it ({ name, kind, mime, size, path }).
 */
export function answersForAgent(questions, answers, files = {}) {
  const lines = questions.map((q) => {
    const sent = files?.[q.id] || []
    const words = answerLine(q, answers) || (sent.length ? '(answered with the attachment below)' : '')
    const att = sent.map((f) => `\n  Attached ${f.kind === 'image' ? 'image' : f.mime}, ${f.name} (${kb(f)} KB): ${f.path}`).join('')
    return `Q: ${q.question}\nA: ${words}${att}`
  })
  const open = Object.values(files || {}).some((l) => l?.length) ? ' Open the attached files with your file tools.' : ''
  return `The owner answered your questions:\n\n${lines.join('\n\n')}\n\nCarry on with these answers.${open}`
}

/**
 * The message sent when the run that asked has ended (T3's message mode). The
 * files go with that message as its attachments; this only names them.
 */
export function answersMessage(questions, answers, files = {}) {
  const lines = questions.map((q) => {
    const names = (files?.[q.id] || []).map((f) => `[attached: ${f.name}]`)
    return `${q.question}\n${[answerLine(q, answers), ...names].filter(Boolean).join(' ')}`
  })
  return `Answers to your questions:\n\n${lines.join('\n\n')}`
}

export const DISMISSED_FOR_AGENT =
  'The owner dismissed these questions without answering. Do not ask them again in this reply; carry on with your best judgement, and say what you assumed.'

export const QUESTIONS_LATER_FOR_AGENT =
  'The owner has not answered yet. The questions stay on screen, and the answers will arrive as the owner\'s next message. ' +
  'End this reply now with one short sentence saying you are waiting on those answers. Do not guess the answers or carry on without them.'

export const QUESTION_RULES =
  `QUESTIONS: When you need the owner to choose or decide something before you can go on well, call ${ASK_TOOL} ` +
  '(in the totem-browser server, or browser__ask_questions through totem-gateway) rather than writing the questions in your reply. ' +
  'Put every question you have in that one call, with concrete options where there are any; there is no limit on how many. ' +
  'It waits for the answers. Do not use it for things you can find out yourself, and never write a multiple-choice question as plain text.'

/**
 * The questions waiting on live tool calls, by part id. `answer` hands the
 * owner's answers to the call; false when no call is waiting (the run ended).
 */
export function createQuestionWaits() {
  const waits = new Map() // partId -> { threadId, settle }

  return {
    /** Wait for an answer. Resolves { answers, files } or { dismissed: true }, or { gone: true } on abort. */
    wait(partId, threadId, signal) {
      return new Promise((resolve) => {
        const settle = (v) => { if (waits.get(partId)?.settle === settle) waits.delete(partId); signal?.removeEventListener?.('abort', onAbort); resolve(v) }
        const onAbort = () => settle({ gone: true })
        waits.set(partId, { threadId, settle })
        if (signal?.aborted) onAbort()
        else signal?.addEventListener?.('abort', onAbort, { once: true })
      })
    },
    answer(partId, answers, files = {}) {
      const w = waits.get(partId)
      if (!w) return false
      w.settle({ answers, files })
      return true
    },
    dismiss(partId) {
      const w = waits.get(partId)
      if (!w) return false
      w.settle({ dismissed: true })
      return true
    },
    live: (partId) => waits.has(partId),
    /** Part ids waiting in a chat. */
    pending: (threadId) => [...waits].filter(([, w]) => w.threadId === threadId).map(([id]) => id),
  }
}

/**
 * Holds on a run's clock. Each open question takes one; the clock runs only
 * when none are held.
 */
export function createHolds() {
  let count = 0
  const subs = new Set()
  const flip = (held) => { for (const fn of [...subs]) fn(held) }
  return {
    hold() {
      let released = false
      if (count++ === 0) flip(true)
      return () => {
        if (released) return
        released = true
        if (--count === 0) flip(false)
      }
    },
    get held() { return count > 0 },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
  }
}

/** setTimeout that stops counting while `holds` are held. Returns the clear function. */
export function holdableTimeout(ms, fire, holds = null) {
  if (!holds) {
    const t = setTimeout(fire, ms)
    return () => clearTimeout(t)
  }
  let left = ms
  let since = 0
  let t = null
  const run = () => { if (t) return; since = Date.now(); t = setTimeout(fire, left) }
  const pause = () => { if (!t) return; clearTimeout(t); t = null; left = Math.max(0, left - (Date.now() - since)) }
  const unsubscribe = holds.subscribe((held) => (held ? pause() : run()))
  if (!holds.held) run()
  return () => { unsubscribe(); if (t) clearTimeout(t); t = null }
}
