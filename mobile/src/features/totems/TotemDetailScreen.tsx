// One totem (web TotemsView.tsx Detail): its switch, Chat with it / Run now, and
// Settings, Memory and Runs. A pushed screen, so the system back swipe returns to
// the list.
import React, { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { api, deleteJob, runJobNow, updateJob, getSkills, updateSkill, resetSkill, previewSkill } from '../../lib/api'
import { IconLoader2, IconMessage, IconRefresh, IconTrash } from '../../lib/chat/icons'
import { pushError, pushToast } from '../../lib/toast'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { colors, fonts, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Segmented, Spinner, Toggle } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { success } from '../../ui/haptics'
import { Select } from '../settings/ui'
import {
  NOTIFY_CHOICES, RunHistory, TotemIcon, relativeTime,
  dropJob, kindOf, loadJobs, openTotemChat, replaceJob, setEnabled, statusLine, useJobs, type Rec, type Watch,
  asWatch,
} from './shared'
import { ModelSection, WhenItRuns, watchReady } from './when'

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8, paddingTop: 10 }}>
      <T size={13} weight={600}>{title}</T>
      {hint ? <T size={13} muted style={{ marginTop: -4, marginBottom: 2 }}>{hint}</T> : null}
      {children}
    </View>
  )
}

export function Area({ value, onChange, rows = 8, mono, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; mono?: boolean; placeholder?: string }) {
  return (
    <TextInput
      multiline
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      selectionColor={colors.accent}
      keyboardAppearance="dark"
      textAlignVertical="top"
      style={[st.input, { minHeight: rows * 22 + 24 }, mono && { fontFamily: fonts.mono, fontSize: 13 }]}
    />
  )
}

function MemoryTab({ job }: { job: any }) {
  const [value, setValue] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    api<{ memory: string }>(`/api/totems/${encodeURIComponent(job.id)}/memory`)
      .then((r) => { setValue(r.memory); setDraft(r.memory) })
      .catch((e) => pushError(e.message))
  }, [job.id])
  if (value === null) return <T muted>Loading memory…</T>
  async function save() {
    setSaving(true)
    try {
      const r = await api<{ memory: string }>(`/api/totems/${encodeURIComponent(job.id)}/memory`, { method: 'PUT', body: JSON.stringify({ memory: draft }) })
      setValue(r.memory)
      success()
      pushToast('Saved', 'info')
    } catch (e: any) { pushError(e.message) } finally { setSaving(false) }
  }
  return (
    <View style={{ gap: 10 }}>
      <T muted size={14} lineHeight={20}>What {job.name} remembers between runs. It keeps this up to date itself; edit anything that’s wrong.</T>
      <Area value={draft} onChange={setDraft} rows={16} mono placeholder="Empty until its first run." />
      <View style={st.actions}>
        <Btn kind="primary" title={saving ? 'Saving…' : 'Save'} disabled={saving || draft === value} onPress={save} />
        {draft !== value ? <Btn title="Discard" onPress={() => setDraft(value)} /> : null}
      </View>
    </View>
  )
}

const andList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '')

