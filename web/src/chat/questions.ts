// Questions an agent asked the owner (chat/questions.mjs on the bridge): which
// ones are waiting, and what the owner's picks and typed words add up to. The
// panel above the composer (QuestionsPanel.tsx) asks them one at a time, the way
// T3 Code does; there is no cap on how many.
import type { Attachment, ChatMessage, ChatThread, Question, QuestionsPart } from './types'

/** The tool's name; its card is replaced by the questions themselves. */
export const ASK_TOOL = 'ask_questions'

export const isAskTool = (tool?: string) => tool === ASK_TOOL || !!tool?.endsWith(`__${ASK_TOOL}`)

/** The oldest questions still waiting in a chat, and the reply they belong to. */
export function pendingQuestions(t: Pick<ChatThread, 'messages'> | null | undefined): { message: ChatMessage; part: QuestionsPart } | null {
  for (const message of t?.messages || []) {
    if (message.role !== 'assistant') continue
    const part = message.parts?.find((p): p is QuestionsPart => p.type === 'questions' && p.status === 'pending')
    if (part) return { message, part }
  }
  return null
}

/** What the owner has done with one question so far. `files` answer it too, with or without words. */
export interface Draft { selected: string[]; custom: string; files?: Attachment[] }

/** Whether a draft answers its question. */
export const draftAnswered = (q: Question, d: Draft | undefined) => draftAnswer(q, d).length > 0 || !!d?.files?.length

/** The answer a draft gives: typed words win over a picked option. */
export function draftAnswer(q: Question, d: Draft | undefined): string[] {
  const custom = d?.custom.trim()
  if (custom) return [custom]
  const picked = (d?.selected || []).filter((l) => q.options.some((o) => o.label === l))
  return q.multiSelect ? picked : picked.slice(0, 1)
}

/** Every question's answer, or null while any is still unanswered. */
export function allAnswers(questions: Question[], drafts: Record<string, Draft>): Record<string, string[]> | null {
  const out: Record<string, string[]> = {}
  for (const q of questions) {
    if (!draftAnswered(q, drafts[q.id])) return null
    out[q.id] = draftAnswer(q, drafts[q.id])
  }
  return out
}

/** The files sent with each answer, by question id; questions with none are left out. */
export function allFiles(drafts: Record<string, Draft>): Record<string, Attachment[]> {
  const out: Record<string, Attachment[]> = {}
  for (const [id, d] of Object.entries(drafts)) if (d.files?.length) out[id] = d.files
  return out
}

/** Pick an option: toggled for multi-select, replaced otherwise. Picking clears typed words, not files. */
export function pick(q: Question, d: Draft | undefined, label: string): Draft {
  const selected = d?.selected || []
  const files = d?.files?.length ? { files: d.files } : {}
  if (q.multiSelect) return { selected: selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label], custom: '', ...files }
  return { selected: [label], custom: '', ...files }
}

/** One line for a set of questions, for the transcript. */
export function answerPreview(part: QuestionsPart): string {
  if (part.status === 'dismissed') return 'Dismissed'
  if (part.status === 'pending') return 'Waiting for your answer'
  return part.questions.map((q) => answerText(part, q.id)).filter(Boolean).join(' · ')
}

/** One question's answer as words, naming any files sent with it. */
export function answerText(part: QuestionsPart, id: string): string {
  const files = part.attachments?.[id] || []
  const named = files.length ? (files.length === 1 ? (files[0].kind === 'image' ? 'an image' : files[0].name) : `${files.length} files`) : ''
  return [(part.answers?.[id] || []).join(', '), named].filter(Boolean).join(' + ')
}
