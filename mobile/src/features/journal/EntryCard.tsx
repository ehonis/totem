// One journal entry (JournalView.tsx ▸ EntryCard on the web), in its phone layout:
// the actions row sits under the body, the rename pencil is always visible.
//
// The "…" is a native menu (UIMenu) built from the same items as the web's
// EntryMenu, with its separators as inline sections. "Don't ingest" keeps a real
// button while the countdown runs, for the reason the web gives: it is the one
// action with a deadline. Fixing the transcript opens its own sheet.
import React, { useMemo, useState } from 'react'
import { Platform, ScrollView, Share, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { File, Paths } from 'expo-file-system'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import { prompt, showMenu } from '../../ui/menu'
import { tap } from '../../ui/haptics'
import {
  ArrowPathIcon, ArrowTopRightOnSquareIcon, ChevronRightIcon, ClockIcon, EllipsisHorizontalIcon,
  ExclamationTriangleIcon, Hi, InboxStackIcon, MicrophoneIcon, NoSymbolIcon, PencilIcon, PencilSquareIcon, PlayIcon,
  SparklesIcon,
} from '../../lib/icons'
import { journalAudioSource } from '../../lib/api'
import { notifyInboxChanged } from '../../lib/useInboxCount'
import { pushError } from '../../lib/toast'
import { navigateTo } from '../../shell/nav'
import { audioLabel, audioTitle, cardState, entryTitle, fmtBytes, fmtClock, msUntil, timeOfDay } from '../../lib/journal/format'
import type { CardState } from '../../lib/journal/format'
import type { JournalEntry } from '../../lib/journal/types'
import { AudioBar, Spin } from './bits'

export interface EntryCardProps {
  entry: JournalEntry
  now: number
  busy: boolean
  onSkip: () => void
  onIngest: () => void
  onRetry: () => void
  onRename: (title: string) => void
  onKeepAudio: (keep: boolean) => void
  onDeleteAudio: () => void
  onDelete: () => void
}

const STATE_LABEL: Record<CardState, string> = {
  transcribing: 'Transcribing…',
  'transcribe-failed': 'Transcription failed',
  waiting: 'Digest in',
  due: 'Digesting soon…',
  digesting: 'Digesting…',
  digested: 'Digested',
  skipped: 'Not ingested',
  'ingest-failed': 'Digest failed',
}

const STATE_BORDER: Record<CardState, string> = {
  waiting: colors.amber, due: colors.amber,
  transcribing: colors.accent, digesting: colors.accent,
  digested: colors.green,
  'transcribe-failed': colors.red, 'ingest-failed': colors.red,
  skipped: colors.line,
}

const TONE = { ok: colors.green, err: colors.red, muted: colors.muted, warn: colors.amber, info: colors.accent }

interface MenuItem {
  key: string
  label: string
  /** SF Symbol for the UIMenu row. */
  sf: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** The web's tooltip, shown as the row's subtitle. */
  title?: string
  separated?: boolean
}

export default function EntryCard({ entry, now, busy, onSkip, onIngest, onRetry, onRename, onKeepAudio, onDeleteAudio, onDelete }: EntryCardProps) {
  const state = cardState(entry, now)
  const [open, setOpen] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)

  const remaining = msUntil(entry.ingest.at, now)
  const result = entry.ingest.result
  const spinning = state === 'transcribing' || state === 'digesting' || state === 'due'
  const tone = state === 'digested' ? 'ok' : state.endsWith('failed') ? 'err' : state === 'skipped' ? 'muted' : state === 'waiting' ? 'warn' : 'info'
  const toneColor = TONE[tone]
  // With no title of its own the headline is already the opening sentence, so the
  // excerpt picks up after it rather than saying the same thing twice.
  const excerpt = useMemo(() => {
    const text = entry.transcript?.text?.trim()
    if (!text) return null
    const rest = entry.title ? text : text.slice((text.split(/(?<=[.!?])\s+/)[0] || '').length).trim()
    if (!rest) return null
    return rest.length > 180 ? `${rest.slice(0, 178).trimEnd()}…` : rest
  }, [entry.transcript?.text, entry.title])
  const paragraphs = useMemo(() => splitParagraphs(entry.transcript?.text || ''), [entry.transcript?.text])

  const rename = async () => {
    const next = await prompt('Rename entry', { defaultValue: entry.title || '' })
    if (next !== null) onRename(next)
  }

  // What the menu offers depends on where the entry is in its life (as the web).
  const hasAudio = Boolean(entry.audio?.kept)
  const items: MenuItem[] = []
  if (state === 'waiting' || state === 'due') {
    items.push({ key: 'now', label: 'Digest now', sf: 'sparkles', onSelect: onIngest, disabled: state === 'due', title: 'Skip the rest of the countdown' })
  } else if (state === 'skipped') {
    items.push({ key: 'ingest', label: 'Digest it after all', sf: 'sparkles', onSelect: onIngest })
  } else if (state === 'ingest-failed') {
    items.push({ key: 'retry-digest', label: 'Retry digest', sf: 'arrow.clockwise', onSelect: onIngest })
  } else if (state === 'transcribe-failed') {
    items.push({
      key: 'retry-transcribe', label: 'Retry transcription', sf: 'arrow.clockwise', onSelect: onRetry,
      disabled: !hasAudio, title: hasAudio ? undefined : 'The recording is gone, so there is nothing to transcribe',
    })
  } else if (state === 'digested') {
    items.push({ key: 'again', label: 'Digest again', sf: 'arrow.clockwise', onSelect: onIngest, title: 'The transcript is not written to the brain twice.' })
  }
  if (entry.status === 'transcribed') {
    items.push({ key: 'rename', label: 'Rename', sf: 'pencil', onSelect: () => { void rename() }, separated: items.length > 0 })
  }
  if (entry.source === 'voice') {
    items.push(
      hasAudio
        ? {
          key: 'keep', label: entry.audio?.pinned ? 'Stop keeping the recording' : 'Keep the recording',
          sf: entry.audio?.pinned ? 'bookmark.slash' : 'bookmark', separated: true, onSelect: () => onKeepAudio(!entry.audio?.pinned),
          title: entry.audio?.pinned ? 'Let it expire on the normal schedule again' : 'Never delete this recording on a timer',
        }
        : { key: 'gone', label: 'Recording deleted', sf: 'mic.slash', onSelect: () => {}, disabled: true, separated: true, title: audioTitle(entry.audio, now) },
    )
    if (hasAudio) {
      items.push({ key: 'delete-audio', label: 'Delete the recording', sf: 'trash', danger: true, onSelect: onDeleteAudio, title: 'Keep the transcript' })
    }
  }
  items.push({ key: 'delete', label: 'Delete entry', sf: 'trash', danger: true, onSelect: onDelete, separated: true })

  return (
    <View style={[st.card, { borderLeftColor: open ? colors.line : STATE_BORDER[state] }, state === 'skipped' && { opacity: 0.82 }]}>
      <View style={st.top}>
        <T size={11.5} weight={600} style={st.tabular}>{timeOfDay(entry.recordedAt)}</T>
        {entry.durationSec != null && <T size={11.5} muted style={st.tabular}>{fmtClock(entry.durationSec)}</T>}
        <View style={st.src}>
          <Hi icon={entry.source === 'voice' ? MicrophoneIcon : PencilSquareIcon} size={12} color={entry.audio?.pinned ? colors.accent : colors.muted} />
          <T size={11.5} color={entry.audio?.pinned ? colors.accent : colors.muted}>{entry.source === 'voice' ? audioLabel(entry.audio, now) : 'typed'}</T>
        </View>
        <View style={[st.state, { borderColor: alpha(toneColor, 0.4) }, tone === 'muted' && { borderColor: colors.line }]}>
          {spinning ? <Spin icon={ArrowPathIcon} size={12} color={toneColor} />
            : <Hi size={12} color={toneColor} icon={state === 'digested' ? SparklesIcon : state === 'skipped' ? NoSymbolIcon : state === 'waiting' ? ClockIcon : ExclamationTriangleIcon} />}
          <T size={11} weight={600} color={toneColor} lineHeight={15}>
            {STATE_LABEL[state]}
            {state === 'waiting' ? <T size={11} weight={700} style={st.tabular}>{` ${fmtClock(Math.ceil(remaining / 1000))}`}</T> : null}
          </T>
        </View>
      </View>

      <View style={st.titleRow}>
        <T size={15} weight={600} lineHeight={20} style={{ flexShrink: 1 }}>{entryTitle(entry)}</T>
        {entry.status === 'transcribed' && (
          <Press onPress={() => { void rename() }} hitSlop={8} accessibilityLabel="Rename entry" style={{ padding: 2 }}>
            <Hi icon={PencilIcon} size={12} color={colors.muted} />
          </Press>
        )}
      </View>

      {!open && excerpt ? <T size={13} muted lineHeight={19} style={{ marginTop: 6 }}>{excerpt}</T> : null}
      {state === 'transcribe-failed' && entry.error ? <T size={12.5} color={colors.red} style={{ marginTop: 6 }}>{entry.error}</T> : null}
      {state === 'ingest-failed' && entry.ingest.error ? <T size={12.5} color={colors.red} style={{ marginTop: 6 }}>{entry.ingest.error}</T> : null}

      {result && state === 'digested' && (
        <View style={st.result}>
          {result.summary ? <T size={13} lineHeight={19}>{result.summary}</T> : null}
          <View style={st.chips}>
            {result.memory.length > 0 && <Chip label={`${result.memory.length} memory ${result.memory.length === 1 ? 'update' : 'updates'}`} />}
            {result.habits.length > 0 && <Chip label={`${result.habits.length} ${result.habits.length === 1 ? 'habit' : 'habits'} logged`} />}
            {result.proposals.length > 0 && (
              <Chip
                label={`${result.proposals.length} in Inbox`}
                icon={InboxStackIcon}
                link
                onPress={() => { notifyInboxChanged(); navigateTo('inbox') }}
              />
            )}
            {result.mood ? <Chip label={result.mood} muted /> : null}
            {!result.parsed ? <Chip label="unstructured reply" muted /> : null}
          </View>
        </View>
      )}

      {entry.transcript && (
        <Press onPress={() => { tap(); setOpen((v) => !v) }} style={st.disclose} accessibilityState={{ expanded: open }}>
          <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
            <Hi icon={ChevronRightIcon} size={13} color={colors.muted} />
          </View>
          <T size={12} muted>{open ? 'Hide transcript' : 'Show transcript'}</T>
        </Press>
      )}

      <View style={st.actions}>
        {(state === 'waiting' || state === 'due') && (
          <Btn compact kind="danger" icon={NoSymbolIcon} disabled={busy || state === 'due'} onPress={onSkip}>
            <T size={12} weight={600} color="#f0879e">Don’t ingest</T>
          </Btn>
        )}
        <EntryMenu items={items} disabled={busy} />
      </View>

      {open && entry.transcript && (
        <View style={st.transcript}>
          <AudioPlayback entry={entry} />
          {paragraphs.map((p, i) => <T key={i} size={14} lineHeight={22} style={{ marginBottom: 10 }}>{p}</T>)}
          <View style={st.meta}>
            {entry.transcript.model ? <T size={11.5} muted>whisper {entry.transcript.model}</T> : null}
            {entry.transcript.ms > 0 ? <T size={11.5} muted>{Math.round(entry.transcript.ms / 1000)} s to transcribe</T> : null}
            {entry.transcript.editedAt ? <T size={11.5} muted>edited</T> : null}
            {entry.ingest.journalFile ? <T size={11.5} muted>brain: {entry.ingest.journalFile}</T> : null}
            {entry.status === 'transcribed' && (
              <Press onPress={() => router.push(`/journal/${encodeURIComponent(entry.id)}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Hi icon={PencilSquareIcon} size={12} color={colors.muted} />
                <T size={11.5} muted style={{ textDecorationLine: 'underline' }}>Fix the transcript</T>
              </Press>
            )}
          </View>
          {result?.reply ? (
            <View style={{ marginTop: 10 }}>
              <Press onPress={() => setReplyOpen((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <View style={{ transform: [{ rotate: replyOpen ? '90deg' : '0deg' }] }}>
                  <Hi icon={ChevronRightIcon} size={11} color={colors.muted} />
                </View>
                <T size={12} muted>What the digest said</T>
              </Press>
              {replyOpen ? (
                <ScrollView style={st.reply} nestedScrollEnabled>
                  <T size={12} muted mono lineHeight={17} selectable>{result.reply}</T>
                </ScrollView>
              ) : null}
            </View>
          ) : null}
        </View>
      )}
    </View>
  )
}

function Chip({ label, icon, link, muted, onPress }: { label: string; icon?: any; link?: boolean; muted?: boolean; onPress?: () => void }) {
  const color = link ? colors.accent : muted ? colors.muted : colors.text
  const body = (
    <View style={[st.chip, link && { borderColor: alpha(colors.accent, 0.4) }]}>
      {icon ? <Hi icon={icon} size={12} color={color} /> : null}
      <T size={11} color={color} lineHeight={15}>{label}</T>
    </View>
  )
  return onPress ? <Press onPress={onPress}>{body}</Press> : body
}

/** The ⋯ menu: a UIMenu on iOS, an action sheet elsewhere. */
function EntryMenu({ items, disabled }: { items: MenuItem[]; disabled: boolean }) {
  const face = (
    <View style={[st.menuToggle, disabled && { opacity: 0.45 }]} accessibilityLabel="Actions for this entry">
      <Hi icon={EllipsisHorizontalIcon} size={18} color={colors.muted} />
    </View>
  )
  if (disabled || !items.length) return face
  if (Platform.OS === 'ios') {
    const groups: MenuItem[][] = []
    for (const it of items) {
      if (it.separated || !groups.length) groups.push([])
      groups[groups.length - 1].push(it)
    }
    const toAction = (it: MenuItem): MenuAction => ({
      id: it.key,
      title: it.label,
      subtitle: it.title,
      image: it.sf,
      imageColor: it.danger ? colors.red : undefined,
      attributes: { destructive: it.danger, disabled: it.disabled },
    })
    const actions: MenuAction[] = groups.length === 1
      ? groups[0].map(toAction)
      : groups.map((g, i) => ({ id: `group-${i}`, title: '', displayInline: true, subactions: g.map(toAction) }))
    return (
      <MenuView
        actions={actions}
        themeVariant="dark"
        onPressAction={({ nativeEvent }) => items.find((it) => it.key === nativeEvent.event)?.onSelect()}
      >
        {face}
      </MenuView>
    )
  }
  return (
    <Press onPress={() => showMenu(items.filter((it) => !it.disabled).map((it) => ({ label: it.label, onPress: it.onSelect, destructive: it.danger })))}>
      {face}
    </Press>
  )
}

/**
 * Play back a kept recording. expo-audio sends the bearer header with the source,
 * so it streams from the bridge; nothing loads until asked, as on the web.
 */
function AudioPlayback({ entry }: { entry: JournalEntry }) {
  const [playing, setPlaying] = useState(false)
  const [sharing, setSharing] = useState(false)
  const source = useMemo(() => journalAudioSource(entry.id), [entry.id])
  if (!entry.audio?.kept) return null

  // "Save a copy": download to the cache with the header, then the share sheet
  // (Save to Files, AirDrop, …) stands in for the browser's download.
  const saveCopy = async () => {
    setSharing(true)
    try {
      const ext = (entry.audio!.mime.split('/')[1] || 'm4a').replace('mpeg', 'mp3').replace('mp4', 'm4a')
      const dest = new File(Paths.cache, `${entry.date}-journal.${ext}`)
      if (dest.exists) dest.delete()
      const file = await File.downloadFileAsync(source.uri, dest, { headers: source.headers })
      await Share.share({ url: file.uri })
    } catch (e: any) {
      pushError(e?.message || 'That recording could not be saved.')
    } finally {
      setSharing(false)
    }
  }

  if (playing) {
    return (
      <View style={st.audio}>
        <AudioBar source={source} autoPlay />
        {Platform.OS !== 'web' && (
          <Press onPress={saveCopy} disabled={sharing} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Hi icon={ArrowTopRightOnSquareIcon} size={12} color={colors.muted} />
            <T size={12} muted style={{ textDecorationLine: 'underline' }}>{sharing ? 'Preparing…' : 'Save a copy'}</T>
          </Press>
        )}
      </View>
    )
  }
  return (
    <View style={st.audio}>
      <Btn compact icon={PlayIcon} title={`Play the recording (${fmtBytes(entry.audio.bytes)})`} onPress={() => setPlaying(true)} style={{ alignSelf: 'flex-start' }} />
      <T size={11.5} muted>{audioTitle(entry.audio)}</T>
    </View>
  )
}

/** Client-side paragraphing for display; the brain page gets the real thing. */
function splitParagraphs(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  if (text.includes('\n\n')) return text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  const sentences = clean.split(/(?<=[.!?]["')]?)\s+/)
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    const t = s.trim()
    if (!t) continue
    if (cur && cur.length + t.length > 600) { out.push(cur); cur = t } else cur = cur ? `${cur} ${t}` : t
  }
  if (cur) out.push(cur)
  return out
}

const st = StyleSheet.create({
  card: {
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 12,
    paddingVertical: 13, paddingHorizontal: 15, borderLeftWidth: 3,
  },
  tabular: { fontVariant: ['tabular-nums'] },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 },
  src: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  state: {
    flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 'auto',
    borderRadius: 999, paddingVertical: 2, paddingHorizontal: 9, backgroundColor: colors.bg3, borderWidth: 1,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  result: { marginTop: 8, gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.bg3,
    borderWidth: 1, borderColor: colors.line, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 7,
  },
  disclose: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10, alignSelf: 'flex-start' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' },
  menuToggle: { width: 36, height: 32, marginLeft: -6, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  transcript: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 4, marginTop: 4 },
  reply: { marginTop: 6, maxHeight: 320, backgroundColor: colors.bg, borderRadius: 8, borderWidth: 1, borderColor: colors.line, padding: 10 },
  audio: { gap: 10, marginBottom: 12 },
})

