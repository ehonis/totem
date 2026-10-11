// New / edit habit (HabitsView.tsx HabitFormModal) as a formSheet. Same fields,
// hints and copy; selects are native menus, the delete confirm is the platform alert.
import React, { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Empty, Press } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { success } from '../../ui/haptics'
import { TrashIcon } from '../../lib/icons'
import { createHabit, deleteHabit, updateHabit } from '../../lib/api'
import { pushToast } from '../../lib/toast'
import { CheckField, Field, FieldInput, FieldRow, Select, Sheet, closeSheet } from './form'
import { CADENCE_NOUN, metricDraftFrom, metricFromDraft, periodLabel, type Cadence, type MetricDraft } from './logic'
import { mutate, useHabits } from './store'

export default function HabitFormSheet({ editing }: { editing?: boolean }) {
  const { id } = useLocalSearchParams<{ id?: string }>()
  const { data } = useHabits()
  const found = editing ? data?.habits.find((h) => h.id === id) ?? null : null
  // Held from the first render: a delete swaps in a payload without the habit, and
  // the sheet should close on the form rather than flash "gone" on the way out.
  const [initial] = useState(found)
  if (editing && !initial) return <Sheet title="Edit habit"><Empty title="That habit is gone." /></Sheet>
  return <HabitForm key={initial?.id ?? 'new'} initial={initial} palette={data?.palette ?? []} usedColors={(data?.habits ?? []).map((h) => h.color)} />
}

