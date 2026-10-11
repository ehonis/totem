// The goal dialogs as formSheets: the composer (GoalComposer.tsx), the numbers
// editor (GoalNumbers.tsx) and the title/note editor (GoalCard's inline edit, which
// on a phone is a sheet so the keyboard has room). All act through goals/store.
import React, { useState } from 'react'
import { View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Empty } from '../../ui/kit'
import { ChartBarIcon, PlusIcon } from '../../lib/icons'
import { createGoal, updateGoal } from '../../lib/api'
import { PERIOD_LABELS, formatAmount } from '../../lib/goals/types'
import type { GoalPeriodShortcut } from '../../lib/goals/types'
import {
  changesOf, draftOf, emptyMetric, labelOf, sourceConfigOf, type FeedOption, type MetricDraft,
} from '../../lib/goals/metricFields'
import { Field, FieldInput, Select, Sheet, closeSheet } from '../habits/form'
import MetricFields from './MetricFields'
import { afterCreate, apply, goalById, saveMetrics, useGoals } from './store'
import { pushToast } from '../../lib/toast'

const COMPOSER_PERIODS: GoalPeriodShortcut[] = ['this_week', 'next_week', 'this_month', 'next_month', 'this_year', 'next_year']

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ padding: 10, borderWidth: 1, borderColor: alpha(colors.red, 0.33), borderRadius: 8, backgroundColor: alpha(colors.red, 0.05) }}>
      <T size={13} color={colors.red}>{children}</T>
    </View>
  )
}

/** "+ Track a number" and the line beside it (.goal-composer-number-row, stacked on a phone). */
function NumberRow({ onAdd, hint }: { onAdd: () => void; hint: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Btn compact icon={PlusIcon} title="Track a number" onPress={onAdd} style={{ alignSelf: 'flex-start' }} />
      <T size={11} muted>{hint}</T>
    </View>
  )
}

export function ComposerSheet() {
  const { period } = useLocalSearchParams<{ period?: GoalPeriodShortcut }>()
  const { options } = useGoals()
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [metrics, setMetrics] = useState<MetricDraft[]>([])
  const [selectedPeriod, setSelectedPeriod] = useState<GoalPeriodShortcut>(period && PERIOD_LABELS[period] ? period : 'this_week')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const patch = (i: number, change: Partial<MetricDraft>) => setMetrics((cur) => cur.map((m, j) => (i === j ? { ...m, ...change } : m)))

  const submit = async () => {
    const trimmed = title.trim()
    if (!trimmed) return
    setBusy(true); setError('')
    try {
      await createGoal({
        title: trimmed,
        notes: notes.trim() || undefined,
        period: selectedPeriod,
        metrics: metrics
          .filter((m) => labelOf(m, trimmed).trim() && Number(m.targetValue) > 0)
          .map((m) => ({
            label: labelOf(m, trimmed).trim(),
            unit: m.unit.trim() || undefined,
            targetValue: Number(m.targetValue),
            sourceKind: m.sourceKind,
            sourceConfig: sourceConfigOf(m),
          })),
      })
      closeSheet()
      void afterCreate(selectedPeriod)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That goal could not be added.')
      setBusy(false)
    }
  }

  const units = Object.entries(options?.units ?? {})
  return (
    <Sheet
      kicker="Weekly, monthly, or yearly"
      title="New goal"
      footer={
        <>
          <Btn title="Cancel" onPress={closeSheet} disabled={busy} />
          <Btn kind="primary" title={busy ? 'Adding…' : 'Add goal'} onPress={submit} disabled={busy || !title.trim()} />
        </>
      }
    >
      <Field label="Goal">
        <FieldInput autoFocus value={title} placeholder="What do you want to be true by the end?" accessibilityLabel="Goal title" onChangeText={setTitle} />
      </Field>
      <Field label="Period">
        <Select label="Goal period" value={selectedPeriod} onChange={setSelectedPeriod}
          options={COMPOSER_PERIODS.map((value) => ({ value, label: PERIOD_LABELS[value] }))} />
      </Field>
      <Field label={<T size={12} muted>Notes <T size={11} muted>Optional</T></T>}>
        <FieldInput multiline value={notes} placeholder="Anything useful to remember" accessibilityLabel="Notes" onChangeText={setNotes} />
      </Field>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {metrics.map((metric, i) => (
        <MetricFields
          key={i} metric={metric} legend={`Number ${i + 1}`} units={units} mirrorTitle={title}
          onChange={(change) => patch(i, change)}
          onRemove={() => setMetrics(metrics.filter((_, j) => j !== i))}
        />
      ))}
      <NumberRow onAdd={() => setMetrics([...metrics, emptyMetric()])} hint="No number means you mark it done yourself." />
    </Sheet>
  )
}

export function NumbersSheet() {
  const { id, step } = useLocalSearchParams<{ id: string; step?: string }>()
  const { options, busy } = useGoals()
  const goal = goalById(id)
  const sub = step && goal ? goal.subGoals.find((g) => g.id === step) ?? null : null
  if (!goal || (step && !sub)) return <Sheet title="Numbers"><Empty title="That goal is gone." /></Sheet>
  return <NumbersForm key={`${goal.id}:${step ?? ''}`} goalId={goal.id} stepId={sub?.id ?? null} options={options} busy={busy} />
}

