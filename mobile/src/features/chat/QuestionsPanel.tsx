// The agent's questions above the composer, one at a time (web chat/QuestionsPanel.tsx,
// T3 Code's pending-questions panel). Tap an option to pick it; the composer's box is
// the typed answer for the question on screen, and typed words win over a pick. The
// last question's button submits them all. Answers to a run that has ended come back
// from the bridge as a message, which is sent as the next one.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { api } from '../../lib/api'
import { pushError } from '../../lib/toast'
import { patchMessagePart } from '../../lib/chat/store'
import { allAnswers, answerPreview, draftAnswer, pick, type Draft } from '../../lib/chat/questions'
import type { ChatMessage, QuestionsPart } from '../../lib/chat/types'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { success, tap } from '../../ui/haptics'
import { alpha, colors } from '../../theme'
import { TI, vc } from './ui'
import { IconCheck, IconChevronDown, IconChevronUp, IconMessageCircleQuestion, IconX } from './icons'

const ADVANCE_MS = 200

/** What the composer does while questions are open. */
export interface Answering {
  placeholder: string
  submitLabel: string
  canSubmit: boolean
  submitting: boolean
  onSubmit: () => void
  onBack?: () => void
}

interface Flow {
  index: number
  drafts: Record<string, Draft>
  collapsed: boolean
}