// A built-in or skill totem runs a skill; its instructions are edited here, in
// the totem (web TotemsView.tsx SkillInstructions).
function SkillInstructions({ job }: { job: any }) {
  const [skill, setSkill] = useState<any | null | undefined>(undefined)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const adopt = (payload: any) => {
    const found = (payload.skills || []).find((x: any) => x.id === job.skillId) || null
    setSkill(found)
    setBody(found?.body || '')
    setPreview(null)
  }
  useEffect(() => { getSkills().then(adopt).catch((e: any) => { setSkill(null); pushError(e.message) }) }, [job.skillId]) // eslint-disable-line react-hooks/exhaustive-deps
  if (skill === undefined) return <Section title="Instructions"><T muted>Loading…</T></Section>
  if (skill === null) return <Section title="Instructions"><T muted size={13}>Its instructions (“{job.skillId}”) are missing, so a run has nothing to follow.</T></Section>
  const others = (skill.usedBy || []).filter((j: any) => j.id !== job.id)
  const dirty = body !== skill.body
  async function act(fn: () => Promise<any>, message: string) {
    setBusy(true)
    try { adopt(await fn()); success(); pushToast(message, 'info') } catch (e: any) { pushError(e.message) } finally { setBusy(false) }
  }
  return (
    <Section
      title="Instructions"
      hint={`What ${job.name} tells the AI each run.${others.length ? ` ${andList(others.map((j: any) => j.name))} ${others.length === 1 ? 'follows' : 'follow'} the same instructions, so a change here changes ${others.length === 1 ? 'it' : 'them'} too.` : ''}`}
    >
      <Area value={body} onChange={setBody} rows={14} mono />
      {preview !== null ? <T size={12.5} lineHeight={18} color={textAlpha(80)} style={st.preview} selectable>{preview}</T> : null}
      <View style={st.actions}>
        <Btn kind="primary" title="Save instructions" disabled={busy || !dirty || !body.trim()} onPress={() => act(() => updateSkill(skill.id, { body }), 'Saved the instructions')} />
        {dirty ? <Btn title="Discard" disabled={busy} onPress={() => setBody(skill.body)} /> : null}
        <Btn
          title={preview !== null ? 'Hide preview' : 'Preview'}
          disabled={busy}
          onPress={async () => {
            if (preview !== null) { setPreview(null); return }
            setBusy(true)
            try { const r: any = await previewSkill(skill.id, body); setPreview(r.text || '') } catch (e: any) { pushError(e.message) } finally { setBusy(false) }
          }}
        />
        {skill.kind === 'seeded' && skill.modified ? (
          <Btn
            title="Reset to original"
            disabled={busy}
            onPress={async () => {
              if (await confirm('Reset the instructions?', { message: 'Puts back the instructions that ship with Totem. Your changes are discarded.' })) await act(() => resetSkill(skill.id), 'Restored the original instructions')
            }}
          />
        ) : null}
      </View>
    </Section>
  )
}

function SettingsTab({ job }: { job: any }) {
  const agent = !job.runner && !job.skillId
  const [instructions, setInstructions] = useState(job.prompt || '')
  const [recommending, setRecommending] = useState(false)
  // A watch is saved with a button, not per keystroke: half a path is not a watch.
  const [trigger, setTrigger] = useState<Watch | null>(asWatch(job.trigger))
  useEffect(() => setInstructions(job.prompt || ''), [job.id, job.prompt])
  useEffect(() => setTrigger(asWatch(job.trigger)), [job.id, JSON.stringify(job.trigger)]) // eslint-disable-line react-hooks/exhaustive-deps
  const triggerDirty = JSON.stringify(trigger) !== JSON.stringify(asWatch(job.trigger))
  const save = async (patch: any) => {
    try { const r: any = await updateJob(job.id, patch); replaceJob(r.job) } catch (e: any) { pushError(e.message) }
  }
  const recs: Rec[] = job.recommendations || []
  async function recommend() {
    setRecommending(true)
    try { const r = await api<{ job: any }>(`/api/totems/${encodeURIComponent(job.id)}/recommend`, { method: 'POST' }); replaceJob(r.job) }
    catch (e: any) { pushError(e.message) } finally { setRecommending(false) }
  }
  async function remove() {
    const ok = await confirm(`Delete ${job.name}?`, {
      message: `Its memory and chat are deleted too.${job.kind === 'seeded' ? ' It shipped with Totem; you can restore it from Settings → Jobs.' : ''}`,
    })
    if (!ok) return
    try {
      await deleteJob(job.id)
      pushToast(`Deleted ${job.name}`, 'info')
      dropJob(job.id)
      router.back()
      void loadJobs()
    } catch (e: any) { pushError(e.message) }
  }
  return (
    <View style={{ gap: 10 }}>
      {agent ? (
        <Section title="Instructions">
          <Area value={instructions} onChange={setInstructions} />
          {instructions !== (job.prompt || '') ? (
            <View style={st.actions}><Btn kind="primary" title="Save instructions" onPress={() => save({ prompt: instructions })} /></View>
          ) : null}
        </Section>
      ) : job.skillId ? (
        <SkillInstructions job={job} />
      ) : (
        <Section title="What it runs">
          <T muted size={13}>Built-in code ({job.runner}), with no instructions to edit. Its schedule and notifications are below.</T>
        </Section>
      )}
      <Section title="When it runs">
        <WhenItRuns
          schedule={job.schedule}
          trigger={trigger}
          onSchedule={(schedule) => save({ schedule })}
          onTrigger={(t) => { setTrigger(t); if (!t && job.trigger) save({ trigger: null }) }}
          seen={triggerDirty ? undefined : job.watch?.seen}
        />
        {trigger && triggerDirty ? (
          <View style={st.actions}>
            <Btn kind="primary" title={job.trigger ? 'Save watch' : 'Start watching'} disabled={!watchReady(trigger)} onPress={() => save({ trigger })} />
            <Btn title="Discard" onPress={() => setTrigger(asWatch(job.trigger))} />
          </View>
        ) : null}
        {job.trigger && !triggerDirty && job.watch?.checkedAt ? (
          <T size={12} muted>Last checked {relativeTime(job.watch.checkedAt)}.{job.watch.error ? ` ${job.watch.error}` : ''}</T>
        ) : null}
      </Section>
      {!job.agentless && !job.fixedProvider ? (
        <Section title="Model">
          <ModelSection
            recs={recs}
            value={{ provider: job.provider || 'default', model: job.model || '', effort: job.effort || '' }}
            onChange={(c) => save({ provider: c.provider, model: c.model || null, effort: c.effort || null })}
          />
          <View style={st.actions}>
            <Btn
              compact
              icon={recommending ? IconLoader2 : IconRefresh}
              title={recommending ? 'Asking…' : recs.length ? 'Recommend again' : 'Recommend models'}
              disabled={recommending}
              onPress={recommend}
            />
          </View>
        </Section>
      ) : null}
      <Section title="Notify me">
        <Select
          value={job.notify}
          options={NOTIFY_CHOICES.filter((c) => agent || c.id !== 'agent').map((c) => ({ value: c.id, label: c.label }))}
          onChange={(notify) => save({ notify })}
        />
      </Section>
      {agent ? (
        <Section title="Browser">
          <View style={st.switchRow}>
            <Toggle value={!!job.browser} onChange={(v) => save({ browser: v })} />
            <T size={13.5} color={textAlpha(80)} style={{ flex: 1 }}>Use the browser for pages that need JavaScript</T>
          </View>
        </Section>
      ) : null}
      <View style={{ paddingTop: 10 }}>
        <Btn kind="danger" compact icon={IconTrash} title="Delete totem" onPress={remove} style={{ alignSelf: 'flex-start' }} />
      </View>
    </View>
  )
}

