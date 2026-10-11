// One "number a goal tracks" (web/src/goals/metricFields.tsx), shared by the
// composer and the numbers editor. The selects are native menus; the sport picker
// (web IconSelect) is the one place a glyph reads faster than the word, and a native
// menu can't draw a Tabler glyph, so it opens as an inline list with the icons.
import React, { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import { Hi, ChevronDownIcon, XMarkIcon } from '../../lib/icons'
import { SPORT_OPTIONS } from '../../lib/goals/sportIcons'
import { MEASURE_WORDS, labelOf, measureFor, type FeedOption, type MetricDraft } from '../../lib/goals/metricFields'
import type { GoalMetricSource } from '../../lib/goals/types'
import { Field, FieldInput, Select, type SelectOption } from '../habits/form'

function SportSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const selected = SPORT_OPTIONS.find((o) => o.value === value) ?? SPORT_OPTIONS[0]
  return (
    <View>
      <Press haptic onPress={() => setOpen((v) => !v)} accessibilityRole="combobox" accessibilityLabel="Sport"
        style={[s.trigger, open && { borderColor: colors.accent }]}>
        <Hi icon={selected.icon} size={16} color={colors.accent} />
        <T size={15} numberOfLines={1} style={{ flex: 1 }}>{selected.label}</T>
        <Hi icon={ChevronDownIcon} size={14} color={colors.muted} />
      </Press>
      {open && (
        <View style={s.list}>
          {SPORT_OPTIONS.map((o) => {
            const on = o.value === value
            return (
              <Press key={o.value || '__any'} haptic onPress={() => { onChange(o.value); setOpen(false) }} style={[s.option, on && { backgroundColor: colors.bg3 }]}>
                <Hi icon={o.icon} size={16} color={on ? colors.accent : colors.muted} />
                <T size={14} color={on ? colors.accent : colors.text}>{o.label}</T>
              </Press>
            )
          })}
        </View>
      )}
    </View>
  )
}

export default function MetricFields({ metric, legend, units, mirrorTitle, feeds, onChange, onRemove }: {
  metric: MetricDraft
  legend: string
  units: [string, string[]][]
  mirrorTitle?: string
  feeds?: FeedOption[]
  onChange: (change: Partial<MetricDraft>) => void
  onRemove: () => void
}) {
  const label = mirrorTitle === undefined ? metric.label : labelOf(metric, mirrorTitle)
  const unitOptions: SelectOption<string>[] = [
    { value: '', label: 'No unit' },
    ...units.flatMap(([group, list]) => list.map((u) => ({ value: u, label: u, group }))),
    // Suggestions, not an enum: the server accepts any unit.
    { value: '__other', label: 'Something else…' },
  ]
  return (
    <View style={s.box}>
      <T size={11} muted>{legend}</T>
      <Field label="What to count">
        <FieldInput placeholder="Miles run" accessibilityLabel="Metric label" value={label} onChangeText={(v) => onChange({ label: v, labelDirty: true })} />
      </Field>
      <Field label="Target">
        <FieldInput placeholder="100" accessibilityLabel="Target" keyboardType="numbers-and-punctuation" returnKeyType="done" value={metric.targetValue} onChangeText={(v) => onChange({ targetValue: v })} />
      </Field>
      <Field label="Unit">
        <Select
          label="Unit"
          value={metric.unitOther ? '__other' : metric.unit}
          options={unitOptions}
          onChange={(chosen) => (chosen === '__other' ? onChange({ unitOther: true, unit: '' }) : onChange({ unitOther: false, unit: chosen }))}
        />
      </Field>
      {metric.unitOther && (
        <Field label="What unit?">
          <FieldInput autoFocus placeholder="chapters" accessibilityLabel="Custom unit" value={metric.unit} onChangeText={(v) => onChange({ unit: v })} />
        </Field>
      )}
      <Field label="Progress source">
        <Select<GoalMetricSource>
          label="Where the number comes from"
          value={metric.sourceKind}
          options={[
            { value: 'manual', label: 'I log it' },
            { value: 'strava_distance', label: 'From Strava' },
            { value: 'strava_gear_odometer', label: 'Bike odometer' },
          ]}
          onChange={(sourceKind) => {
            // A Strava metric with no unit would be scored in miles anyway, so name it.
            const unit = sourceKind !== 'manual' && !metric.unit && !metric.unitOther ? 'miles' : metric.unit
            onChange({ sourceKind, unit })
          }}
        />
      </Field>
      {metric.sourceKind === 'strava_distance' && (
        <Field label="Sport">
          <SportSelect value={metric.sport} onChange={(sport) => onChange({ sport })} />
          <T size={11} muted>
            Counting {MEASURE_WORDS[measureFor(metric.unit)]} in this period
            {metric.sport ? ', across every workout type in that sport' : ''}.
          </T>
        </Field>
      )}
      {metric.sourceKind === 'strava_gear_odometer' && (
        <Field label="Gear ID">
          <FieldInput placeholder="b1234…" accessibilityLabel="Gear id" autoCapitalize="none" value={metric.gearId} onChangeText={(v) => onChange({ gearId: v })} />
        </Field>
      )}
      {feeds && feeds.length > 0 && (
        <Field label="Counts toward">
          <Select
            label="Number on the goal this feeds"
            value={metric.rollsUpTo}
            options={[{ value: '', label: 'Just this step' }, ...feeds.map((f) => ({ value: f.id, label: `${f.label}${f.unit ? ` (${f.unit})` : ''}` }))]}
            onChange={(rollsUpTo) => onChange({ rollsUpTo })}
          />
        </Field>
      )}
      <Btn compact icon={XMarkIcon} title="Remove" onPress={onRemove} style={{ alignSelf: 'flex-start' }} />
    </View>
  )
}

const s = StyleSheet.create({
  box: { padding: 10, gap: 9, borderWidth: 1, borderColor: colors.line, borderRadius: 8, backgroundColor: colors.bg },
  trigger: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 42,
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: 10,
  },
  list: { marginTop: 4, padding: 4, backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 10 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9, paddingHorizontal: 9, borderRadius: 7 },
})
