// T3 Code's pending-questions panel: the agent's questions above the composer,
// one at a time. Options are picked with a click or keys 1–9; the composer's box
// becomes the typed answer for the question on screen, and typed words win over
// a pick. Photos and files added in the composer while a question is on screen
// go with that question's answer, with or without words. The last question's
// button submits them all.
//
// Answers go to /api/chat/questions. While the run that asked is still waiting
// they become its tool result and the reply carries on; once it has ended, the
// bridge hands back a message and this sends it as the next one (steering a
// reply that is running), so answering late still works.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { pushError } from '../toast'
import { patchMessagePart } from './store'
import { AttachmentChip } from './Message'
import { allAnswers, allFiles, answerPreview, draftAnswered, pick, type Draft } from './questions'
import type { Attachment, ChatMessage, QuestionsPart } from './types'
import { TI } from './ui'
import { IconCheck, IconChevronDown, IconChevronUp, IconMessageCircleQuestion, IconX } from './icons'

const ADVANCE_MS = 200
const narrow = () => !!window.matchMedia?.('(max-width: 720px)').matches

/** What the composer does while questions are open. */
export interface Answering {
  placeholder: string
  submitLabel: string
  /** The question on screen has an answer without the composer's files. */
  answered: boolean
  submitting: boolean
  /** Moves on with the composer's ready files joining this answer; false when it did not. */
  onSubmit: (files: Attachment[]) => boolean
  onBack?: () => void
}

interface Flow {
  index: number
  drafts: Record<string, Draft>
  collapsed: boolean
}

/**
 * The state behind the panel and the composer while `pending` is open. `sendText`
 * sends the answers as a message when the run that asked has ended; `displace`
 * keeps typed words a pick replaced (they go back to the chat's draft).
 */
