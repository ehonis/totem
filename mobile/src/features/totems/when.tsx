// What wakes a totem (a schedule, or a watched git branch or web page) and which
// model runs it (the builder's picks, or any model on any account). Web
// TotemsView.tsx WhenItRuns / WatchEditor / ModelSection.
import React, { useEffect, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { useChat, loadProviders, ensureModels } from '../../lib/chat/store'
import { visibleModels } from '../../lib/chat/models'
import { colors, fonts, alpha, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { Select } from '../settings/ui'
import { Recommendations, ScheduleBuilder, st as shared, type Choice, type Rec, type Watch, type WatchSource, sourceKey } from './shared'

function Tabs<V extends string>({ options, value, onChange, label }: { options: { id: V; label: string }[]; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <View style={shared.tabs} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((o, i) => {
        const on = o.id === value
        return (
          <Press
            key={o.id}
            onPress={() => { tap(); if (!on) onChange(o.id) }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[shared.tab, i < options.length - 1 && { borderRightWidth: 1, borderRightColor: colors.line }, on && { backgroundColor: alpha(colors.accent, 0.2) }]}
          >
            <T size={12.5} weight={on ? 600 : 400} color={on ? colors.text : colors.muted} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{o.label}</T>
          </Press>
        )
      })}
    </View>
  )
}

function Labeled({ label, children, hint }: { label: React.ReactNode; children: React.ReactNode; hint?: string }) {
  return (
    <View style={{ gap: 6 }}>
      <T size={13} muted>{label}</T>
      {children}
      {hint ? <T size={12} muted lineHeight={17}>{hint}</T> : null}
    </View>
  )
}

function Line(props: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      selectionColor={colors.accent}
      keyboardAppearance="dark"
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      {...props}
      style={[st.input, props.style]}
    />
  )
}

// Clamped when the field is left, not per keystroke: typing "15" passes through "1".
function Minutes({ value, min, onChange }: { value: number; min: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = Math.max(min, Math.min(1440, Number(text) || min))
    setText(String(n))
    if (n !== value) onChange(n)
  }
  return (
    <Line
      style={{ width: 76, minHeight: 34, paddingVertical: 5 }}
      keyboardType="number-pad"
      value={text}
      onChangeText={setText}
      onBlur={commit}
      onSubmitEditing={commit}
      accessibilityLabel="Minutes between checks"
    />
  )
}

const NEW_GIT: WatchSource = { kind: 'git', repo: '', ref: 'main' }
export const NEW_WATCH: Watch = { type: 'watch', everyMinutes: 5, sources: [NEW_GIT] }
const MAX_SOURCES = 20

const sourceReady = (s: WatchSource) => (s.kind === 'git' ? !!s.repo.trim() && !!s.ref.trim() : /^https?:\/\/\S+/.test(s.url.trim()))
export const watchReady = (w: Watch | null) => !w || (w.sources.length > 0 && w.sources.every(sourceReady))

function SourceFields({ source: s, onChange }: { source: WatchSource; onChange: (s: WatchSource) => void }) {
  return (
    <>
      <Tabs
        label="What it watches"
        value={s.kind}
        options={[{ id: 'git', label: 'A git branch' }, { id: 'url', label: 'A web page' }]}
        onChange={(k) => { if (k !== s.kind) onChange(k === 'git' ? NEW_GIT : { kind: 'url', url: '', contains: '' }) }}
      />
      {s.kind === 'git' ? (
        <>
          <Labeled label="Repository">
            <Line value={s.repo} onChangeText={(repo) => onChange({ ...s, repo })} placeholder="/home/you/projects/app, or https://github.com/owner/repo" />
          </Labeled>
          <Labeled label="Branch">
            <Line value={s.ref} onChangeText={(ref) => onChange({ ...s, ref })} />
          </Labeled>
        </>
      ) : (
        <>
          <Labeled label="Page">
            <Line value={s.url} onChangeText={(url) => onChange({ ...s, url })} placeholder="https://…" keyboardType="url" />
          </Labeled>
          <Labeled label={<T size={13} muted>Only when it shows this text <T size={13} muted style={{ opacity: 0.7 }}>(optional)</T></T>}>
            <Line value={s.contains || ''} onChangeText={(contains) => onChange({ ...s, contains })} placeholder="e.g. In stock" autoCapitalize="sentences" />
          </Labeled>
        </>
      )}
    </>
  )
}

