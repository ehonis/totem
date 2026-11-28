// The phone sidebar (Shell.tsx MobileDrawer): TOTEM with Search (the Search page);
// then Overview (a dot when a totem's report waits), the Productivity tools and the chats (one list, T3 Code's way:
// features/chat/ChatsNav.tsx) in one scroll; and a foot that floats over the scroll's
// end, with the chats' Snoozed and Settled buttons on the left and New chat and
// Settings on the right, where the thumb is (the web drawer's foot has Settings there
// too). On iOS 26 the foot is liquid glass (ui/glass.tsx): neighbouring buttons melt
// into one shape, the list slides under them, and New chat wears the corner button's
// light tint. Totems is not here: it opens from the Overview's app row.
// The drawer takes the whole screen (the page slides off to the right); the head's
// close button, a swipe back or picking anything closes it.
//
// On the phone Totem is a chat app first, so the web's tab rail isn't here: the other
// screens open from the Overview's app row. The Productivity tools are the exception
// (#177): each is its own page now, and switching between them is what the old tab
// strip was for, so they sit here as a compact grid, every one a tap away. The heading
// opens the hub; its chevron folds the grid away for a chats-first drawer, remembered
// on this device. Settings' dot is the old bell's, since the notification history
// now lives in Settings. Search opens the Search page; the chat list has no search
// box of its own.
import React, { useEffect, useState } from 'react'
import { LayoutAnimation, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useReducedMotion } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, usePathname } from 'expo-router'
import type { DrawerContentComponentProps } from 'expo-router/drawer'
import { LinearGradient } from 'expo-linear-gradient'
import { alpha, colors, textAlpha } from '../theme'
import { T } from '../ui/Text'
import { Badge, IconBtn, Press } from '../ui/kit'
import { FAB_TINT, GLASS, GlassButton, GlassGroup } from '../ui/glass'
import { Hi, ChevronRightIcon } from '../lib/icons'
import { NAV_ICONS } from '../lib/navIcons'
import IconChevronDown from '@tabler/icons-react-native/dist/esm/icons/IconChevronDown.mjs'
import IconChevronUp from '@tabler/icons-react-native/dist/esm/icons/IconChevronUp.mjs'
import { useSettings } from '../lib/settings'
import { IconEdit, IconLayoutSidebarLeftCollapse } from '../lib/chat/icons'
import { useInboxCount } from '../lib/useInboxCount'
import { useUnreadNotifications } from '../features/notifications/useUnread'
import ChatsNav, { DockedShelfButtons } from '../features/chat/ChatsNav'
import ChatsNavDrafts from '../features/chat/ChatsNavDrafts'
import { DockedUndo } from '../features/work/undoDock'
import { keepDrawerClose } from './drawerGesture'
import { newChat, openChat } from './nav'
import { PRODUCTIVITY_APPS, TAB_ROUTES, TOOL_LABELS, productivityPage, productivityPath } from './routes'
import { ToolIcon } from './ToolIcon'
import { tap } from '../ui/haptics'
import { useTotemReportWaiting } from '../features/chat/totemReport'
import { BUILD_VERSION } from '../lib/buildVersion'

const FOLD_KEY = 'totem.drawer.toolsFolded'
const readFolded = () => { try { return localStorage.getItem(FOLD_KEY) === '1' } catch { return false } }

/** The open tool's name, for the folded heading. */
function onToolName(path: string): string | null {
  const page = productivityPage(path)
  return page && page !== 'hub' ? TOOL_LABELS[page] : null
}

// The running update's version and merge date beside the wordmark, as the web rail shows them
// (Version in web/src/components/Shell.tsx), so a glance says whether the latest OTA has landed.
// A dev client runs the unstamped copy and shows "dev".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return m && d ? `${MONTHS[m - 1]} ${d}` : iso
}

function Version() {
  const { version, date } = BUILD_VERSION
  return (
    <T size={11} numberOfLines={1} style={{ color: textAlpha(45), fontVariant: ['tabular-nums'], flexShrink: 1 }}>
      {version ? `${version} · ${shortDate(date)}` : 'dev'}
    </T>
  )
}

