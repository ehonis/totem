// Productivity → Recs (web/src/components/RecsView.tsx). The same sections in the
// same order, everything open always loaded and decided history a page at a time,
// laid out for a phone: the track record as three numbers, what waits on the owner
// as full cards with the decision buttons under the thumb, and everything already
// decided as compact rows that open in place.
//
// Only the owner decides: every decision here is his tap, sent as the dashboard
// (`recs/http.mjs`). Accept is one tap ("Accept with a note…" is in the card's
// menu); Decline always asks why, since agents read the note before suggesting
// something like it again, and Cancel there decides nothing; Defer picks its
// length from a native menu. Each decision buzzes, the card moves to its new
// section, and the toast offers Undo, which is the existing "Decide again".
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from 'react-native-reanimated'
import { MenuView } from '@react-native-menu/menu'
import { alpha, colors } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press, Spinner } from '../../ui/kit'
import { confirm, showMenu } from '../../ui/menu'
import { success, tap } from '../../ui/haptics'
import {
  ArrowUturnLeftIcon, ChatBubbleLeftIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, EllipsisHorizontalIcon, Hi,
} from '../../lib/icons'
import { AuthError, decideRec, getRecLedger, setRecOutcome } from '../../lib/api'
import { clearSecretStored } from '../../lib/connection'
import { pushToast } from '../../lib/toast'
import { DEFER_CHOICES, OUTCOME_LABELS, mergeLedger, outcomeLabel, recSections, recSourceLabel, recSourceThread } from '../../lib/recs/sections'
import type { Rec, RecOutcome, RecStats } from '../../lib/recs/types'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { openChat } from '../../shell/nav'
import { ErrorLine } from '../lists/bits'
import { decisionToast, recMeta, statTiles, whenLabel } from '../recs/card'
import { createRevisions, saveThenRefresh } from '../recs/sync'
import IconBulb from '@tabler/icons-react-native/dist/esm/icons/IconBulb.mjs'

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

const TONE: Record<string, string> = {
  accepted: colors.green, worked: colors.green, partly: colors.amber, deferred: colors.amber, failed: colors.red, declined: colors.red,
}

type Run = (id: string, change: () => Promise<{ rec: Rec }>, after?: (rec: Rec) => void) => Promise<void>

