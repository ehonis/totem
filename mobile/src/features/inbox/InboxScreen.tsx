// Inbox: proposals waiting on a yes/no (web InboxView.tsx, styles.css .inbox-*).
// On a phone a card also swipes: right to accept, left to deny, each confirmed
// first, because a swipe is easier to do by accident than a tap on a button.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { AuthError, getInbox, resolveInboxItem } from '../../lib/api'
import { notifyInboxChanged } from '../../lib/useInboxCount'
import { pushError } from '../../lib/toast'
import {
  Hi, ArrowPathIcon, CheckCircleIcon, XMarkIcon, InboxStackIcon, CalendarDaysIcon,
  DocumentTextIcon, CircleStackIcon, ChevronRightIcon, TrophyIcon, CommandLineIcon, WarnIcon,
} from '../../lib/icons'
import { ChatBubbleOvalLeftIcon } from 'react-native-heroicons/outline'
import Markdown from '../../ui/Markdown'
import { Screen, FAB_CLEARANCE } from '../../shell/Screen'
import { colors, fonts, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Empty, IconBtn, Press, ViewHead } from '../../ui/kit'
import { confirm } from '../../ui/menu'
import { success, tap, warn } from '../../ui/haptics'

// Per-kind glyph for the destination chip, so "where is this going" reads at a
// glance. Unknown kinds (future sources) fall back to the generic inbox icon.
// `agent` is a retired kind that now files a plain issue, same as `github`.
const KIND_ICON: Record<string, any> = {
  todo: DocumentTextIcon, calendar: CalendarDaysIcon, agent: CircleStackIcon, github: CircleStackIcon,
  goal: TrophyIcon, command: CommandLineIcon, prompt: CommandLineIcon, imessage: ChatBubbleOvalLeftIcon,
}

// Chips summarise the line; anything long or verbatim (the issue body, the gh
// command, the raw inbox line) belongs in the details drop-down instead.
// For a drafted message, `recipient` is the chip; `to` (a chat guid) and the text
// file path are noise.
const CHIP_SKIP = new Set(['when', 'src', 'prompt', 'prompt_ref', 'issue', 'source', 'goal', 'metric', 'to', 'message'])

function metaEntries(item: any): [string, string][] {
  const out: [string, string][] = []
  if (item.when) out.push(['when', item.when])
  if (item.src) out.push(['src', item.src])
  if (item.meta?.repo) out.push(['repo', item.meta.repo])
  if (item.meta?.type) out.push(['type', item.meta.type])
  for (const [k, v] of Object.entries(item.meta || {})) {
    if (CHIP_SKIP.has(k) || !v || out.some(([seen]) => seen === k)) continue
    out.push([k, String(v)])
  }
  return out
}

// Everything the bridge says accepting will actually do: the payload fields, the
// literal command, and the finished issue body rendered as it will appear.
function InboxDetails({ item }: { item: any }) {
  const p = item.preview || {}
  const isMessage = item.kind === 'imessage'
  const isIssue = Boolean(p.body) && !isMessage
  return (
    <View style={st.details}>
      {p.summary ? <T size={12} muted>{p.summary}</T> : null}
      {p.error ? (
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <WarnIcon size={13} />
          <T size={12} color={colors.red} style={{ flex: 1 }}>{p.error}</T>
        </View>
      ) : null}
      {p.fields?.length > 0 ? (
        <View style={{ gap: 4 }}>
          {p.fields.map(([k, v]: [string, string]) => (
            <View key={k} style={{ flexDirection: 'row', gap: 12 }}>
              <T size={12.5} muted style={{ minWidth: 64 }}>{k}</T>
              <T size={12.5} style={{ flex: 1 }} selectable>{v}</T>
            </View>
          ))}
        </View>
      ) : null}
      {p.command ? (
        <View>
          <T size={11.5} muted style={{ marginBottom: 5 }}>Runs on accept</T>
          <T size={11.5} lineHeight={17} style={st.command} selectable>{p.command}</T>
        </View>
      ) : null}
      {isMessage && p.body ? (
        <View>
          <T size={11.5} muted style={{ marginBottom: 5 }}>Message, exactly as it will be sent</T>
          <T size={11.5} lineHeight={17} style={st.command} selectable>{p.body}</T>
        </View>
      ) : null}
      {isIssue ? (
        <View>
          <T size={11.5} muted style={{ marginBottom: 5 }}>Issue body</T>
          <View style={st.issueBody}><Markdown text={p.body} size={13} /></View>
        </View>
      ) : null}
      {item.raw ? (
        <View>
          <T size={11.5} muted style={{ marginBottom: 5 }}>Inbox line</T>
          <T size={11.5} lineHeight={17} muted style={st.command} selectable>{item.raw}</T>
        </View>
      ) : null}
    </View>
  )
}