/** Web TotemsView WatchEditor: one or more sources, checked together. `seen` is each source's saved baseline. */
export function WatchEditor({ value, onChange, seen }: { value: Watch; onChange: (w: Watch) => void; seen?: Record<string, { label: string }> }) {
  const sources = value.sources
  const min = sources.some((s) => s.kind === 'url') ? 5 : 1
  const setSources = (next: WatchSource[]) => {
    // A page is checked at most every 15 minutes by default; adding the first one raises a faster interval.
    const pageMin = next.some((s) => s.kind === 'url') && !sources.some((s) => s.kind === 'url')
    onChange({ ...value, sources: next, everyMinutes: pageMin ? Math.max(value.everyMinutes, 15) : value.everyMinutes })
  }
  return (
    <View style={{ gap: 12 }}>
      {sources.map((s, i) => (
        <View key={i} style={st.source}>
          <SourceFields source={s} onChange={(n) => setSources(sources.map((x, j) => (j === i ? n : x)))} />
          {seen?.[sourceKey(s)] || sources.length > 1 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T size={12} muted style={{ flex: 1 }} numberOfLines={2}>{seen?.[sourceKey(s)] ? `Last seen: ${seen[sourceKey(s)].label}` : ''}</T>
              {sources.length > 1 ? (
                <Press onPress={() => { tap(); setSources(sources.filter((_, j) => j !== i)) }} hitSlop={6} accessibilityLabel="Stop watching this">
                  <T size={13} color={colors.red}>Remove</T>
                </Press>
              ) : null}
            </View>
          ) : null}
        </View>
      ))}
      {sources.length < MAX_SOURCES ? (
        <Press onPress={() => { tap(); setSources([...sources, NEW_GIT]) }} style={st.addSource} accessibilityRole="button">
          <T size={13.5} color={colors.accent}>+ Watch another</T>
        </Press>
      ) : null}
      {sources.some((s) => s.kind === 'git') ? <T size={12} muted lineHeight={17}>A checkout on Totem's machine is watched through its origin remote, so it wakes on what was merged upstream, not on local commits.</T> : null}
      {sources.some((s) => s.kind === 'url') ? <T size={12} muted lineHeight={17}>With text, a page wakes it when that text appears or disappears. Without, any change to the page's text counts, so pick a page that doesn't change on every load.</T> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T size={13} muted>Check every</T>
        <Minutes value={value.everyMinutes} min={min} onChange={(everyMinutes) => onChange({ ...value, everyMinutes })} />
        <T size={13} muted>minutes</T>
      </View>
      <T size={12} muted lineHeight={17}>Checks use no AI. The first one only notes how things look now; the totem runs each time {sources.length > 1 ? 'any of them changes, told which ones did' : 'that changes'}.</T>
    </View>
  )
}

export function WhenItRuns({ schedule, trigger, onSchedule, onTrigger, seen }: { schedule: any; trigger: Watch | null; onSchedule: (s: any) => void; onTrigger: (t: Watch | null) => void; seen?: Record<string, { label: string }> }) {
  return (
    <>
      <Tabs
        label="What wakes it"
        value={trigger ? 'watch' : 'schedule'}
        options={[{ id: 'schedule', label: 'On a schedule' }, { id: 'watch', label: 'When something changes' }]}
        onChange={(v) => onTrigger(v === 'watch' ? NEW_WATCH : null)}
      />
      <View style={{ marginTop: 4 }}>
        {trigger ? <WatchEditor value={trigger} onChange={onTrigger} seen={seen} /> : <ScheduleBuilder value={schedule} onChange={onSchedule} />}
      </View>
    </>
  )
}

const EFFORTS = [{ value: '', label: 'Default' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]

/**
 * Any model on any account, the same list chats use (minus Auto, Instant and
 * Thinking: a scheduled run has nobody to route for). The web uses the chat's
 * model picker; here it is three native menus: account, model, effort.
 */
function ModelChoice({ value, onChange }: { value: Choice; onChange: (c: Choice) => void }) {
  const providers = useChat((s) => s.providers)
  const defaultProvider = useChat((s) => s.defaultProvider)
  const models = useChat((s) => s.models)
  useEffect(() => { if (!providers.length) loadProviders() }, [providers.length])
  const provider = !value.provider || value.provider === 'default' ? defaultProvider : value.provider
  useEffect(() => { if (provider) ensureModels(provider) }, [provider, providers.length])
  const list = visibleModels(models[provider])
  return (
    <View style={{ gap: 8, alignSelf: 'stretch' }}>
      <Select
        value={provider}
        onChange={(p) => onChange({ provider: p, model: '', effort: value.effort })}
        options={providers.map((p) => ({ value: p.id, label: p.name }))}
      />
      <Select
        value={value.model || ''}
        onChange={(m) => onChange({ provider, model: m, effort: value.effort })}
        options={[{ value: '', label: 'Account default' }, ...list.map((m) => ({ value: m.id, label: m.name }))]}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T size={13} muted>Effort</T>
        <Select style={{ minWidth: 120 }} value={value.effort || ''} onChange={(effort) => onChange({ ...value, effort })} options={EFFORTS} />
      </View>
    </View>
  )
}

/** The builder's picks, cheapest first, then any model at all. */
export function ModelSection({ recs, value, onChange }: { recs: Rec[]; value: Choice; onChange: (c: Choice) => void }) {
  const picked = recs.findIndex((r) => r.provider === value.provider && (r.model || '') === (value.model || ''))
  return (
    <>
      {recs.length > 0 ? (
        <Recommendations recs={recs} value={picked} onChange={(i) => onChange({ provider: recs[i].provider, model: recs[i].model || '', effort: recs[i].effort || '' })} />
      ) : null}
      <View style={[shared.rec, { flexDirection: 'column', alignItems: 'stretch', gap: 10 }, picked < 0 && shared.recOn]}>
        <View style={{ gap: 2 }}>
          <T size={14} weight={500}>{recs.length ? 'Or choose any model' : 'Model'}</T>
          <T size={13} lineHeight={19} color={textAlpha(68)}>
            {!recs.length ? 'Any model on any account, the same list chats use.' : picked < 0 ? 'Your pick. It runs on this instead of the suggestions.' : 'Pick from every account, the same list chats use.'}
          </T>
        </View>
        <ModelChoice value={value} onChange={onChange} />
      </View>
    </>
  )
}

const st = StyleSheet.create({
  input: {
    minHeight: 40, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10,
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line,
    color: colors.text, fontFamily: fonts[400], fontSize: 14,
  },
  // One watched source: its fields in a quiet card, so several read as separate items.
  source: { gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: alpha(colors.bg3, 0.5) },
  addSource: { alignSelf: 'flex-start', paddingVertical: 6 },
})