export default function AppDrawer({ navigation }: DrawerContentComponentProps) {
  const insets = useSafeAreaInsets()
  const { fontScale } = useWindowDimensions()
  // Large text gets two wider columns, the largest sizes one row per tool, so a name never clips.
  const roomy = fontScale > 1.3
  const single = fontScale > 1.8
  const { reduceMotion } = useSettings()
  const still = useReducedMotion() || reduceMotion
  const [folded, setFolded] = useState(readFolded)
  const toggleFold = () => {
    tap()
    if (!still) LayoutAnimation.configureNext(LayoutAnimation.create(200, 'easeInEaseOut', 'opacity'))
    setFolded((f) => {
      try { localStorage.setItem(FOLD_KEY, f ? '0' : '1') } catch { /* stays for this session */ }
      return !f
    })
  }
  const path = usePathname()
  const onOverview = path === '/' || path === ''
  const onSettings = path.startsWith('/settings')
  const onSearch = path.startsWith('/search')
  const totemReports = useTotemReportWaiting()
  const onTool = productivityPage(path)
  const toolName = onToolName(path)
  // Highlighted on the hub, or folded away while one of its tools is open.
  const headOn = onTool === 'hub' || Boolean(folded && toolName)
  // The Inbox tab is gone from here, so its count rides on the Overview row, where
  // the waiting-proposals banner it leads to lives.
  const { open: inboxOpen } = useInboxCount(true)
  // Mounted for the life of the app: keeps the icon badge in step with the unread count.
  const unread = useUnreadNotifications()
  const close = () => navigation.closeDrawer()
  // A chat opened from the shelf sheet over the drawer closes the drawer too.
  useEffect(() => keepDrawerClose(() => navigation.closeDrawer()), [navigation])
  const go = (to: string) => { tap(); router.navigate(to as any); close() }
  // The list scrolls under the floating foot, so its end clears the foot's height.
  const [footH, setFootH] = useState(72)
  const openFromDrawer = (id: string | null) => { openChat(id); close() }

  return (
    <View style={[st.drawer, { paddingTop: insets.top }]}>
      <View style={st.head}>
        <View style={st.brand}>
          <T brand size={17} style={{ letterSpacing: 2, textTransform: 'uppercase' }}>Totem</T>
          <Version />
        </View>
        <IconBtn
          icon={NAV_ICONS.search}
          size={20}
          box={44}
          label="Search"
          color={onSearch ? colors.text : textAlpha(72)}
          style={onSearch ? { backgroundColor: colors.drawerOn } : undefined}
          onPress={() => go(TAB_ROUTES.search)}
        />
        {/* No page edge is left to tap, so the head closes it; a swipe left does too. */}
        <IconBtn icon={IconLayoutSidebarLeftCollapse} size={21} box={44} label="Close menu" color={textAlpha(72)} onPress={close} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: footH + 12 }} scrollIndicatorInsets={{ bottom: footH }} keyboardShouldPersistTaps="handled">
        <View style={st.nav}>
          <Press style={[st.item, onOverview && st.itemOn]} onPress={() => go(TAB_ROUTES.overview)} accessibilityRole="button" accessibilityLabel={`Overview${inboxOpen ? `, ${inboxOpen} in the inbox` : ''}${totemReports ? ", a totem's report is waiting" : ''}`}>
            <Hi icon={NAV_ICONS.overview} size={20} color={onOverview ? colors.text : textAlpha(86)} />
            <T size={15.5} color={onOverview ? colors.text : textAlpha(86)} style={{ flex: 1 }}>Overview</T>
            <Badge count={inboxOpen} />
            {/* A totem's report waits: its Totems tile on the Overview has the same dot. */}
            {totemReports ? <View style={st.dot} /> : null}
          </Press>
        </View>
        <View style={st.tools}>
          <View style={st.toolsHead}>
            <Press
              style={[st.toolsOpen, headOn && st.itemOn]}
              onPress={() => go(productivityPath())}
              accessibilityRole="button"
              accessibilityLabel={folded && toolName ? `Productivity, all tools. ${toolName} is open` : 'Productivity, all tools'}
              accessibilityState={{ selected: onTool === 'hub' }}
            >
              <T size={13.5} weight={600} color={headOn ? colors.text : textAlpha(62)} numberOfLines={single ? 2 : 1} style={{ flexShrink: 1 }}>
                {/* Folded away, the heading still says which tool is open. */}
                {folded && toolName ? `Productivity · ${toolName}` : 'Productivity'}
              </T>
              <Hi icon={ChevronRightIcon} size={14} color={textAlpha(40)} />
            </Press>
            <Press
              style={st.fold}
              onPress={toggleFold}
              accessibilityRole="button"
              accessibilityLabel={folded ? 'Show tools' : 'Hide tools'}
              accessibilityState={{ expanded: !folded }}
            >
              {folded
                ? <IconChevronDown size={18} strokeWidth={1.75} color={textAlpha(55)} />
                : <IconChevronUp size={18} strokeWidth={1.75} color={textAlpha(55)} />}
            </Press>
          </View>
          {folded ? null : (
            <View style={st.grid}>
              {PRODUCTIVITY_APPS.map((app) => {
                const on = onTool === app
                return (
                  <Press
                    key={app}
                    style={[st.tool, roomy ? st.toolRoomy : st.toolTight, single && st.toolSingle, on && st.itemOn]}
                    onPress={() => go(productivityPath(app))}
                    accessibilityRole="button"
                    accessibilityLabel={TOOL_LABELS[app]}
                    accessibilityState={{ selected: on }}
                  >
                    <ToolIcon app={app} size={24} />
                    <T size={12} weight={on ? 600 : 400} color={on ? colors.text : textAlpha(72)} numberOfLines={roomy ? 2 : 1} style={roomy ? { flexShrink: 1 } : undefined}>
                      {TOOL_LABELS[app]}
                    </T>
                  </Press>
                )
              })}
            </View>
          )}
        </View>
        <ChatsNav
          onOpenChat={openFromDrawer}
          chatShowing={path.startsWith('/chat')}
          drafts={(projectId, homeOnly) => <ChatsNavDrafts projectId={projectId} homeOnly={homeOnly} onOpen={close} />}
        />
      </ScrollView>
      <View
        style={[st.foot, !GLASS && st.footSolid, { paddingBottom: Math.max(insets.bottom, 10) }]}
        onLayout={(e) => setFootH(Math.round(e.nativeEvent.layout.height))}
        pointerEvents="box-none"
      >
        {/* The list fades out under the glass, as iOS 26's scroll edge does. */}
        {GLASS ? <LinearGradient pointerEvents="none" colors={[alpha(colors.bg2, 0), alpha(colors.bg2, 0.85)]} locations={[0, 0.55]} style={st.fade} /> : null}
        {/* A discarded draft's Undo, kept in sight whatever the scroll. */}
        <DockedUndo />
        <View style={st.footRow} pointerEvents="box-none">
          <View style={{ flex: 1 }} pointerEvents="box-none"><DockedShelfButtons /></View>
          <GlassGroup spacing={14} style={st.pair}>
            <GlassButton
              shape={st.round}
              fallback={{ backgroundColor: colors.text }}
              tint={FAB_TINT}
              haptic
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel="New chat"
              onPress={() => { newChat(); close() }}
            >
              <Hi icon={IconEdit} size={20} strokeWidth={2} color="#0f1115" />
            </GlassButton>
            <GlassButton
              shape={st.round}
              fallback={onSettings ? { backgroundColor: colors.drawerOn } : undefined}
              tint={onSettings ? 'rgba(255,255,255,0.14)' : undefined}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={unread > 0 ? `Settings, ${unread} unread ${unread === 1 ? 'notification' : 'notifications'}` : 'Settings'}
              onPress={() => go(TAB_ROUTES.settings)}
            >
              <Hi icon={NAV_ICONS.settings} size={22} color={onSettings ? colors.text : textAlpha(82)} />
              {unread > 0 ? <View style={st.badge} /> : null}
            </GlassButton>
          </GlassGroup>
        </View>
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  drawer: { flex: 1, backgroundColor: colors.bg2, paddingHorizontal: 8 },
  head: { height: 58, flexDirection: 'row', alignItems: 'center', gap: 2 },
  brand: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingLeft: 10, minWidth: 0 },
  nav: { paddingTop: 2, paddingBottom: 6, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  // Floating over the scroll's end: the shelves on the left, New chat and Settings on the right.
  foot: { position: 'absolute', left: 8, right: 8, bottom: 0 },
  // Without glass the foot is a solid band, as before.
  footSolid: { backgroundColor: colors.bg2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  fade: { position: 'absolute', left: -8, right: -8, top: -18, bottom: 0 },
  footRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, paddingLeft: 4, paddingRight: 2 },
  // Close enough to melt into one shape under glass.
  pair: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Screen.tsx's new-chat corner button, smaller.
  round: { width: 46, height: 46, borderRadius: 23 },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 6, backgroundColor: colors.accent },
  badge: { position: 'absolute', top: 9, right: 10, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  item: { flexDirection: 'row', alignItems: 'center', gap: 13, minHeight: 44, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 10 },
  itemOn: { backgroundColor: colors.drawerOn },
  tools: { paddingTop: 6, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  toolsHead: { flexDirection: 'row', alignItems: 'center' },
  toolsOpen: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 10 },
  fold: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  // Four across: every tool a tap away in two short rows.
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tool: { minHeight: 60, borderRadius: 12, paddingVertical: 7 },
  toolTight: { width: '25%', alignItems: 'center', justifyContent: 'center', gap: 5 },
  // Large text: two columns, icon beside its name.
  toolRoomy: { width: '50%', flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 },
  toolSingle: { width: '100%' },
})