function SwipeAction({ kind }: { kind: 'accept' | 'deny' }) {
  const accept = kind === 'accept'
  const tint = accept ? colors.green : colors.red
  return (
    <View style={[st.swipe, { backgroundColor: alpha(tint, 0.16) }, accept ? { marginRight: 8 } : { marginLeft: 8 }]}>
      <Hi icon={accept ? CheckCircleIcon : XMarkIcon} size={22} color={tint} />
      <T size={12} weight={600} color={tint}>{accept ? 'Accept' : 'Deny'}</T>
    </View>
  )
}

function InboxCard({ item, busy, focused, onResolve }: {
  item: any
  busy: boolean
  focused: boolean
  onResolve: (item: any, action: 'accept' | 'deny') => Promise<void>
}) {
  const KindIcon = KIND_ICON[item.kind] || InboxStackIcon
  // A card arrived at from a notification opens with its details already showing:
  // the whole point of the deep link is to read what will run before saying yes.
  const [open, setOpen] = useState(focused)
  const swipe = useRef<SwipeableMethods>(null)
  const detailLabel = item.kind === 'imessage' ? 'message' : item.preview?.body ? 'proposed issue' : 'details'
  const acceptLabel = item.kind === 'imessage' ? `Send this message to ${item.meta?.recipient || 'them'}` : `Accept - add to ${item.destination}`

  async function swiped(direction: 'left' | 'right') {
    const action = direction === 'right' ? 'accept' : 'deny'
    const ok = await confirm(action === 'accept' ? `Accept “${item.title}”?` : `Skip “${item.title}”?`, {
      message: action === 'accept' ? `${acceptLabel.replace(/^Accept - a/, 'A')}.` : 'It won’t be added anywhere.',
      confirmLabel: action === 'accept' ? 'Accept' : 'Deny',
      destructive: action === 'deny',
    })
    swipe.current?.close()
    if (ok) await onResolve(item, action)
  }

  return (
    <ReanimatedSwipeable
      ref={swipe}
      enabled={!busy}
      friction={1.6}
      leftThreshold={80}
      rightThreshold={80}
      overshootFriction={8}
      renderLeftActions={() => <SwipeAction kind="accept" />}
      renderRightActions={() => <SwipeAction kind="deny" />}
      onSwipeableOpen={(d) => { void swiped(d) }}
      containerStyle={{ borderRadius: 12 }}
    >
      <View style={[st.card, open && { borderColor: '#39405288' }, focused && st.focused]}>
        <View style={st.row}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={st.top}>
              <View style={st.dest} accessibilityLabel={`Will be added to ${item.destination}`}>
                <Hi icon={KindIcon} size={13} color={colors.accent} />
                <T size={11} weight={600}>{item.destination}</T>
              </View>
              <T size={11} muted style={{ textTransform: 'capitalize', flexShrink: 1 }} numberOfLines={1}>{item.source}</T>
              <T size={11} muted style={{ marginLeft: 'auto', fontVariant: ['tabular-nums'] }}>{item.id}</T>
            </View>
            <T size={15} weight={500} lineHeight={20}>{item.title}</T>
            <View style={st.meta}>
              {metaEntries(item).map(([k, v]) => (
                <View key={k} style={st.chip}>
                  <T size={11} lineHeight={15}><T size={11} muted>{k} </T>{v}</T>
                </View>
              ))}
              {!item.when && item.kind !== 'github' && item.kind !== 'agent' ? (
                <View style={st.chip}><T size={11} lineHeight={15} muted>no date</T></View>
              ) : null}
            </View>
            <Press onPress={() => { tap(); setOpen((v) => !v) }} accessibilityState={{ expanded: open }} style={st.disclose}>
              <View style={open ? { transform: [{ rotate: '90deg' }] } : null}>
                <Hi icon={ChevronRightIcon} size={13} color={colors.muted} />
              </View>
              <T size={12} muted>{open ? `Hide ${detailLabel}` : `Show ${detailLabel}`}</T>
            </Press>
          </View>
          <View style={st.actions}>
            <Press
              disabled={busy}
              accessibilityLabel={acceptLabel}
              onPress={() => onResolve(item, 'accept')}
              style={st.btn}
            >
              <Hi icon={CheckCircleIcon} size={20} color={colors.muted} />
            </Press>
            <Press
              disabled={busy}
              accessibilityLabel="Deny - skip this item"
              onPress={() => onResolve(item, 'deny')}
              style={st.btn}
            >
              <Hi icon={XMarkIcon} size={20} color={colors.muted} />
            </Press>
          </View>
        </View>
        {open ? <InboxDetails item={item} /> : null}
      </View>
    </ReanimatedSwipeable>
  )
}