export default function RecsView({ active }: { active: boolean }) {
  const [open, setOpen] = useState<Rec[]>([])
  const [history, setHistory] = useState<Rec[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [stats, setStats] = useState<RecStats | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [pulling, setPulling] = useState(false)
  // What is saving, counted per rec id (and 'more' for an older page): an Undo
  // tapped while its decision is still refetching keeps the card saving.
  const [busy, setBusy] = useState<ReadonlyMap<string, number>>(() => new Map())
  const startBusy = useCallback((id: string) => setBusy((m) => new Map(m).set(id, (m.get(id) ?? 0) + 1)), [])
  const endBusy = useCallback((id: string) => setBusy((m) => {
    const n = new Map(m)
    const left = (m.get(id) ?? 1) - 1
    if (left > 0) n.set(id, left); else n.delete(id)
    return n
  }), [])
  const [error, setError] = useState('')
  const wasActive = useRef(false)
  // Moved on by every change that lands, so no read that went out before it is
  // drawn over it (recs/sync.ts).
  const revisions = useRef(createRevisions()).current
  const ledger = useRef({ history, nextBefore })
  ledger.current = { history, nextBefore }

  const fail = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof AuthError) void clearSecretStored()
    else setError(cause instanceof Error ? cause.message : fallback)
  }, [])

  const load = useCallback(async () => {
    const at = revisions.current()
    setError('')
    try {
      const page = await getRecLedger()
      if (at !== revisions.current()) return
      setOpen(page.open); setHistory(page.history); setNextBefore(page.nextBefore); setStats(page.stats)
    } catch (cause) { fail(cause, 'Recommendations could not load.') }
    finally { setLoaded(true) }
  }, [fail, revisions])

  const more = async () => {
    if (!nextBefore) return
    const at = revisions.current()
    startBusy('more'); setError('')
    try {
      const page = await getRecLedger(nextBefore)
      // A change since redrew the first page; this older page is fetched again on the next tap.
      if (at !== revisions.current()) return
      setHistory((current) => [...current, ...page.history]); setNextBefore(page.nextBefore); setStats(page.stats)
    } catch (cause) { fail(cause, 'Older recommendations could not load.') }
    finally { endBusy('more') }
  }

  useEffect(() => {
    if (active && !wasActive.current) void load()
    wasActive.current = active
  }, [active, load])

  // A change moves the rec at once, then refetches the first page (keeping the
  // older pages already loaded); the refetch is drawn only if no other change
  // landed meanwhile. A failed refetch is not a failed change.
  const run: Run = useCallback(async (id, change, after) => {
    startBusy(id); setError('')
    try {
      const out = await saveThenRefresh(revisions, {
        change,
        saved: ({ rec }) => {
          success()
          const open = rec.decision === 'pending' || rec.decision === 'deferred'
          const others = (list: Rec[]) => list.filter((r) => r.id !== rec.id)
          setOpen((list) => (open ? [...others(list), rec] : others(list)))
          setHistory((list) => (open ? others(list) : [rec, ...others(list)]))
          after?.(rec)
        },
        refetch: () => getRecLedger(),
        fresh: (first, { rec }) => {
          const next = mergeLedger(ledger.current, first, rec)
          setOpen(next.open); setHistory(next.history); setNextBefore(next.nextBefore); setStats(first.stats)
        },
      })
      if (out.refreshError) fail(out.refreshError, 'Saved, but the list could not refresh. Pull down to try again.')
    } catch (cause) { fail(cause, 'That change could not be saved.') }
    finally { endBusy(id) }
  }, [fail, revisions, startBusy, endBusy])

  /** Decide, then say what happens next, with Undo (back to waiting) where it makes sense. */
  const decide = useCallback((rec: Rec, decision: Rec['decision'], extra: { note?: string; deferDays?: number } = {}) => {
    void run(rec.id, () => decideRec(rec.id, { decision, ...extra }), (saved) => {
      if (decision === 'pending') { pushToast(decisionToast(saved), 'success'); return }
      pushToast(decisionToast(saved), 'success', {
        duration: 5000,
        action: { label: 'Undo', onClick: () => { void run(rec.id, () => decideRec(rec.id, { decision: 'pending' })) } },
      })
    })
  }, [run])

  const sections = useMemo(() => recSections([...open, ...history]), [open, history])

  if (!loaded) return <Spinner label="Loading recommendations…" />

  return (
    <LayoutAnimationConfig skipEntering>
    <ScrollView
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: FAB_CLEARANCE }}
      refreshControl={<RefreshControl refreshing={pulling} tintColor={colors.muted} onRefresh={async () => { setPulling(true); await load(); setPulling(false) }} />}
    >
      {stats && stats.total > 0 ? <TrackRecord stats={stats} /> : null}
      {error ? <ErrorLine text={error} onRetry={() => void load()} style={{ marginBottom: 12 }} /> : null}
      {!sections.length && !error ? (
        <View style={st.empty}>
          <IconBulb size={34} strokeWidth={1.5} color={colors.amber} />
          <T size={16} weight={600}>Nothing to decide</T>
          <T size={14} muted align="center" lineHeight={20} style={{ maxWidth: 290 }}>
            When an agent suggests something worth deciding, it lands here with its evidence, and you choose.
          </T>
        </View>
      ) : null}
      {sections.map((section) => (
        <Animated.View key={section.id} layout={LinearTransition.duration(220)} style={st.section}>
          <View style={st.sectionHead} accessibilityRole="header">
            <T size={15} weight={600}>{section.title}</T>
            <T size={14} muted style={{ fontVariant: ['tabular-nums'] }}>{section.recs.length}</T>
          </View>
          {section.recs.map((rec) => (
            <Animated.View key={rec.id} layout={LinearTransition.duration(220)} entering={FadeIn.duration(200)} exiting={FadeOut.duration(140)}>
              {rec.decision === 'pending'
                ? <PendingCard rec={rec} busy={busy.has(rec.id)} decide={decide} />
                : <DecidedRow rec={rec} busy={busy.has(rec.id)} run={run} decide={decide} />}
            </Animated.View>
          ))}
        </Animated.View>
      ))}
      {nextBefore ? (
        <View style={st.more}>
          <Btn title="Show older decisions" loading={busy.has('more')} onPress={() => void more()} />
        </View>
      ) : null}
    </ScrollView>
    </LayoutAnimationConfig>
  )
}

