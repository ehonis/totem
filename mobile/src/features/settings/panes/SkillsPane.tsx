// Settings → Skills (web SkillsView.tsx): every prompt Totem runs, the built-in
// ones included, each a Markdown file on the server. The list switches a skill on
// or off in place; a row opens its editor (app/settings/skill.tsx).
import React, { useCallback, useMemo, useState } from 'react'
import { View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { AuthError, getSkills, updateSkill } from '../../../lib/api'
import { Hi, ClockIcon, CommandLineIcon, PlusIcon, SparklesIcon } from '../../../lib/icons'
import { iconFor } from '../../../lib/studio'
import { pushError } from '../../../lib/toast'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn } from '../../../ui/kit'
import { Link, Loading, Notice, Pill, Row, Section, Switch, copy } from '../ui'

export const openSkill = (id: string) => router.push({ pathname: '/settings/skill', params: { id } })
export const newSkill = () => router.push({ pathname: '/settings/skill', params: { new: '1' } })

function SkillRow({ skill, busy, onToggle }: { skill: any; busy: boolean; onToggle: (on: boolean) => void }) {
  const Icon = iconFor(skill.iconName, skill.kind === 'seeded' ? 'sparkles' : 'command')
  const on = skill.enabled !== false
  return (
    <Row
      title={skill.name}
      icon={<Hi icon={Icon} size={16} color={skill.kind === 'seeded' ? colors.accent2 : colors.accent} />}
      onPress={() => openSkill(skill.id)}
      chevron
      control={<Switch value={on} disabled={busy} label={`${on ? 'Turn off' : 'Turn on'} ${skill.name}`} onChange={onToggle} />}
      description={
        <View style={{ gap: 5 }}>
          {skill.command ? <T size={12.5} mono color={colors.accent}>{skill.command}</T> : null}
          <T size={12.5} muted numberOfLines={1} lineHeight={17}>{skill.description || 'No description.'}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
            <Pill label={skill.kind === 'seeded' ? 'Default' : 'Yours'} />
            {skill.modified ? <Pill label="Edited" tone="warn" /> : null}
            {!on ? <Pill label="Off" /> : null}
            {(skill.usedBy || []).map((job: any) => (
              <View key={job.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Hi icon={ClockIcon} size={11} color={colors.muted} />
                <T size={11.5} muted>{job.scheduleLabel}</T>
              </View>
            ))}
          </View>
        </View>
      }
    />
  )
}

export default function SkillsPane(_: { target?: string }) {
  const [payload, setPayload] = useState<any>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    getSkills().then((p) => { setPayload(p); setError('') }).catch((e: any) => {
      if (!(e instanceof AuthError)) setError(e?.message || 'Could not load skills.')
    })
  }, [])
  // On focus, so an edit made in the editor shows on the way back.
  useFocusEffect(load)

  const skills: any[] = payload?.skills || []
  // Defaults first, then yours, as the web lists them.
  const [seeded, mine] = useMemo(() => [skills.filter((s) => s.kind === 'seeded'), skills.filter((s) => s.kind !== 'seeded')], [skills])

  async function toggle(skill: any, enabled: boolean) {
    setBusy(skill.id)
    // Flip it at once; the server's answer replaces the list either way.
    setPayload((p: any) => p && { ...p, skills: p.skills.map((s: any) => (s.id === skill.id ? { ...s, enabled } : s)) })
    try {
      const next = await updateSkill(skill.id, { enabled })
      if (next?.skills) setPayload(next)
    } catch (e: any) {
      pushError(e?.message || 'That did not work.')
      load()
    } finally {
      setBusy(null)
    }
  }

  if (!payload) return <Loading error={error} />

  const intro = (
    <T size={12.5} muted lineHeight={17}>
      Every prompt Totem runs, the built-in ones included. Each is a Markdown file on the server, so you can edit it here or in your editor
      {payload.dir ? <> (<Link title="copy the folder path" onPress={() => void copy(payload.dir, 'Folder path copied')} />)</> : null}.
    </T>
  )

  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Section id="skills" plain>
        <View style={{ gap: 12, paddingHorizontal: 4 }}>
          {intro}
          <Btn kind="primary" icon={PlusIcon} title="New skill" onPress={newSkill} style={{ alignSelf: 'flex-start' }} />
        </View>
      </Section>

      <Section title="Ships with Totem">
        {seeded.length ? seeded.map((s) => <SkillRow key={s.id} skill={s} busy={busy === s.id} onToggle={(v) => void toggle(s, v)} />) : (
          <Row
            icon={<Hi icon={SparklesIcon} size={16} color={colors.muted} />}
            title="No default skills"
            description="You’ve deleted every default skill. New ones still arrive when Totem ships them."
          />
        )}
      </Section>

      <Section title="Yours">
        {mine.length ? mine.map((s) => <SkillRow key={s.id} skill={s} busy={busy === s.id} onToggle={(v) => void toggle(s, v)} />) : (
          <Row
            icon={<Hi icon={CommandLineIcon} size={16} color={colors.muted} />}
            title="No skills of your own yet"
            description="Create one, or copy a default and change it."
          />
        )}
      </Section>
    </>
  )
}