export default function InboxScreen() {
  // Proposal id from a deep link (a release notification's "tap to update").
  const { focus } = useLocalSearchParams<{ focus?: string }>()
  const focusId = focus || null
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const scroll = useRef<ScrollView>(null)
  const offsets = useRef<Record<string, number>>({})
  const scrolledTo = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { items } = await getInbox()
      setItems(items || [])
      // Keep the drawer badge in step with the list actually on screen.
      notifyInboxChanged()
    } catch (e: any) {
      if (!(e instanceof AuthError)) pushError(e.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Scroll the deep-linked proposal into view once it has laid out. Keyed on the
  // id, so a later refresh doesn't yank the list back to it.
  const scrollToFocus = useCallback(() => {
    if (!focusId || scrolledTo.current === focusId) return
    const y = offsets.current[focusId]
    if (y == null) return
    scrolledTo.current = focusId
    scroll.current?.scrollTo({ y: Math.max(0, y - 80), animated: true })
  }, [focusId])

  const onResolve = useCallback(async (item: any, action: 'accept' | 'deny') => {
    setBusyId(item.id)
    setNotice(null)
    try {
      const res: any = await resolveInboxItem(item.id, action)
      if (action === 'accept') success(); else warn()
      // Drop the resolved item out of the list; it won't come back from the API.
      setItems((prev) => prev.filter((it) => it.id !== item.id))
      notifyInboxChanged()
      setNotice(action === 'accept'
        ? `Accepted “${item.title}” - ${res?.note || `added to ${item.destination}`}`
        : `Skipped “${item.title}”`)
    } catch (e: any) {
      if (!(e instanceof AuthError)) pushError(`Couldn't ${action} “${item.title}”: ${e.message}`)
    } finally {
      setBusyId(null)
    }
  }, [])

  return (
    <Screen title="Inbox">
      <ScrollView
        ref={scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: FAB_CLEARANCE }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.muted} onRefresh={() => { setRefreshing(true); void load() }} />}
      >
        <ViewHead
          title="Inbox"
          count={items.length || null}
          right={<IconBtn icon={ArrowPathIcon} size={15} box={34} bordered label="Refresh" onPress={() => { void load() }} />}
        />
        <T size={13} muted lineHeight={19} style={{ marginTop: -6, marginBottom: 14 }}>
          Proposals waiting on your yes/no. Accept adds the item to its destination; deny skips it.
          Every item is already written in full — open its details to read the exact task, event, or
          GitHub issue that gets created.
        </T>

        {notice ? (
          <View style={st.notice}>
            <T size={13} style={{ flex: 1 }}>{notice}</T>
            <Press onPress={() => setNotice(null)} hitSlop={8}><T size={13} color={colors.accent}>dismiss</T></Press>
          </View>
        ) : null}

        {loading ? (
          <Empty title="Loading proposals…" />
        ) : items.length === 0 ? (
          <Empty icon={InboxStackIcon} title="Inbox zero. Nothing waiting on your decision." />
        ) : (
          <View style={{ gap: 10 }}>
            {/* Every card's buttons are disabled while any resolve is in flight, so a
                second tap can't race the first against the same inbox file. */}
            {items.map((item) => (
              <View key={item.id} onLayout={(e) => { offsets.current[item.id] = e.nativeEvent.layout.y; if (item.id === focusId) scrollToFocus() }}>
                <InboxCard item={item} busy={busyId !== null} focused={item.id === focusId} onResolve={onResolve} />
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  )
}

const st = StyleSheet.create({
  card: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16 },
  focused: { borderColor: alpha(colors.accent, 0.55), shadowColor: colors.accent, shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  dest: {
    flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 2, paddingHorizontal: 9,
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, borderRadius: 999,
  },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 7, maxWidth: '100%' },
  disclose: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10, alignSelf: 'flex-start', paddingVertical: 2 },
  actions: { flexDirection: 'row', gap: 8 },
  btn: {
    width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line,
  },
  details: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line, gap: 12 },
  command: {
    paddingVertical: 9, paddingHorizontal: 11, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line,
    borderRadius: 8, fontFamily: fonts.mono, overflow: 'hidden',
  },
  issueBody: { paddingVertical: 8, paddingHorizontal: 14, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: 8 },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, marginBottom: 14, paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: 9, backgroundColor: alpha(colors.accent, 0.12), borderWidth: 1, borderColor: alpha(colors.accent, 0.3),
  },
  swipe: { width: 88, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 12 },
})