function HabitForm({ initial, palette, usedColors }: { initial: import('./logic').Habit | null; palette: string[]; usedColors: string[] }) {
  const [form, setForm] = useState({
    name: initial?.name || '',
    description: initial?.description || '',
    cadence: (initial?.cadence || 'daily') as Cadence,
    target: String(initial?.target || 1),
    color: initial?.color || '', // '' = auto-assign on create
    archived: initial?.archived || false,
  })
  const [metric, setMetric] = useState<MetricDraft>(() => metricDraftFrom(initial?.metric))
  const setM = <K extends keyof MetricDraft>(k: K, v: MetricDraft[K]) => setMetric((m) => ({ ...m, [k]: v }))
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))
  const [busy, setBusy] = useState<string | null>(null)

  const submit = async () => {
    if (!form.name.trim()) { pushToast('A name is required.'); return }
    setBusy('save')
    try {
      const fields: any = {
        name: form.name.trim(),
        description: form.description,
        cadence: form.cadence,
        target: Math.max(1, Number(form.target) || 1),
        archived: form.archived,
        metric: metricFromDraft(metric, initial?.metric?.parts),
      }
      if (form.color) fields.color = form.color
      await mutate(() => (initial ? updateHabit(initial.id, fields) : createHabit(fields)))
      success()
      closeSheet()
    } catch (e: any) { pushToast(e.message); setBusy(null) }
  }

  const remove = async () => {
    if (!initial) return
    if (!(await confirm('Really delete history?', { message: `${initial.name} and every day logged against it will be deleted.` }))) return
    setBusy('delete')
    try { await mutate(() => deleteHabit(initial.id)); closeSheet() } catch (e: any) { pushToast(e.message); setBusy(null) }
  }

  const sel = <V extends string>(value: V, options: { value: V; label: string }[], onChange: (v: V) => void, label: string) =>
    <Select value={value} options={options} onChange={onChange} label={label} />

  return (
    <Sheet
      kicker={initial ? 'Edit habit' : 'New habit'}
      title={initial ? initial.name : 'Track something daily'}
      footer={
        <>
          {initial && (
            <Btn kind="danger" icon={TrashIcon} title={busy === 'delete' ? 'Deleting…' : 'Delete'} onPress={remove} disabled={Boolean(busy)} />
          )}
          <View style={{ flex: 1 }} />
          <Btn title="Cancel" onPress={closeSheet} disabled={Boolean(busy)} />
          <Btn kind="primary" title={busy === 'save' ? 'Saving…' : initial ? 'Save' : 'Add habit'} onPress={submit} disabled={Boolean(busy)} />
        </>
      }
    >
      <Field label="Name">
        <FieldInput value={form.name} onChangeText={(v) => set('name', v)} autoFocus={!initial} placeholder="e.g. Read, Gym, No sugar" returnKeyType="done" />
      </Field>
      <Field label="Description (optional)">
        <FieldInput value={form.description} onChangeText={(v) => set('description', v)} placeholder="What counts as done?" returnKeyType="done" />
      </Field>
      <FieldRow>
        <Field label="How often">
          {sel(form.cadence, [{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }], (v) => set('cadence', v), 'How often')}
        </Field>
        <Field label={`Times per ${CADENCE_NOUN[form.cadence]}`}>
          <FieldInput value={form.target} onChangeText={(v) => set('target', v.replace(/[^0-9]/g, ''))} keyboardType="numbers-and-punctuation" returnKeyType="done" maxLength={2} />
        </Field>
      </FieldRow>
      <T size={11} muted>
        {form.cadence === 'daily'
          ? '1 = simple yes/no. Higher (e.g. 8 glasses of water) shades the day darker the closer you get.'
          : `e.g. gym 3× a week, or deep-clean once a month. You still check it off on the day you do it; the check-in shows ${periodLabel(form.cadence)}’s progress.`}
      </T>
      <Field label="Color">
        <View style={s.swatches}>
          {!initial && (
            <Press haptic onPress={() => set('color', '')} style={[s.swatch, s.auto, !form.color && { borderColor: colors.text }]} accessibilityLabel="Pick the next free color for me">
              <T size={11} color={!form.color ? colors.text : colors.muted}>Auto</T>
            </Press>
          )}
          {palette.map((c) => {
            const used = usedColors.includes(c) && c !== initial?.color
            const selected = form.color === c
            return (
              <Press
                key={c}
                haptic
                onPress={() => set('color', c)}
                accessibilityLabel={used ? 'Already used by another habit' : `Color ${c}`}
                style={[s.swatch, { backgroundColor: c }, selected && s.selected, used && !selected && { opacity: 0.35 }]}
              />
            )
          })}
        </View>
      </Field>

      {/* Optional metric: the number this habit is really about. */}
      <View style={s.metricForm}>
        <CheckField value={metric.on} onChange={(v) => setM('on', v)}>Track a number with this habit</CheckField>
        {metric.on && (
          <>
            <FieldRow>
              <Field label="What's measured">
                <FieldInput value={metric.label} onChangeText={(v) => setM('label', v)} placeholder="e.g. Sleep score" />
              </Field>
              <Field label="Unit (optional)">
                <FieldInput value={metric.unit} onChangeText={(v) => setM('unit', v)} placeholder="e.g. min, kg, %" />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Scale min"><FieldInput value={metric.min} onChangeText={(v) => setM('min', v)} placeholder="auto" keyboardType="numbers-and-punctuation" returnKeyType="done" /></Field>
              <Field label="Scale max"><FieldInput value={metric.max} onChangeText={(v) => setM('max', v)} placeholder="auto" keyboardType="numbers-and-punctuation" returnKeyType="done" /></Field>
              <Field label="Goal line"><FieldInput value={metric.goal} onChangeText={(v) => setM('goal', v)} placeholder="none" keyboardType="numbers-and-punctuation" returnKeyType="done" /></Field>
            </FieldRow>
            <FieldRow>
              <Field label="Better when">{sel(metric.direction, [{ value: 'higher', label: 'Higher' }, { value: 'lower', label: 'Lower' }], (v) => setM('direction', v), 'Better when')}</Field>
              <Field label="Graph">{sel(metric.chart, [{ value: 'line', label: 'Line' }, { value: 'bar', label: 'Bars' }], (v) => setM('chart', v), 'Graph')}</Field>
              <Field label="Decimals">{sel(metric.decimals, [{ value: '0', label: '0' }, { value: '1', label: '0.0' }, { value: '2', label: '0.00' }], (v) => setM('decimals', v), 'Decimals')}</Field>
            </FieldRow>
            <Field label="Filled by">
              {sel(metric.source, [{ value: 'manual', label: 'Me (or Totem, when I tell it)' }, { value: 'whoop-sleep', label: 'WHOOP sleep sync' }], (v) => setM('source', v), 'Filled by')}
            </Field>
            {metric.source === 'whoop-sleep' && (
              <T size={11} muted>
                A scheduled job pulls last night's sleep performance and stages from the WHOOP API each late
                morning (Studio → Workflows → WHOOP sleep sync). Nights you've already filled in are left alone.
              </T>
            )}
            <Field
              label="Breakdown (optional)"
              hint="Comma-separated components, logged in the metric's unit and stacked as bars under the line — sleep stages in minutes, say. Leave empty for a single number."
            >
              <FieldInput value={metric.parts} onChangeText={(v) => setM('parts', v)} placeholder="e.g. Deep, Light, REM, Awake" />
            </Field>
            <CheckField value={metric.pinned} onChange={(v) => setM('pinned', v)}>Pin this graph to the Home board</CheckField>
          </>
        )}
      </View>
      {initial && (
        <CheckField value={form.archived} onChange={(v) => set('archived', v)}>Archived (hidden from check-in, history kept)</CheckField>
      )}
    </Sheet>
  )
}

const s = StyleSheet.create({
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  swatch: { width: 30, height: 30, borderRadius: 8, borderWidth: 2, borderColor: 'transparent' },
  auto: { width: 'auto', paddingHorizontal: 10, backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  selected: { borderColor: colors.text },
  metricForm: { marginTop: 4, padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.bg3, gap: 10 },
})