function TrackRecord({ stats }: { stats: RecStats }) {
  const tiles = statTiles(stats)
  return (
    <View style={st.record} accessible accessibilityLabel={`Track record: ${stats.line}`}>
      <View style={st.tiles}>
        {tiles.map((tile, i) => (
          <View key={tile.label} style={[st.tile, i > 0 && st.tileRule]}>
            <T size={22} weight={700} style={{ fontVariant: ['tabular-nums'] }} color={tile.label === 'Waiting' && stats.pending ? colors.amber : colors.text}>{tile.value}</T>
            <T size={13} muted>{tile.label}</T>
          </View>
        ))}
      </View>
      {stats.line ? <T size={12.5} muted lineHeight={18}>{stats.line}</T> : null}
    </View>
  )
}

function Source({ rec }: { rec: Rec }) {
  const thread = recSourceThread(rec.source)
  const label = recSourceLabel(rec.source)
  if (!thread) return <T size={13} muted>{label}</T>
  return (
    <Press onPress={() => openChat(thread)} hitSlop={8} style={st.source} accessibilityRole="link" accessibilityLabel={`From ${label}, open the chat`}>
      <Hi icon={ChatBubbleLeftIcon} size={13} color={colors.accent} />
      <T size={13} color={colors.accent}>{label}</T>
    </Press>
  )
}

function Evidence({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <View style={{ marginTop: 4 }}>
      <Press onPress={() => { tap(); setOpen((v) => !v) }} style={st.disclose} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Hi icon={ChevronRightIcon} size={13} color={colors.muted} /></View>
        <T size={14} muted>Evidence</T>
      </Press>
      {open ? <Animated.View entering={FadeIn.duration(160)}><T size={14} lineHeight={21} style={st.evidence} selectable>{text}</T></Animated.View> : null}
    </View>
  )
}