export function useQuestionFlow({ threadId, pending, sendText, displace }: {
  threadId: string | null
  pending: { message: ChatMessage; part: QuestionsPart } | null
  sendText: (text: string) => void
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
  const answered = q ? draftAnswer(q, draft).length > 0 : false

  const setDraft = useCallback((id: string, d: Draft) => setFlow((f) => ({ ...f, drafts: { ...f.drafts, [id]: d } })), [])

  async function respond(action: 'answer' | 'dismiss') {
    if (!pending || !threadId || submitting) return
    const answers = action === 'answer' ? allAnswers(questions, flow.drafts) : null
    if (action === 'answer' && !answers) return
    setSubmitting(true)
    try {
      const r = await api<{ status: QuestionsPart['status']; live: boolean; message: string | null }>('/api/chat/questions', {
        method: 'POST',
        body: JSON.stringify({ threadId, messageId: pending.message.id, partId: pending.part.id, action, answers }),
      })
      patchMessagePart(threadId, pending.message.id, pending.part.id, { status: r.status, ...(answers ? { answers } : {}), answeredAt: Date.now() })
      if (action === 'answer') success(); else tap()
      if (!r.live && r.message) sendText(r.message)
    } catch (e: any) {
      pushError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  function choose(label: string) {
    if (!q) return
    tap()
    if (draft?.custom.trim()) displace(draft.custom.trim())
    const next = pick(q, draft, label)
    setDraft(q.id, next)
    if (!q.multiSelect && !last && next.selected.length) {
      clearTimeout(advanceTimer.current)
      advanceTimer.current = setTimeout(() => setFlow((f) => ({ ...f, index: Math.min(f.index + 1, questions.length - 1) })), ADVANCE_MS)
    }
  }

  function submit() {
    if (!answered) return
    if (!last) { tap(); setFlow((f) => ({ ...f, index: f.index + 1 })); return }
    respond('answer')
  }

  if (!part || !q) return null
  const custom = draft?.custom || ''
  const panel = (
    <View style={st.panel} accessibilityLabel="Questions from Totem">
      <View style={st.head}>
        <TI icon={IconMessageCircleQuestion} size={15} color={vc.soft} />
        <View style={st.chip}><T size={12} weight={600} color={colors.accent}>{q.header}</T></View>
        {questions.length > 1 ? <T size={12.5} color={vc.soft}>{index + 1}/{questions.length}</T> : null}
        {flow.collapsed ? <T size={12.5} color={colors.text} numberOfLines={1} style={{ flexShrink: 1 }}>{q.question}</T> : null}
        <View style={{ flex: 1 }} />
        <Press style={st.iconBtn} onPress={() => setFlow((f) => ({ ...f, collapsed: !f.collapsed }))} accessibilityLabel={flow.collapsed ? 'Show the question' : 'Hide the question'}>
          <TI icon={flow.collapsed ? IconChevronUp : IconChevronDown} size={16} color={vc.soft} />
        </Press>
        <Press style={st.iconBtn} disabled={submitting} onPress={() => respond('dismiss')} accessibilityLabel="Dismiss the questions">
          <TI icon={IconX} size={16} color={vc.soft} />
        </Press>
      </View>
      {!flow.collapsed ? (
        <>
          <T size={15} lineHeight={21} color={colors.text} style={{ marginTop: 8 }}>{q.question}</T>
          {q.multiSelect ? <T size={12.5} color={vc.soft} style={{ marginTop: 2 }}>Select one or more options.</T> : null}
          {q.options.length ? (
            <ScrollView style={st.options} contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="handled">
              {q.options.map((o, k) => {
                const on = !custom.trim() && !!draft?.selected.includes(o.label)
                return (
                  <Press key={o.label} style={[st.option, on && st.optionOn]} onPress={() => choose(o.label)} accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'} accessibilityState={{ checked: on }}>
                    <View style={[st.key, on && st.keyOn]}>
                      {on ? <TI icon={IconCheck} size={13} color="#0f1115" stroke={2.5} /> : <T size={11.5} weight={600} color={vc.soft}>{k < 9 ? String(k + 1) : ''}</T>}
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <T size={14} weight={500} color={colors.text}>{o.label}</T>
                      {o.description ? <T size={12.5} lineHeight={17.5} color={vc.soft}>{o.description}</T> : null}
                    </View>
                  </Press>
                )
              })}
            </ScrollView>
          ) : null}
        </>
      ) : null}
    </View>
  )

  const answering: Answering = {
    placeholder: q.options.length ? 'Type your own answer, or leave this blank to use the selected option' : 'Type your answer',
    submitLabel: submitting ? 'Submitting…' : last ? (questions.length > 1 ? 'Submit answers' : 'Submit answer') : 'Next',
    canSubmit: answered && !submitting,
    submitting,
    onSubmit: submit,
    onBack: index > 0 ? () => setFlow((f) => ({ ...f, index: f.index - 1 })) : undefined,
  }
  const onChange = (v: string) => setDraft(q.id, { selected: draft?.selected || [], custom: v })
  return { panel, answering, value: custom, onChange }
}

/** Questions in the transcript: what was asked and what the owner answered. */
export function QuestionsRecord({ part }: { part: QuestionsPart }) {
  const [open, setOpen] = useState(false)
  const label = part.questions.length === 1 ? part.questions[0].question : `${part.questions.length} questions: ${part.questions.map((q) => q.header).join(' · ')}`
  return (
    <View style={st.record}>
      <Press style={st.recordHead} onPress={() => setOpen((o) => !o)} accessibilityState={{ expanded: open }}>
        <TI icon={IconMessageCircleQuestion} size={15} color={vc.soft} />
        <T size={13} color={colors.text} numberOfLines={1} style={{ flexShrink: 1 }}>{label}</T>
        <T size={13} color={part.status === 'pending' ? colors.accent : vc.soft} numberOfLines={1} style={{ flex: 1 }}>{answerPreview(part)}</T>
        <TI icon={open ? IconChevronUp : IconChevronDown} size={14} color={vc.soft} />
      </Press>
      {open ? (
        <View style={st.recordList}>
          {part.questions.map((q) => (
            <View key={q.id} style={{ gap: 2 }}>
              <T size={13.5} color={vc.soft}>{q.question}</T>
              <T size={13.5} color={colors.text}>{part.status === 'answered' ? (part.answers?.[q.id] || []).join(', ') || '—' : part.status === 'dismissed' ? 'Not answered' : 'Waiting'}</T>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  panel: {
    marginBottom: 8, paddingTop: 8, paddingHorizontal: 12, paddingBottom: 12, borderRadius: 18,
    backgroundColor: vc.surface, borderWidth: 1, borderColor: vc.line,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 30 },
  chip: { paddingHorizontal: 8, paddingVertical: 1, borderRadius: 6, backgroundColor: alpha(colors.accent, 0.15) },
  iconBtn: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  options: { marginTop: 10, maxHeight: 280 },
  option: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 9, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: vc.line },
  optionOn: { borderColor: alpha(colors.accent, 0.6), backgroundColor: alpha(colors.accent, 0.1) },
  key: { width: 20, height: 20, marginTop: 1, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: vc.raise },
  keyOn: { backgroundColor: colors.accent },
  record: { marginVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: vc.line },
  recordHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 10 },
  recordList: { paddingLeft: 34, paddingRight: 12, paddingBottom: 10, gap: 8 },
})
