// Productivity → Journal, ported from web/src/components/JournalView.tsx.
//
// A red button, and the entries under it, grouped by day. Each entry is
// transcribed on the bridge, and after the grace period the digest folds it into
// the brain; the card carries the countdown and "Don't ingest".
//
// The phone app records where the web on iPhone often can't: expo-audio in the
// RecorderPanel, uploaded as the same request. Settings and the transcript editor
// are sheets (src/app/journal/*). Polling only runs while this page is on screen.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, FlatList, RefreshControl, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Empty, IconBtn } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { success } from '../../ui/haptics'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { ArrowPathIcon, ClockIcon, Cog6ToothIcon, ExclamationTriangleIcon, Hi, MicrophoneIcon } from '../../lib/icons'
import {
  AuthError, createJournalText, deleteJournalAudio, deleteJournalEntry, getJournal, ingestJournalNow,
  keepJournalAudio, retryJournalTranscription, skipJournalIngest, updateJournalEntry,
} from '../../lib/api'
import { clearSecretStored } from '../../lib/connection'
import { pushError, pushSuccess } from '../../lib/toast'
import { cardState, groupByDay, pollIntervalMs } from '../../lib/journal/format'
import type { DayGroup } from '../../lib/journal/format'
import type { JournalEngine, JournalEntry, JournalSettings } from '../../lib/journal/types'
import RecorderPanel from '../journal/RecorderPanel'
import EntryCard from '../journal/EntryCard'
import { uploadJournalRecording } from '../journal/upload'
import type { RecorderResult } from '../journal/useRecorder'
import { cacheSettings, onEntryChanged, onSettingsChanged } from '../journal/store'

