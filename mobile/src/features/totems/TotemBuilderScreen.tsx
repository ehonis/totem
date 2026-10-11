// New totem (web TotemsView.tsx Builder): describe the job in your own words, the
// builder designs it and recommends the cheapest model that can do it, and nothing
// is created until it is confirmed.
import React, { useState } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { api } from '../../lib/api'
import { IconLoader2, IconSparkles } from '../../lib/chat/icons'
import { pushError, pushToast } from '../../lib/toast'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { colors, fonts, alpha, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press, Toggle } from '../../ui/kit'
import { success } from '../../ui/haptics'
import { Select } from '../settings/ui'
import { useChat } from '../../lib/chat/store'
import { modelLabel } from '../../lib/chat/models'
import { NOTIFY_CHOICES, TotemIcon, TYPE_LABEL, KindTag, replaceJob, asWatch, type Choice, type Draft } from './shared'
import { ModelSection, WhenItRuns, watchReady } from './when'
import { Area, Section } from './TotemDetailScreen'

const EXAMPLES = [
  'Watch a sold-out product page and tell me the moment it is back in stock.',
  'Every weekday morning, research AI news and write me a one-page brief.',
  'Every Sunday evening, analyse my Strava week against my goals and tell me what to change.',
]

export default function TotemBuilderScreen() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'' | 'build' | 'create'>('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [choice, setChoice] = useState<Choice>({ provider: 'default', model: '', effort: '' })
  const models = useChat((s) => s.models)

  async function build() {
    setBusy('build')
    try {
      const { draft } = await api<{ draft: Draft }>('/api/totems/build', { method: 'POST', body: JSON.stringify({ description: text }) })
      setDraft(draft)
      const top = draft.recommendations[0]
      setChoice(top ? { provider: top.provider, model: top.model || '', effort: top.effort || '' } : { provider: 'default', model: '', effort: '' })
    } catch (e: any) { pushError(e.message) } finally { setBusy('') }
  }

  async function create() {
    if (!draft) return
    setBusy('create')
    try {
      const label = choice.model ? modelLabel(models[choice.provider], choice.model) : ''
      const { job } = await api<{ job: any }>('/api/totems', { method: 'POST', body: JSON.stringify({ draft, choice: { ...choice, label } }) })
      success()
      pushToast(job.trigger ? `${job.name} is watching. It runs the first time that changes.` : `${job.name} is live. Its first run is starting now.`, 'info')
      replaceJob(job)
      router.replace({ pathname: '/totem/[id]', params: { id: job.id } })
    } catch (e: any) { pushError(e.message) } finally { setBusy('') }
  }

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d))

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: FAB_CLEARANCE, gap: 14 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        {!draft ? (
          <>
            <T size={26} weight={600} lineHeight={32}>New totem</T>
            <T size={14} muted lineHeight={22}>
              Say what it should do and how often, in your own words. The builder designs it, writes its instructions and suggests the cheapest model that can do the job well. Nothing is created until you confirm.
            </T>
            <TextInput
              multiline
              autoFocus
              value={text}
              onChangeText={setText}
              placeholder="e.g. Be a super analyst: every Friday, go through my calendar and tasks and tell me where my week actually went."
              placeholderTextColor={colors.muted}
              selectionColor={colors.accent}
              keyboardAppearance="dark"
              textAlignVertical="top"
              style={st.input}
            />
            <View style={{ gap: 6 }}>
              {EXAMPLES.map((x) => (
                <Press key={x} haptic onPress={() => setText(x)} style={st.example}>
                  <T size={13} lineHeight={18} color={textAlpha(74)}>{x}</T>
                </Press>
              ))}
            </View>
            <View style={st.actions}>
              <Btn
                kind="primary"
                icon={busy === 'build' ? IconLoader2 : IconSparkles}
                title={busy === 'build' ? 'Designing…' : 'Build totem'}
                disabled={text.trim().length < 8 || !!busy}
                onPress={build}
              />
              {busy === 'build' ? <T muted>This takes up to a minute.</T> : null}
            </View>
          </>
        ) : (
          <>
            <View style={st.draftHead}>
              <TotemIcon name={draft.icon} large />
              <TextInput
                value={draft.name}
                onChangeText={(name) => patch({ name })}
                accessibilityLabel="Name"
                selectionColor={colors.accent}
                keyboardAppearance="dark"
                style={st.name}
              />
              <KindTag label={TYPE_LABEL[draft.taskType] || 'Agent'} />
            </View>
            <TextInput
              value={draft.summary || ''}
              onChangeText={(summary) => patch({ summary })}
              placeholder="One line: what it does for you"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Summary"
              selectionColor={colors.accent}
              keyboardAppearance="dark"
              style={[st.input, { minHeight: 0, paddingVertical: 9, paddingHorizontal: 12, fontSize: 14 }]}
            />
            {draft.questions.length > 0 ? (
              <View style={st.questions}>
                <T size={13.5} weight={600}>The builder wasn’t sure about:</T>
                {draft.questions.map((q) => <T key={q} size={13.5} lineHeight={20}>{`•  ${q}`}</T>)}
                <T size={13.5} muted lineHeight={20}>Answer by editing the instructions below, or tell the totem in its chat later.</T>
              </View>
            ) : null}
            <Section title="Model" hint="Suggestions are cheapest first. You can change this any time.">
              <ModelSection recs={draft.recommendations} value={choice} onChange={setChoice} />
            </Section>
            <Section title="Instructions">
              <Area value={draft.instructions} onChange={(instructions) => patch({ instructions })} />
            </Section>
            <Section title="When it runs">
              <WhenItRuns schedule={draft.schedule} trigger={asWatch(draft.trigger)} onSchedule={(schedule) => patch({ schedule })} onTrigger={(trigger) => patch({ trigger })} />
            </Section>
            <Section title="Notify me">
              <Select value={draft.notify} options={NOTIFY_CHOICES.map((c) => ({ value: c.id, label: c.label }))} onChange={(notify) => patch({ notify })} />
            </Section>
            <Section title="Browser">
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Toggle value={draft.browser} onChange={(v) => patch({ browser: v })} />
                <T size={13.5} color={textAlpha(80)} style={{ flex: 1 }}>Use the browser for pages that need JavaScript</T>
              </View>
              <T size={12} muted>Off: web search and plain page fetches only.</T>
            </Section>
            <View style={st.actions}>
              <Btn kind="primary" title={busy === 'create' ? 'Creating…' : 'Create totem'} disabled={!!busy || !draft.name.trim() || !draft.instructions.trim() || !watchReady(asWatch(draft.trigger))} onPress={create} />
              <Btn title="Back" disabled={!!busy} onPress={() => setDraft(null)} />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  )
}

const st = StyleSheet.create({
  input: {
    minHeight: 5 * 22 + 24, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, borderRadius: 12,
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line,
    color: colors.text, fontFamily: fonts[400], fontSize: 14.5, lineHeight: 22,
  },
  example: { alignSelf: 'flex-start', paddingVertical: 7, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: colors.line },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  draftHead: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  name: { flex: 1, minWidth: 0, paddingVertical: 6, color: colors.text, fontFamily: fonts[600], fontSize: 24 },
  questions: {
    gap: 4, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12,
    backgroundColor: '#1d1f22', borderWidth: 1, borderColor: alpha('#f0cd72', 0.28),
  },
})