function PendingCard({ rec, busy, decide }: { rec: Rec; busy: boolean; decide: (rec: Rec, d: Rec['decision'], extra?: { note?: string; deferDays?: number }) => void }) {
  const meta = recMeta(rec)
  const thread = recSourceThread(rec.source)
  const decline = async () => {
    const note = await askNote('Why not?', 'Optional. Agents read this before suggesting it again.', 'Decline')
    if (note !== null) decide(rec, 'declined', note ? { note } : {})
  }
  const acceptWithNote = async () => {
    const note = await askNote('Accept', 'Add a note (optional).', 'Accept')
    if (note !== null) decide(rec, 'accepted', note ? { note } : {})
  }
  return (
    <View style={st.card}>
      <View style={st.titleRow}>
        <T size={17} weight={600} lineHeight={23} style={{ flex: 1 }}>{rec.title}</T>
        {busy ? <ActivityIndicator size="small" color={colors.muted} style={{ marginTop: 2 }} accessibilityLabel="Saving" /> : null}
      </View>
      <View style={st.meta}>
        <Source rec={rec} />
        {meta ? <T size={13} muted style={{ fontVariant: ['tabular-nums'] }}>{meta}</T> : null}
      </View>
      {rec.body ? <T size={15} lineHeight={22} style={{ marginTop: 10 }}>{rec.body}</T> : null}
      {rec.decisionNote ? <T size={14} muted lineHeight={20} style={{ marginTop: 8 }}>Your note: “{rec.decisionNote}”</T> : null}
      {rec.changedNote ? (
        <View style={st.changed}>
          <T size={13} weight={600} color={colors.amber}>What changed since you declined something like it</T>
          <T size={14} lineHeight={20}>{rec.changedNote}</T>
        </View>
      ) : null}
      {rec.evidence ? <Evidence text={rec.evidence} /> : null}

      <View style={st.decide}>
        <Btn kind="primary" icon={CheckIcon} title="Accept" disabled={busy} onPress={() => decide(rec, 'accepted')} style={{ flex: 1.2, minHeight: 44, paddingHorizontal: 8 }} />
        <Btn title="Decline" disabled={busy} onPress={() => void decline()} style={{ flex: 1, minHeight: 44, paddingHorizontal: 8 }} />
        <MenuView
          title="Ask again"
          themeVariant="dark"
          actions={DEFER_CHOICES.map((choice) => ({ id: String(choice.days), title: choice.label }))}
          onPressAction={({ nativeEvent }) => { if (!busy) decide(rec, 'deferred', { deferDays: Number(nativeEvent.event) }) }}
          style={{ flex: 1 }}
        >
          <View style={[st.menuBtn, busy && { opacity: 0.45 }]} accessibilityRole="button" accessibilityLabel="Defer">
            <T size={14} weight={500}>Defer</T>
            <Hi icon={ChevronDownIcon} size={12} color={colors.muted} />
          </View>
        </MenuView>
        <MenuView
          themeVariant="dark"
          actions={[
            { id: 'note', title: 'Accept with a note…', image: 'text.bubble' },
            ...(thread ? [{ id: 'chat', title: 'Open the chat it came from', image: 'bubble.left' }] : []),
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === 'note' && !busy) void acceptWithNote()
            else if (nativeEvent.event === 'chat' && thread) openChat(thread)
          }}
        >
          <View style={[st.moreBtn, busy && { opacity: 0.45 }]} accessibilityRole="button" accessibilityLabel="More for this recommendation">
            <Hi icon={EllipsisHorizontalIcon} size={18} color={colors.text} />
          </View>
        </MenuView>
      </View>
    </View>
  )
}