/** A clock that ticks once a second only while something on screen needs it. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export default function JournalView({ active }: { active: boolean }) {
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [engine, setEngine] = useState<JournalEngine | null>(null)
  const [settings, setSettings] = useState<JournalSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const fail = useCallback((e: unknown, fallback: string) => {
    if (e instanceof AuthError) { void clearSecretStored(); return }
    pushError(e instanceof Error ? e.message : fallback)
  }, [])

  // Bumped after every load, so the poll below re-arms even when a load fails or
  // changes nothing.
  const [loads, setLoads] = useState(0)

  const load = useCallback(async () => {
    try {
      const data = await getJournal()
      setEntries(data.entries)
      setEngine(data.engine)
      setSettings(data.settings)
      cacheSettings(data.settings)
    } catch (e) {
      fail(e, 'The journal could not load.')
    } finally {
      setLoading(false)
      setRefreshing(false)
      setLoads((n) => n + 1)
    }
  }, [fail])

  useEffect(() => { void load() }, [load])

  // Poll while an entry is transcribing, counting down, or being digested; the
  // cadence comes from the same state function the cards render from. Only while
  // this page is the one on screen.
  //
  // The web also keys the timer on `now`, which clears a 4 s or 20 s timer every
  // second while the clock ticks, so a card sat on "Transcribing…" until something
  // else reloaded the list.
  const transient = entries.some((e) => ['transcribing', 'waiting', 'due', 'digesting'].includes(cardState(e, Date.now())))
  const now = useNow(active && transient)
  // Re-armed after each load, and when the cadence changes (a new recording starts
  // transcribing, a countdown runs out), never by the ticking clock.
  const pollMs = pollIntervalMs(entries, now)
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => { void load() }, pollMs)
    return () => clearTimeout(t)
  }, [active, loads, pollMs, load])
  // Switched back to, or the app foregrounded: catch up at once (the web's visibilitychange).
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) void load()
    wasActive.current = active
  }, [active, load])
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active' && active) void load() })
    return () => sub.remove()
  }, [active, load])

  // The sheets report back.
  useEffect(() => onEntryChanged((next) => setEntries((list) => list.map((e) => (e.id === next.id ? next : e)))), [])
  useEffect(() => onSettingsChanged(setSettings), [])

  const patchEntry = (next: JournalEntry) => setEntries((list) => list.map((e) => (e.id === next.id ? next : e)))

  const act = useCallback(async (entry: JournalEntry, run: () => Promise<{ entry?: JournalEntry } | unknown>, done?: string) => {
    setBusyId(entry.id)
    try {
      const res = (await run()) as { entry?: JournalEntry } | undefined
      if (res?.entry) patchEntry(res.entry)
      else await load()
      if (done) pushSuccess(done)
    } catch (e) {
      fail(e, 'That did not work.')
    } finally {
      setBusyId(null)
    }
  }, [fail, load])

  const delay = settings?.ingestDelayMinutes ?? 10

  const save = useCallback(async (r: RecorderResult) => {
    try {
      const { entry } = await uploadJournalRecording(r.uri, { recordedAt: r.startedAt, durationSec: r.durationSec, mime: r.mimeType })
      setEntries((list) => [entry, ...list])
      success()
      pushSuccess(`Saved — transcribing. Digest in ${delay} min unless you say otherwise.`)
      return true
    } catch (e) {
      fail(e, 'The recording could not be saved. It is still here — try again.')
      return false
    }
  }, [delay, fail])

  const saveText = useCallback(async (text: string) => {
    try {
      const { entry } = await createJournalText(text)
      setEntries((list) => [entry, ...list])
      success()
      pushSuccess(`Saved. Digest in ${delay} min unless you say otherwise.`)
      return true
    } catch (e) {
      fail(e, 'The entry could not be saved.')
      return false
    }
  }, [delay, fail])

  const groups = useMemo(() => groupByDay(entries), [entries])
  const waiting = entries.filter((e) => cardState(e, now) === 'waiting').length

  const header = (
    <View style={{ gap: 14, marginBottom: 14 }}>
      {/* .view-head, built here rather than with ViewHead so the engine pill is
          the thing that gives way at 390pt ("transcription not installed" is long),
          not the title. */}
      <View style={st.head}>
        <T size={22} weight={700} numberOfLines={1}>
          Journal
          {entries.length ? <T size={22} weight={600} color={colors.muted}>{` · ${entries.length}`}</T> : null}
        </T>
        <View style={st.headRight}>
          {engine ? <EnginePill engine={engine} /> : null}
          <IconBtn icon={ArrowPathIcon} size={15} box={32} bordered label="Refresh" onPress={() => { setRefreshing(true); void load() }} />
          <IconBtn icon={Cog6ToothIcon} size={15} box={32} bordered label="Journal settings" onPress={() => router.push('/journal/settings')} />
        </View>
      </View>
      <RecorderPanel engineReady={engine ? engine.ready : true} delayMinutes={delay} onSave={save} onSaveText={saveText} />
      {waiting > 0 && (
        <View style={st.lede}>
          <Hi icon={ClockIcon} size={13} color={colors.muted} style={{ marginTop: 2 }} />
          <T size={12.5} muted lineHeight={18} style={{ flex: 1 }}>
            {waiting === 1 ? 'One entry is' : `${waiting} entries are`} waiting to be digested. Tap <T size={12.5} weight={600}>Don’t ingest</T> on a card to keep it out of the brain.
          </T>
        </View>
      )}
    </View>
  )

  const renderDay = ({ item: g }: { item: DayGroup }) => (
    <View style={st.day}>
      <T size={12} weight={700}>{g.label} <T size={12} muted>· {g.date}</T></T>
      <View style={{ gap: 10 }}>
        {g.entries.map((e) => (
          <EntryCard
            key={e.id} entry={e} now={now} busy={busyId !== null}
            onSkip={() => act(e, () => skipJournalIngest(e.id), 'Kept out of the brain.')}
            onIngest={() => act(e, () => ingestJournalNow(e.id))}
            onRetry={() => act(e, () => retryJournalTranscription(e.id))}
            onRename={(title) => act(e, () => updateJournalEntry(e.id, { title }))}
            onKeepAudio={(keep) => act(e, () => keepJournalAudio(e.id, keep), keep ? 'Recording kept indefinitely.' : 'Recording back on the clock.')}
            onDeleteAudio={async () => {
              const ok = await confirm('Delete the recording?', { message: 'The transcript stays — only the audio goes, and it cannot be recovered.' })
              if (ok) void act(e, () => deleteJournalAudio(e.id), 'Recording deleted. The transcript is untouched.')
            }}
            onDelete={async () => {
              const ok = await confirm('Delete this entry?', { message: 'The transcript goes with it; anything already digested into the brain stays.' })
              if (ok) void act(e, async () => { await deleteJournalEntry(e.id); setEntries((l) => l.filter((x) => x.id !== e.id)); return { entry: undefined } })
            }}
          />
        ))}
      </View>
    </View>
  )

  return (
    <FlatList
      data={loading ? [] : groups}
      keyExtractor={(g) => g.date}
      renderItem={renderDay}
      ListHeaderComponent={header}
      ListEmptyComponent={loading ? (
        <T muted align="center" style={{ paddingVertical: 30 }}>Loading…</T>
      ) : (
        <Empty icon={MicrophoneIcon} style={{ paddingVertical: 30 }}>
          <T muted align="center" style={{ maxWidth: 300 }}>No entries yet. Hit the red button and talk about your day — yesterday counts.</T>
        </Empty>
      )}
      contentContainerStyle={{ padding: 16, paddingBottom: FAB_CLEARANCE }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      initialNumToRender={4}
      windowSize={7}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load() }} tintColor={colors.muted} />}
    />
  )
}

function EnginePill({ engine }: { engine: JournalEngine }) {
  if (engine.ready) {
    return (
      <View style={[st.pill, { borderColor: alpha('#4ec9a0', 0.27) }]} accessibilityLabel={`whisper.cpp ${engine.model}, ${engine.threads} threads, on the bridge`}>
        <T size={11} color="#4ec9a0" lineHeight={16} numberOfLines={1}>whisper {engine.model}</T>
      </View>
    )
  }
  return (
    <View style={[st.pill, { borderColor: alpha(colors.red, 0.27), flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
      <Hi icon={ExclamationTriangleIcon} size={12} color={colors.red} />
      <T size={11} color={colors.red} lineHeight={16} numberOfLines={1}>transcription not installed</T>
    </View>
  )
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headRight: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  lede: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: -4 },
  day: { gap: 8, marginBottom: 14 },
  pill: { backgroundColor: colors.bg3, borderWidth: 1, borderRadius: 999, paddingVertical: 1, paddingHorizontal: 8, flexShrink: 1 },
})