export function useQuestionFlow({ threadId, pending, sendText, displace }: {
  threadId: string | null
  pending: { message: ChatMessage; part: QuestionsPart } | null
  sendText: (text: string, files: Attachment[]) => void
  displace: (text: string) => void
}) {
  const part = pending?.part || null
  const [flow, setFlow] = useState<Flow>({ index: 0, drafts: {}, collapsed: false })
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => { setFlow({ index: 0, drafts: {}, collapsed: false }) }, [part?.id])
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(advanceTimer.current), [])

  const questions = part?.questions || []
  const index = Math.min(flow.index, Math.max(0, questions.length - 1))
  const q = questions[index]
  const last = index === questions.length - 1
  const draft = q ? flow.drafts[q.id] : undefined
  const answered = q ? draftAnswered(q, draft) : false

  const setDraft = useCallback((id: string, d: Draft) => setFlow((f) => ({ ...f, drafts: { ...f.drafts, [id]: d } })), [])

  async function respond(action: 'answer' | 'dismiss', drafts = flow.drafts) {
    if (!pending || !threadId || submitting) return
    const answers = action === 'answer' ? allAnswers(questions, drafts) : null
    if (action === 'answer' && !answers) return
    const files = answers ? allFiles(drafts) : {}
    const attachments = Object.fromEntries(Object.entries(files).map(([id, list]) => [id, list.map((f) => f.id)]))
    setSubmitting(true)
    try {
      const r = await api<{ status: QuestionsPart['status']; live: boolean; message: string | null }>('/api/chat/questions', {
        method: 'POST',
        body: JSON.stringify({ threadId, messageId: pending.message.id, partId: pending.part.id, action, answers, attachments }),
      })
      patchMessagePart(threadId, pending.message.id, pending.part.id, { status: r.status, ...(answers ? { answers, attachments: files } : {}), answeredAt: Date.now() })
      if (!r.live && r.message) sendText(r.message, Object.values(files).flat())
    } catch (e: any) {
      pushError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  function choose(label: string) {
    if (!q) return
    if (draft?.custom.trim()) displace(draft.custom.trim())
    const next = pick(q, draft, label)
    setDraft(q.id, next)
    // One answer, one choice: on to the next question, as T3 does.
    if (!q.multiSelect && !last && next.selected.length) {
      clearTimeout(advanceTimer.current)
      advanceTimer.current = setTimeout(() => setFlow((f) => ({ ...f, index: Math.min(f.index + 1, questions.length - 1) })), ADVANCE_MS)
    }
  }

  function submit(files: Attachment[]): boolean {
    if (!q || submitting) return false
    const d: Draft = { selected: draft?.selected || [], custom: draft?.custom || '', files: [...(draft?.files || []), ...files] }
    if (!draftAnswered(q, d)) return false
    const drafts = { ...flow.drafts, [q.id]: d }
    setFlow((f) => ({ ...f, drafts, index: last ? f.index : f.index + 1 }))
    if (last) respond('answer', drafts)
    return true
  }

  function removeFile(id: string) {
    if (!q || !draft?.files) return
    setDraft(q.id, { ...draft, files: draft.files.filter((f) => f.id !== id) })
  }

  // Keys 1–9 pick, as long as the caret is not in a text field.
  useEffect(() => {
    if (!q || flow.collapsed) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest('input, textarea, [contenteditable="true"]')) return
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > 9 || !q.options[n - 1]) return
      e.preventDefault()
      choose(q.options[n - 1].label)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!part || !q) return null
  const custom = draft?.custom || ''
  const panel = (
    <div className={`vc-questions ${flow.collapsed ? 'collapsed' : ''}`} role="group" aria-label="Questions from Totem">
      <div className="vc-q-head">
        <TI icon={IconMessageCircleQuestion} size={15} />
        <span className="vc-q-chip">{q.header}</span>
        {questions.length > 1 && <span className="vc-q-count">{index + 1}/{questions.length}</span>}
        {flow.collapsed && <span className="vc-q-peek">{q.question}</span>}
        <span className="vc-q-spacer" />
        <button type="button" className="vc-icon-btn sm" onClick={() => setFlow((f) => ({ ...f, collapsed: !f.collapsed }))} aria-label={flow.collapsed ? 'Show the question' : 'Hide the question'} title={flow.collapsed ? 'Show' : 'Hide'}>
          <TI icon={flow.collapsed ? IconChevronUp : IconChevronDown} size={16} />
        </button>
        <button type="button" className="vc-icon-btn sm" onClick={() => respond('dismiss')} disabled={submitting} aria-label="Dismiss the questions" title="Dismiss: carry on without answering">
          <TI icon={IconX} size={16} />
        </button>
      </div>
      {!flow.collapsed && (
        <>
          <div className="vc-q-text">{q.question}</div>
          {q.multiSelect && <div className="vc-q-hint">Select one or more options.</div>}
          {!!draft?.files?.length && (
            <div className="vc-tray vc-q-files">
              {draft.files.map((f) => <AttachmentChip key={f.id} a={f} onRemove={() => removeFile(f.id)} />)}
            </div>
          )}
          {q.options.length > 0 && (
            <div className="vc-q-options" role={q.multiSelect ? 'group' : 'radiogroup'}>
              {q.options.map((o, k) => {
                const on = !custom.trim() && !!draft?.selected.includes(o.label)
                return (
                  <button key={o.label} type="button" className={`vc-q-option ${on ? 'on' : ''}`} role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => choose(o.label)}>
                    <span className="vc-q-key">{on ? <TI icon={IconCheck} size={13} stroke={2.5} /> : k < 9 ? k + 1 : ''}</span>
                    <span className="vc-q-option-text">
                      <span className="vc-q-label">{o.label}</span>
                      {o.description && <span className="vc-q-desc">{o.description}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )

  const answering: Answering = {
    placeholder: q.options.length ? 'Type your own answer, or leave this blank to use the selected option' : 'Type your answer',
    // A phone's composer bar has no room for the long labels (T3's compact layout).
    submitLabel: submitting ? 'Submitting…' : narrow() ? (last ? 'Submit' : 'Next') : last ? (questions.length > 1 ? 'Submit answers' : 'Submit answer') : 'Next question',
    answered,
    submitting,
    onSubmit: submit,
    onBack: index > 0 ? () => setFlow((f) => ({ ...f, index: f.index - 1 })) : undefined,
  }
  const value = custom
  const onChange = (v: string) => setDraft(q.id, { ...draft, selected: draft?.selected || [], custom: v })
  return { panel, answering, value, onChange }
}

/** Questions in the transcript: what was asked and what the owner answered. */
export function QuestionsRecord({ part }: { part: QuestionsPart }) {
  const [open, setOpen] = useState(false)
  const label = part.questions.map((q) => q.header).join(' · ')
  return (
    <div className={`vc-q-record ${part.status}`}>
      <button type="button" className="vc-q-record-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <TI icon={IconMessageCircleQuestion} size={15} />
        <span className="vc-q-record-label">{part.questions.length === 1 ? part.questions[0].question : `${part.questions.length} questions: ${label}`}</span>
        <span className="vc-q-record-answer">{answerPreview(part)}</span>
        <TI icon={open ? IconChevronUp : IconChevronDown} size={14} />
      </button>
      {open && (
        <ol className="vc-q-record-list">
          {part.questions.map((q) => (
            <li key={q.id}>
              <div className="vc-q-record-q">{q.question}</div>
              <div className="vc-q-record-a">{part.status === 'answered' ? (part.answers?.[q.id] || []).join(', ') || (part.attachments?.[q.id]?.length ? '' : '—') : part.status === 'dismissed' ? 'Not answered' : 'Waiting'}</div>
              {!!part.attachments?.[q.id]?.length && (
                <div className="vc-tray vc-q-files">
                  {part.attachments[q.id].map((f) => <AttachmentChip key={f.id} a={f} onOpen={f.url ? () => window.open(f.url, '_blank', 'noopener') : undefined} />)}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
