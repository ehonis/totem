// Productivity → Recs (web/src/components/RecsView.tsx). The same sections, track
// record line and decisions, with everything open always loaded and decided history
// a page at a time. What the phone does natively: Defer picks its length from an
// action sheet instead of a select, and Accept and Decline ask for their optional
// note in the system prompt rather than an inline field. Cancel there decides nothing.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press, Spinner, Empty } from '../../ui/kit'
import { confirm, showMenu } from '../../ui/menu'
import { success } from '../../ui/haptics'
import { ArrowUturnLeftIcon, CheckIcon, ClockIcon, XMarkIcon } from '../../lib/icons'
import { AuthError, decideRec, getRecLedger, setRecOutcome } from '../../lib/api'
import { clearSecretStored } from '../../lib/connection'
import { DEFER_CHOICES, OUTCOME_LABELS, formatUsd, mergeLedger, outcomeLabel, recSections, recSourceLabel, recSourceThread } from '../../lib/recs/sections'
import type { Rec, RecOutcome, RecStats } from '../../lib/recs/types'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { openChat } from '../../shell/nav'

/**
 * An optional note before deciding. Resolves the note ('' when left empty) on OK, and
 * null on Cancel, which must decide nothing: a decline blocks similar suggestions for
 * 30 days. (ui/menu's prompt folds an empty Save into Cancel, so it can't be used here.)
 */
function askNote(title: string, message: string, okLabel: string): Promise<string | null> {
  if (Platform.OS !== 'ios') {
    return confirm(title, { message, confirmLabel: okLabel, destructive: false }).then((ok) => (ok ? '' : null))
  }
  return new Promise((resolve) => {
    Alert.prompt(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      { text: okLabel, onPress: (v?: string) => resolve((v ?? '').trim()) },
    ], 'plain-text', '', undefined, { userInterfaceStyle: 'dark' } as any)
  })
}

const BADGE: Record<string, string> = {
  accepted: colors.green, worked: colors.green, partly: colors.amber, deferred: colors.amber, failed: colors.red, declined: colors.red,
}

export default function RecsView({ active }: { active: boolean }) {
  const [open, setOpen] = useState<Rec[]>([])
  const [history, setHistory] = useState<Rec[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [stats, setStats] = useState<RecStats | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const wasActive = useRef(false)

  const fail = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof AuthError) void clearSecretStored()
    else setError(cause instanceof Error ? cause.message : fallback)
  }, [])

  const load = useCallback(async () => {
    setError('')
    try {
      const ledger = await getRecLedger()
      setOpen(ledger.open); setHistory(ledger.history); setNextBefore(ledger.nextBefore); setStats(ledger.stats)
    } catch (cause) { fail(cause, 'Recommendations could not load.') }
    finally { setLoaded(true) }
  }, [fail])

  const more = async () => {
    if (!nextBefore) return
    setBusy('more'); setError('')
    try {
      const ledger = await getRecLedger(nextBefore)
      setHistory((current) => [...current, ...ledger.history]); setNextBefore(ledger.nextBefore); setStats(ledger.stats)
    } catch (cause) { fail(cause, 'Older recommendations could not load.') }
    finally { setBusy('') }
  }

  useEffect(() => {
    if (active && !wasActive.current) void load()
    wasActive.current = active
  }, [active, load])

  // A change refetches the first page and keeps the older pages already loaded.
  const run = useCallback(async (id: string, change: () => Promise<{ rec: Rec }>) => {
    setBusy(id); setError('')
    try {
      const { rec } = await change()
      success()
      const first = await getRecLedger()
      const next = mergeLedger({ history, nextBefore }, first, rec)
      setOpen(next.open); setHistory(next.history); setNextBefore(next.nextBefore); setStats(first.stats)
    }
    catch (cause) { fail(cause, 'That change could not be saved.') }
    finally { setBusy('') }
  }, [fail, history, nextBefore])

  const sections = useMemo(() => recSections([...open, ...history]), [open, history])

  if (!loaded) return <Spinner />

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: FAB_CLEARANCE }}
      refreshControl={<RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={async () => { setPulling(true); await load(); setPulling(false) }} />}
    >
      <View style={st.head}>
        <T size={21} weight={700}>Recommendations</T>
        {stats ? <T size={13} muted style={{ fontVariant: ['tabular-nums'] }}>{stats.line}</T> : null}
      </View>
      {error ? (
        <View style={st.error} accessibilityRole="alert">
          <T size={13} color={colors.red} style={{ flex: 1 }}>{error}</T>
          <Press onPress={() => void load()}><T size={13} muted style={{ textDecorationLine: 'underline' }}>Retry</T></Press>
        </View>
      ) : null}
      {!sections.length ? (
        <Empty icon={CheckIcon} title="Nothing recommended yet">
          <T size={13} muted align="center">When an agent suggests something worth deciding, it lands here with its evidence.</T>
        </Empty>
      ) : null}
      {sections.map((section) => (
        <View key={section.id} style={st.section}>
          <View style={st.sectionHead}>
            <T size={11.5} weight={700}>{section.title}</T>
            <T size={11} muted>{section.recs.length}</T>
          </View>
          {section.recs.map((rec) => <RecCard key={rec.id} rec={rec} busy={busy === rec.id} run={run} />)}
        </View>
      ))}
      {nextBefore ? (
        <View style={st.more}>
          <Btn compact title="Show older decisions" disabled={busy === 'more'} onPress={() => void more()} />
        </View>
      ) : null}
    </ScrollView>
  )
}

