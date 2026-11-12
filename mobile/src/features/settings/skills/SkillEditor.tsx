// Settings → Skills › one skill (web SkillsView.tsx SkillEditor and NewSkillForm),
// pushed from the list. `id` edits a skill; `new=1` makes one. Save sits in the
// header; Preview, Reset and Delete under the form.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import {
  AuthError, createSkill, deleteSkill, getSkills, previewSkill, resetSkill, updateSkill,
} from '../../../lib/api'
import { Hi, ArrowPathIcon, ExclamationTriangleIcon, EyeIcon, InformationCircleIcon, TrashIcon } from '../../../lib/icons'
import { STUDIO_ICON_OPTIONS, iconFor } from '../../../lib/studio'
import { pushError, pushSuccess } from '../../../lib/toast'
import { colors, alpha } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Press } from '../../../ui/kit'
import { confirm } from '../../../ui/menu'
import { success, tap } from '../../../ui/haptics'
import { Field, Loading, Notice, PaneScroll, Picker, Row, Section, Switch, useDiscardGuard } from '../ui'

const MODE_CHOICES = [
  { value: 'send', label: 'Run it straight away' },
  { value: 'fill', label: 'Put it in the composer to finish' },
]

// What each {{variable}} the bridge can fill means (the web's VARIABLE_HELP). A
// long press on a chip shows it, since a phone has no hover.
const VARIABLE_HELP: Record<string, string> = {
  now: 'The current date and time, spelled out, in your briefing timezone.',
  weather: 'Today’s weather snapshot. Costs a network call, so only ask when you use it.',
  news: 'Recent AI and world headlines. Also a network call.',
  inboxFile: 'Path to the brain’s inbox.md, where confirm-only proposals are staged.',
  since: 'The journal watermark as an exact instant — empty on a first run.',
  sinceDate: 'The same watermark as YYYY-MM-DD, for Plaud’s whole-day filter.',
  stateFile: 'Path to the Plaud meetings state file.',
  processedSummary: 'The Plaud recordings already processed, as a skip list.',
}

function HeaderButton({ title, disabled, onPress }: { title: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Press onPress={() => { tap(); onPress() }} disabled={disabled} hitSlop={10} accessibilityRole="button" accessibilityLabel={title}>
      <T size={17} weight={600} color={colors.accent}>{title}</T>
    </Press>
  )
}

/** The web's IconPicker: the registry's glyphs in one scrolling strip. */
function IconStrip({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="handled">
      {STUDIO_ICON_OPTIONS.map((name) => {
        const on = name === value
        return (
          <Press
            key={name}
            onPress={() => { tap(); onChange(name) }}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`Use ${name} icon`}
            style={{
              width: 38, height: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
              backgroundColor: on ? alpha(colors.accent, 0.18) : colors.bg, borderWidth: 1, borderColor: on ? colors.accent : colors.line,
            }}
          >
            <Hi icon={iconFor(name)} size={19} color={on ? colors.accent : colors.text} />
          </Press>
        )
      })}
    </ScrollView>
  )
}