/** A decided, deferred or measured rec: one line until tapped, then everything and its actions. */
function DecidedRow({ rec, busy, run, decide }: {
  rec: Rec
  busy: boolean
  run: Run
  decide: (rec: Rec, d: Rec['decision'], extra?: { note?: string; deferDays?: number }) => void
}) {
  const [open, setOpen] = useState(false)
  const badge = rec.outcome ?? rec.decision
  const tone = TONE[badge] ?? colors.muted
  const word = rec.outcome ? OUTCOME_LABELS[rec.outcome] : rec.decision === 'deferred' ? 'Deferred' : rec.decision === 'accepted' ? 'Accepted' : 'Declined'
  const when = rec.decision === 'deferred' && rec.reviewOn ? `back ${rec.reviewOn}` : whenLabel(rec.outcomeAt ?? rec.decidedAt)
  const needsOutcome = rec.decision === 'accepted' && (!rec.outcome || rec.outcomeBy === 'agent')
  const meta = recMeta(rec)

  return (
    <View style={[st.row, open && st.rowOpen]}>
      <Press
        onPress={() => { tap(); setOpen((v) => !v) }}
        style={st.rowHead}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${rec.title}. ${word}${when ? `, ${when}` : ''}`}
      >
        <View style={[st.pill, { borderColor: alpha(tone, 0.45), backgroundColor: alpha(tone, 0.1) }]}>
          <T size={12} weight={600} color={tone}>{word}</T>
        </View>
        <T size={15} numberOfLines={open ? undefined : 1} style={{ flex: 1 }} color={rec.decision === 'declined' ? colors.muted : colors.text}>{rec.title}</T>
        {busy ? <ActivityIndicator size="small" color={colors.muted} accessibilityLabel="Saving" /> : when ? <T size={12} muted>{when}</T> : null}
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Hi icon={ChevronDownIcon} size={14} color={colors.muted} /></View>
      </Press>

      {needsOutcome ? (
        <View style={st.outcomes}>
          <T size={13} muted>{rec.outcome ? `${outcomeLabel(rec)}. Is that right?` : 'How did it go?'}</T>
          <View style={st.outcomeBtns}>
            {(Object.keys(OUTCOME_LABELS) as RecOutcome[]).map((outcome) => (
              <Btn
                key={outcome}
                compact
                title={OUTCOME_LABELS[outcome]}
                disabled={busy}
                onPress={() => void run(rec.id, () => setRecOutcome(rec.id, { outcome }), () => pushToast('Outcome saved.', 'success'))}
                style={{ flex: 1, minHeight: 44 }}
              />
            ))}
          </View>
        </View>
      ) : null}

      {open ? (
        <Animated.View entering={FadeIn.duration(160)} style={st.rowBody}>
          <View style={st.meta}>
            <Source rec={rec} />
            {meta ? <T size={13} muted>{meta}</T> : null}
          </View>
          {rec.body ? <T size={14} lineHeight={21}>{rec.body}</T> : null}
          {rec.changedNote ? <T size={13} muted lineHeight={19}>What changed since you declined something like it: {rec.changedNote}</T> : null}
          {rec.evidence ? <Evidence text={rec.evidence} /> : null}
          {rec.decisionNote ? <T size={14} muted lineHeight={20}>“{rec.decisionNote}”</T> : null}
          {rec.outcome && rec.outcomeBy === 'owner' ? <T size={13} muted>Outcome: {outcomeLabel(rec)}</T> : null}
          {rec.outcomeNote ? <T size={14} muted lineHeight={20}>{rec.outcomeNote}</T> : null}
          <View style={st.rowActions}>
            {rec.decision === 'accepted' && rec.outcome && rec.outcomeBy === 'owner' ? (
              <Btn title="Change outcome" disabled={busy} style={{ minHeight: 44 }} onPress={() => showMenu(
                (Object.keys(OUTCOME_LABELS) as RecOutcome[]).map((outcome) => ({
                  label: OUTCOME_LABELS[outcome],
                  onPress: () => void run(rec.id, () => setRecOutcome(rec.id, { outcome }), () => pushToast('Outcome saved.', 'success')),
                })),
                { title: 'How did it go?' },
              )} />
            ) : null}
            <Btn icon={ArrowUturnLeftIcon} title="Decide again" disabled={busy} onPress={() => decide(rec, 'pending')} style={{ minHeight: 44 }} />
          </View>
        </Animated.View>
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  record: { gap: 10, marginBottom: 18 },
  tiles: { flexDirection: 'row', backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 12, paddingVertical: 12 },
  tile: { flex: 1, alignItems: 'center', gap: 2 },
  tileRule: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  section: { marginBottom: 22 },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  card: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, backgroundColor: colors.bg2, padding: 16, marginBottom: 12 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4, marginTop: 4 },
  source: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  changed: { marginTop: 10, gap: 4, padding: 10, borderRadius: 10, backgroundColor: alpha(colors.amber, 0.08), borderWidth: 1, borderColor: alpha(colors.amber, 0.25) },
  disclose: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingRight: 12, alignSelf: 'flex-start' },
  evidence: { marginTop: 4, padding: 10, borderRadius: 10, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line },
  decide: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  menuBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 44,
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, borderRadius: 9,
  },
  moreBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line },
  row: { borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.bg2, marginBottom: 8, overflow: 'hidden' },
  rowOpen: { borderColor: '#323848' },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 12, paddingVertical: 10 },
  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  outcomes: { gap: 8, paddingHorizontal: 12, paddingBottom: 12 },
  outcomeBtns: { flexDirection: 'row', gap: 8 },
  rowBody: { gap: 10, paddingHorizontal: 12, paddingBottom: 12, paddingTop: 2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  more: { alignItems: 'center', marginTop: 4 },
  empty: { alignItems: 'center', gap: 8, paddingTop: 56, paddingHorizontal: 24 },
})