export default function TotemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const jobs = useJobs()
  const job = jobs?.find((j) => j.id === id)
  const [tab, setTab] = useState<'settings' | 'memory' | 'runs'>('settings')
  const [running, setRunning] = useState(false)

  // Arrived from a deep link or search with the list never loaded.
  useEffect(() => { if (!jobs) void loadJobs() }, [jobs])

  async function run() {
    if (!job) return
    setRunning(true)
    try {
      const r: any = await runJobNow(job.id)
      const fresh = (r.jobs || []).find((j: any) => j.id === job.id)
      if (fresh) replaceJob(fresh)
      const status = r.run?.status
      pushToast(
        status === 'error' ? `${job.name} failed: ${r.run?.error || 'no error text'}` : status === 'skipped' ? `${job.name} checked: nothing new` : `${job.name} ran. Its report is in its chat.`,
        status === 'error' ? 'error' : 'info',
      )
    } catch (e: any) { pushError(e.message) } finally { setRunning(false) }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {!job ? (
        jobs ? <T muted style={{ padding: 20 }}>That totem no longer exists.</T> : <Spinner />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: FAB_CLEARANCE }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
        >
          <View style={st.head}>
            <TotemIcon name={job.iconName} large />
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <T size={24} weight={600} lineHeight={30}>{job.name}</T>
              <T size={13} muted lineHeight={18}>{kindOf(job)} · {job.scheduleLabel} · {statusLine(job)}</T>
            </View>
            <Toggle value={!!job.enabled} onChange={(v) => { void setEnabled(job, v) }} />
          </View>
          <View style={[st.actions, { marginTop: 16, marginBottom: 6 }]}>
            <Btn kind="primary" icon={IconMessage} title="Chat with it" onPress={() => { void openTotemChat(job) }} />
            <Btn title={running ? 'Running…' : 'Run now'} disabled={running || job.lastRun?.status === 'running'} onPress={run} />
          </View>
          <Segmented
            style={{ marginTop: 14, marginBottom: 14 }}
            value={tab}
            onChange={setTab}
            options={[{ value: 'settings', label: 'Settings' }, { value: 'memory', label: 'Memory' }, { value: 'runs', label: 'Runs' }]}
          />
          {tab === 'settings' ? <SettingsTab job={job} /> : null}
          {tab === 'memory' ? <MemoryTab job={job} /> : null}
          {tab === 'runs' ? <RunHistory jobId={job.id} /> : null}
        </ScrollView>
      )}
    </View>
  )
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  preview: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg, fontFamily: fonts.mono },
  input: {
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, borderRadius: 12,
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line,
    color: colors.text, fontFamily: fonts[400], fontSize: 14.5, lineHeight: 22,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
})