function NumbersForm({ goalId, stepId, options, busy }: { goalId: string; stepId: string | null; options: ReturnType<typeof useGoals>['options']; busy: boolean }) {
  const goal = goalById(goalId)!
  const step = stepId ? goal.subGoals.find((g) => g.id === stepId) ?? null : null
  const target = step ?? goal
  const units = options?.allUnits ?? []
  const families = options?.sportFamilies ?? {}
  // Only manual parent numbers: a connector one already counts everything in the period.
  const feeds: FeedOption[] | undefined = step
    ? goal.metrics.filter((m) => m.sourceKind === 'manual').map((m) => ({ id: m.id, label: m.label, unit: m.unit }))
    : undefined
  const [originals] = useState<MetricDraft[]>(() => target.metrics.map((m) => draftOf(m, { units, families })))
  const [drafts, setDrafts] = useState<MetricDraft[]>(originals.length ? originals : [emptyMetric()])
  const patch = (i: number, change: Partial<MetricDraft>) => setDrafts((cur) => cur.map((m, j) => (i === j ? { ...m, ...change } : m)))

  // Hand-logged numbers about to be handed to a connector, which discards them.
  const discarding = drafts.filter((d) => {
    if (d.sourceKind === 'manual' || !d.id) return false
    const was = originals.find((o) => o.id === d.id)
    if (!was || was.sourceKind !== 'manual') return false
    return (target.metrics.find((m) => m.id === d.id)?.ownValue ?? 0) > 0
  })
  const emptied = drafts.filter((d) => d.id && (!d.label.trim() || !(Number(d.targetValue) > 0)))

  const save = async () => {
    closeSheet()
    const ok = await saveMetrics(step ? step.id : goal.id, changesOf(drafts, originals))
    if (!ok) pushToast('The numbers did not save.')
  }

  return (
    <Sheet
      kicker={step ? `${goal.title} · step` : goal.title}
      title={step ? `Numbers on “${step.title || 'this step'}”` : 'Numbers'}
      footer={
        <>
          <Btn title="Cancel" onPress={closeSheet} disabled={busy} />
          <Btn kind="primary" title={busy ? 'Saving…' : 'Save numbers'} onPress={save} disabled={busy || emptied.length > 0} />
        </>
      }
    >
      {drafts.map((metric, i) => (
        <MetricFields
          key={metric.id ?? `new-${i}`} metric={metric} legend={`Number ${i + 1}`} units={Object.entries(options?.units ?? {})}
          feeds={feeds}
          onChange={(change) => patch(i, change)}
          onRemove={() => setDrafts(drafts.filter((_, j) => j !== i))}
        />
      ))}
      {discarding.length > 0 && (
        <ErrorBox>
          {discarding.map((d) => {
            const logged = target.metrics.find((m) => m.id === d.id)
            return `"${d.label}" has ${formatAmount(logged?.ownValue ?? 0, logged?.unit ?? null)} logged by hand`
          }).join('; ')}
          . A connector owns the number it feeds, so that will be discarded on save.
        </ErrorBox>
      )}
      {emptied.length > 0 && (
        <ErrorBox>A number needs a name and a target above zero. Remove it instead if you have stopped tracking it.</ErrorBox>
      )}
      <NumberRow
        onAdd={() => setDrafts([...drafts, emptyMetric()])}
        hint={step
          ? 'A step tracks as many as it needs — two bike rides and twenty miles on the same step, each with its own bar.'
          : 'A goal can track as many as it needs; each gets its own bar.'}
      />
    </Sheet>
  )
}

/** Edit goal ('all') or just its note ('note'): the same save, fewer fields. */
export function EditSheet() {
  const { id, mode } = useLocalSearchParams<{ id: string; mode?: 'all' | 'note' }>()
  const goal = goalById(id)
  const [draft, setDraft] = useState({ title: goal?.title ?? '', notes: goal?.notes ?? '' })
  const { busy } = useGoals()
  if (!goal) return <Sheet title="Edit goal"><Empty title="That goal is gone." /></Sheet>
  const noteOnly = mode === 'note'

  const save = async () => {
    const title = draft.title.trim()
    if (!title) return
    closeSheet()
    await apply(() => updateGoal(goal.id, { title, notes: draft.notes.trim() }))
  }

  return (
    <Sheet
      kicker={noteOnly ? goal.title : 'Edit goal'}
      title={noteOnly ? (goal.notes ? 'Edit note' : 'Add a note') : goal.title}
      footer={
        <>
          {/* Editing a goal and editing what it counts are the same intention. */}
          {!noteOnly && <Btn icon={ChartBarIcon} title="Numbers" onPress={() => router.replace({ pathname: '/goal/numbers', params: { id: goal.id } })} />}
          <View style={{ flex: 1 }} />
          <Btn title="Cancel" onPress={closeSheet} />
          <Btn kind="primary" title="Save" onPress={save} disabled={busy || !draft.title.trim()} />
        </>
      }
    >
      {!noteOnly && (
        <Field label="Goal">
          <FieldInput autoFocus value={draft.title} accessibilityLabel="Goal title" onChangeText={(title) => setDraft((d) => ({ ...d, title }))} />
        </Field>
      )}
      <Field label="Note">
        <FieldInput
          multiline autoFocus={noteOnly} value={draft.notes} accessibilityLabel="Goal note"
          placeholder="A reminder, or why this ended the way it did…"
          onChangeText={(notes) => setDraft((d) => ({ ...d, notes }))}
        />
      </Field>
    </Sheet>
  )
}