function NewSkill() {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  useDiscardGuard(!created && !!(name.trim() || description.trim() || body.trim()))
  // Straight on to the full editor, as the web opens the new skill: after the
  // render that turns the discard guard off, or it would ask about a saved skill.
  useEffect(() => { if (created) router.replace({ pathname: '/settings/skill', params: { id: created } }) }, [created])

  async function create() {
    if (!name.trim()) return
    setBusy(true)
    try {
      const result = await createSkill({ name: name.trim(), description: description.trim(), body: body.trim() })
      success()
      pushSuccess(`Created “${result.skill.name}”`)
      setCreated(result.skill.id)
    } catch (e: any) {
      pushError(e?.message || 'Could not create that skill.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PaneScroll>
      <Stack.Screen options={{ title: 'New skill', headerRight: () => <HeaderButton title="Create" disabled={busy || !!created || !name.trim()} onPress={create} /> }} />
      <Section title="Skill">
        <Row title="Name" stacked control={<Field value={name} onChangeText={setName} placeholder="e.g. Weekly review" autoFocus autoCapitalize="sentences" />} />
        <Row title="Short description" stacked control={<Field value={description} onChangeText={setDescription} placeholder="What this skill does, in a sentence" autoCapitalize="sentences" autoCorrect />} />
      </Section>
      <Section title="Instructions">
        <Row
          title="What to do"
          stacked
          control={<Field multiline value={body} onChangeText={setBody} autoCapitalize="sentences" autoCorrect placeholder="Tell Totem how to perform this skill — steps, tone, which apps to touch…" style={{ minHeight: 140 }} />}
        />
      </Section>
    </PaneScroll>
  )
}

function EditSkill({ id }: { id: string }) {
  const [payload, setPayload] = useState<any>(null)
  const [error, setError] = useState('')
  const skill = payload?.skills?.find((s: any) => s.id === id) || null
  // Bumped on every save and reset, so the editor's fields start again from what
  // the server answered (a reset otherwise showed the old edits). The editor
  // stays mounted, so the scroll, the keyboard and an open preview stay put.
  const [version, setVersion] = useState(0)
  const saved = (next: any) => { setPayload(next); setVersion((v) => v + 1) }

  useEffect(() => {
    getSkills().then(setPayload).catch((e: any) => { if (!(e instanceof AuthError)) setError(e?.message || 'Could not load skills.') })
  }, [])

  if (!payload) return <PaneScroll><Stack.Screen options={{ title: 'Skill' }} /><Loading error={error} /></PaneScroll>
  if (!skill) return <PaneScroll><Stack.Screen options={{ title: 'Skill' }} /><Loading error="That skill is gone." /></PaneScroll>
  return <Editor key={skill.id} skill={skill} version={version} variables={payload.variables || []} onSaved={saved} />
}

function Editor({ skill, version, variables, onSaved }: { skill: any; version: number; variables: string[]; onSaved: (payload: any) => void }) {
  // Some prompts get values only their caller has, so the allowed set is per skill.
  const allowed: string[] = skill.knownVariables?.length ? skill.knownVariables : variables
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description || '')
  const [iconName, setIconName] = useState(skill.iconName || '')
  const [command, setCommand] = useState(skill.command || '')
  const [mode, setMode] = useState(skill.mode || 'send')
  const [enabled, setEnabled] = useState(skill.enabled !== false)
  const [body, setBody] = useState(skill.body || '')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<any>(null)
  const [help, setHelp] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  // What the last Save sent. When its answer lands, a field typed in since keeps
  // the newer text; the rest take the server's. A reset (nothing sent) takes all.
  const sent = useRef<Record<string, unknown> | null>(null)
  useEffect(() => {
    if (!version) return
    const was = sent.current
    sent.current = null
    const take = (key: string, now: unknown) => !was || was[key] === now
    if (take('name', name)) setName(skill.name)
    if (take('description', description)) setDescription(skill.description || '')
    if (take('iconName', iconName)) setIconName(skill.iconName || '')
    if (take('command', command)) setCommand(skill.command || '')
    if (take('mode', mode)) setMode(skill.mode || 'send')
    if (take('enabled', enabled)) setEnabled(skill.enabled !== false)
    if (take('body', body)) setBody(skill.body || '')
  }, [version]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = name !== skill.name || description !== (skill.description || '')
    || iconName !== (skill.iconName || '') || command !== (skill.command || '')
    || mode !== (skill.mode || 'send') || enabled !== (skill.enabled !== false)
    || body !== (skill.body || '')
  useDiscardGuard(dirty && !leaving)

  // Placeholders the bridge has no value for render as nothing at run time:
  // catch the typo here rather than at 08:00 tomorrow.
  const unknownVars = useMemo(() => {
    const used = [...String(body).matchAll(/\{\{\s*[#^/]?([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1])
    return [...new Set(used)].filter((v) => !allowed.includes(v))
  }, [body, allowed])

  async function act(fn: () => Promise<any>, message: string, keep = true) {
    setBusy(true)
    try {
      const next = await fn()
      if (keep) onSaved(next)
      success()
      pushSuccess(message)
      return true
    } catch (e: any) {
      pushError(e?.message || 'That did not work.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    const fields = { name, description, iconName, command, mode, enabled, body }
    sent.current = fields
    return act(() => updateSkill(skill.id, fields), `Saved “${name}”`)
  }

  async function reset() {
    if (!(await confirm(`Restore “${skill.name}”?`, { message: 'Your changes are discarded and the version that ships with Totem comes back.', confirmLabel: 'Restore' }))) return
    sent.current = null
    await act(() => resetSkill(skill.id), `Restored the default “${skill.name}”`)
  }

  async function remove() {
    const message = skill.usedBy?.length
      ? `It is what ${skill.usedBy.map((j: any) => `the ${j.name} job`).join(' and ')} runs. Deleting it leaves that job with nothing to do.`
      : skill.kind === 'seeded' ? 'It ships with Totem, so it will not come back on restart, but you can restore it later.' : undefined
    if (!(await confirm(`Delete “${skill.name}”?`, { message }))) return
    setLeaving(true)
    // Straight back: swapping in the list first would flash "That skill is gone".
    if (await act(() => deleteSkill(skill.id), `Deleted “${skill.name}”`, false)) router.back()
    else setLeaving(false)
  }

  async function showPreview() {
    setBusy(true)
    try { setPreview(await previewSkill(skill.id, body)) } catch (e: any) { pushError(e?.message || 'Could not build a preview.') } finally { setBusy(false) }
  }

  const insertVariable = (v: string) => setBody((b: string) => `${b}${b.endsWith('\n') || !b ? '' : ' '}{{${v}}}`)

  return (
    <PaneScroll>
      <Stack.Screen options={{ title: skill.kind === 'seeded' ? 'Default skill' : 'Skill', headerRight: () => <HeaderButton title="Save" disabled={busy || !dirty || !name.trim()} onPress={() => void save()} /> }} />

      {skill.usedBy?.length > 0 ? (
        <Notice>
          {`Editing this changes ${skill.usedBy.map((j: any) => `“${j.name}” (${String(j.scheduleLabel || '').toLowerCase()})`).join(' and ')}.`}
        </Notice>
      ) : null}

      <Section title="Skill">
        <Row title="Name" stacked control={<Field value={name} onChangeText={setName} placeholder="e.g. Weekly review" autoCapitalize="sentences" />} />
        <Row title="Short description" stacked control={<Field value={description} onChangeText={setDescription} placeholder="What this skill does, in a sentence" autoCapitalize="sentences" autoCorrect />} />
        <Row title="Icon" stacked control={<IconStrip value={iconName} onChange={setIconName} />} />
        <Row title="Enabled" description="An off skill is not offered in chat and its jobs skip it." control={<Switch value={enabled} onChange={setEnabled} label="Enabled" />} />
      </Section>

      <Section title="In chat" description="Type the command in chat to run it. Leave it blank for a skill only jobs use.">
        <Row title="Chat command" stacked control={<Field mono value={command} onChangeText={setCommand} placeholder="/weekly-review" />} />
        <Row title="When you type it" control={<Picker label="When you type it" value={mode} options={MODE_CHOICES} onChange={setMode} />} />
      </Section>

      <Section title="Instructions" description="Sent to the AI as written, with Totem's usual tools and memory.">
        <Row
          title="Instructions"
          stacked
          control={<Field multiline mono value={body} onChangeText={setBody} placeholder="Tell Totem exactly what to do." style={{ minHeight: 260 }} />}
        />
        <Row
          title="Values you can drop in"
          description="Tap to add one at the end. Hold one to see what it holds."
          stacked
          control={
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {allowed.map((v) => {
                const used = body.includes(`{{${v}}}`)
                return (
                  <Press
                    key={v}
                    onPress={() => { tap(); insertVariable(v) }}
                    onLongPress={() => { tap(); setHelp(`{{${v}}}: ${VARIABLE_HELP[v] || 'Filled in by Totem when this runs.'}`) }}
                    accessibilityRole="button"
                    accessibilityLabel={`Insert ${v}`}
                    accessibilityHint={VARIABLE_HELP[v]}
                    style={{ paddingHorizontal: 8, paddingVertical: 5, borderRadius: 7, borderWidth: 1, borderColor: used ? alpha(colors.accent, 0.5) : colors.line, backgroundColor: used ? alpha(colors.accent, 0.12) : colors.bg }}
                  >
                    <T size={12.5} mono color={used ? colors.accent : colors.text}>{`{{${v}}}`}</T>
                  </Press>
                )
              })}
            </View>
          }
        >
          {help ? (
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Hi icon={InformationCircleIcon} size={14} color={colors.muted} />
              <T size={12.5} muted lineHeight={17} style={{ flex: 1 }}>{help}</T>
            </View>
          ) : null}
          {unknownVars.length > 0 ? (
            <View style={{ flexDirection: 'row', gap: 6, marginTop: help ? 8 : 0 }}>
              <Hi icon={ExclamationTriangleIcon} size={14} color={colors.amber} />
              <T size={12.5} color={colors.amber} lineHeight={17} style={{ flex: 1 }}>
                {`${unknownVars.map((v) => `{{${v}}}`).join(', ')} ${unknownVars.length === 1 ? 'is not a value' : 'are not values'} Totem can fill; ${unknownVars.length === 1 ? 'it' : 'they'} will come out blank. Check the spelling.`}
              </T>
            </View>
          ) : null}
        </Row>
      </Section>

      {preview ? (
        <Section title="What the AI will receive">
          <Row title="Preview" stacked control={<T size={12.5} mono selectable lineHeight={18}>{preview.text}</T>}>
            {preview.missing?.length > 0 ? (
              <T size={12.5} color={colors.amber}>Rendered empty: {preview.missing.map((m: string) => `{{${m}}}`).join(', ')}</T>
            ) : null}
          </Row>
        </Section>
      ) : null}

      <Section>
        <Row title="Preview" description="Fill in the values as a run would, without running it." icon={<Hi icon={EyeIcon} size={16} color={colors.accent} />} tone="accent" onPress={() => void showPreview()} disabled={busy} />
        {skill.kind === 'seeded' ? (
          <Row
            title="Reset to default"
            description={skill.modified ? 'Discard your changes and restore the shipped version.' : 'This skill is as it shipped.'}
            icon={<Hi icon={ArrowPathIcon} size={16} color={skill.modified ? colors.accent : colors.muted} />}
            tone={skill.modified ? 'accent' : undefined}
            onPress={skill.modified ? () => void reset() : undefined}
            disabled={busy || !skill.modified}
          />
        ) : null}
        <Row title="Delete skill" icon={<Hi icon={TrashIcon} size={16} color={colors.red} />} tone="danger" onPress={() => void remove()} disabled={busy} />
      </Section>
    </PaneScroll>
  )
}

export default function SkillScreen() {
  const { id, new: isNew } = useLocalSearchParams<{ id?: string; new?: string }>()
  if (isNew || !id) return <NewSkill />
  return <EditSkill id={id} />
}