function RecCard({ rec, busy, run }: { rec: Rec; busy: boolean; run: (id: string, change: () => Promise<{ rec: Rec }>) => Promise<void> }) {
  const [evidence, setEvidence] = useState(false)
  const thread = recSourceThread(rec.source)
  const decide = (decision: Rec['decision'], extra: { note?: string; deferDays?: number } = {}) =>
    void run(rec.id, () => decideRec(rec.id, { decision, ...extra }))
  const accept = async () => {
    const note = await askNote('Accept', 'Add a note (optional).', 'Accept')
    if (note !== null) decide('accepted', note ? { note } : {})
  }
  const decline = async () => {
    const note = await askNote('Why not?', 'Optional. Agents read this before suggesting it again.', 'Decline')
    if (note !== null) decide('declined', note ? { note } : {})
  }
  const defer = () => showMenu(
    DEFER_CHOICES.map((choice) => ({ label: choice.label, onPress: () => decide('deferred', { deferDays: choice.days }) })),
    { title: 'Ask again' },
  )
  const badge = rec.outcome ?? rec.decision
  const meta = [
    rec.costUsd ? formatUsd(rec.costUsd) : null,
    rec.actBy ? `act by ${rec.actBy}` : null,
    rec.decision === 'deferred' && rec.reviewOn ? `back ${rec.reviewOn}` : null,
    rec.decision === 'pending' && rec.resurfacedAt ? 'back from deferral' : null,
  ].filter(Boolean).join(' · ')

  return (
    <View style={[st.card, rec.decision === 'declined' && { opacity: 0.72 }]}>
      <View style={st.top}>
        <T size={15} weight={600} style={{ flex: 1 }}>{rec.title}</T>
        {rec.decision !== 'pending' ? (
          <View style={[st.badge, { borderColor: BADGE[badge] ?? colors.line }]}>
            <T size={11} color={BADGE[badge] ?? colors.muted}>{rec.outcome ? OUTCOME_LABELS[rec.outcome] : rec.decision}</T>
          </View>
        ) : null}
      </View>
      <View style={st.meta}>
        {thread
          ? <Press onPress={() => openChat(thread)}><T size={12} muted style={{ textDecorationLine: 'underline' }}>{recSourceLabel(rec.source)}</T></Press>
          : <T size={12} muted>{recSourceLabel(rec.source)}</T>}
        {meta ? <T size={12} muted>{meta}</T> : null}
      </View>
      {rec.body ? <T size={13} lineHeight={19} style={st.para}>{rec.body}</T> : null}
      {rec.changedNote ? <T size={13} muted style={st.para}>What changed since you declined something like it: {rec.changedNote}</T> : null}
      {rec.evidence ? (
        <Press onPress={() => setEvidence((v) => !v)} style={st.para}>
          <T size={12.5} muted>{evidence ? '▾ Evidence' : '▸ Evidence'}</T>
          {evidence ? <T size={13} lineHeight={19} style={{ marginTop: 4 }}>{rec.evidence}</T> : null}
        </Press>
      ) : null}
      {rec.decisionNote ? <T size={13} muted style={st.para}>“{rec.decisionNote}”</T> : null}
      {rec.outcome && rec.outcomeBy === 'agent' ? <T size={13} muted style={st.para}>{outcomeLabel(rec)}</T> : null}
      {rec.outcomeNote ? <T size={13} muted style={st.para}>{rec.outcomeNote}</T> : null}

      {rec.decision === 'pending' ? (
        <View style={st.actions}>
          <Btn compact kind="primary" icon={CheckIcon} title="Accept" disabled={busy} onPress={() => void accept()} />
          <Btn compact icon={XMarkIcon} title="Decline" disabled={busy} onPress={() => void decline()} />
          <Btn compact icon={ClockIcon} title="Defer" disabled={busy} onPress={defer} />
        </View>
      ) : null}
      {rec.decision === 'accepted' ? (
        <View style={st.actions}>
          <T size={12} muted>{rec.outcome ? 'Outcome' : 'How did it go?'}</T>
          {(Object.keys(OUTCOME_LABELS) as RecOutcome[]).map((outcome) => (
            <Btn key={outcome} compact kind={rec.outcome === outcome && rec.outcomeBy === 'owner' ? 'primary' : 'default'} title={OUTCOME_LABELS[outcome]} disabled={busy}
              onPress={() => void run(rec.id, () => setRecOutcome(rec.id, { outcome }))} />
          ))}
        </View>
      ) : null}
      {rec.decision !== 'pending' ? (
        <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
          <Btn compact icon={ArrowUturnLeftIcon} title="Decide again" disabled={busy} onPress={() => decide('pending')} />
        </View>
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  head: { paddingHorizontal: 14, paddingTop: 16, gap: 4 },
  error: { flexDirection: 'row', gap: 12, margin: 14, marginBottom: 0, padding: 10, borderWidth: 1, borderColor: '#5a2a37', borderRadius: 8 },
  section: { paddingHorizontal: 14, marginTop: 20 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  card: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: colors.bg2, padding: 12, marginBottom: 8 },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 3 },
  para: { marginTop: 8 },
  more: { alignItems: 'center', marginTop: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 10 },
})
