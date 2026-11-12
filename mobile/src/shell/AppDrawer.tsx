// The phone sidebar (Shell.tsx MobileDrawer): TOTEM with Search (the Search page);
// then Overview, the Productivity tools and the chats in one scroll; and a foot
// that stays put, with the chats' Snoozed and Settled buttons on the left and New
// chat and Settings on the right, where the thumb is (the web drawer's foot has
// Settings there too). New chat wears the corner button's light fill.
// The drawer navigator slides the page aside to reveal it, the way the ChatGPT app
// does; the scrim, a swipe or picking anything closes it.
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
import { colors, textAlpha } from '../theme'
import { T } from '../ui/Text'
import { Badge, IconBtn, Press } from '../ui/kit'
import { Hi, Squares2X2Icon, Cog6ToothIcon, ChevronRightIcon } from '../lib/icons'
import IconChevronDown from '@tabler/icons-react-native/dist/esm/icons/IconChevronDown.mjs'
import IconChevronUp from '@tabler/icons-react-native/dist/esm/icons/IconChevronUp.mjs'
import { useSettings } from '../lib/settings'
import { IconEdit, IconSearch } from '../lib/chat/icons'
import { useInboxCount } from '../lib/useInboxCount'
import { useUnreadNotifications } from '../features/notifications/useUnread'
import ChatsNav, { DockedShelfButtons } from '../features/chat/ChatsNav'
import { keepDrawerClose } from './drawerGesture'
import { newChat, openChat } from './nav'
import { PRODUCTIVITY_APPS, TAB_ROUTES, TOOL_LABELS, productivityPage, productivityPath } from './routes'
import { ToolIcon } from './ToolIcon'
import { tap } from '../ui/haptics'

const FOLD_KEY = 'totem.drawer.toolsFolded'
const readFolded = () => { try { return localStorage.getItem(FOLD_KEY) === '1' } catch { return false } }

/** The open tool's name, for the folded heading. */
function onToolName(path: string): string | null {
  const page = productivityPage(path)
  return page && page !== 'hub' ? TOOL_LABELS[page] : null
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

  return (
    <View style={[st.drawer, { paddingTop: insets.top }]}>
      <View style={st.head}>
        <T brand size={17} style={{ flex: 1, letterSpacing: 2, textTransform: 'uppercase', paddingLeft: 10 }}>Totem</T>
        <IconBtn
          icon={IconSearch}
          size={20}
          box={44}
          label="Search"
          color={onSearch ? colors.text : textAlpha(72)}
          style={onSearch ? { backgroundColor: colors.drawerOn } : undefined}
          onPress={() => go(TAB_ROUTES.search)}
        />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16 }} keyboardShouldPersistTaps="handled">
        <View style={st.nav}>
          <Press style={[st.item, onOverview && st.itemOn]} onPress={() => go(TAB_ROUTES.overview)} accessibilityRole="button">
            <Hi icon={Squares2X2Icon} size={20} color={onOverview ? colors.text : textAlpha(86)} />
            <T size={15.5} color={onOverview ? colors.text : textAlpha(86)} style={{ flex: 1 }}>Overview</T>
            <Badge count={inboxOpen} />
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
        <ChatsNav onOpenChat={(id) => { openChat(id); close() }} />
      </ScrollView>
      <View style={[st.foot, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <View style={{ flex: 1 }}><DockedShelfButtons /></View>
        <Press haptic style={st.newChat} onPress={() => { newChat(); close() }} accessibilityRole="button" accessibilityLabel="New chat" hitSlop={4}>
          <Hi icon={IconEdit} size={20} strokeWidth={2} color="#0f1115" />
        </Press>
        <IconBtn
          icon={Cog6ToothIcon}
          size={22}
          box={44}
          label={unread > 0 ? `Settings, ${unread} unread ${unread === 1 ? 'notification' : 'notifications'}` : 'Settings'}
          badge={unread > 0}
          color={onSettings ? colors.text : textAlpha(72)}
          style={onSettings ? { backgroundColor: colors.drawerOn } : undefined}
          onPress={() => go(TAB_ROUTES.settings)}
        />
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  drawer: { flex: 1, backgroundColor: colors.bg2, paddingHorizontal: 8 },
  head: { height: 58, flexDirection: 'row', alignItems: 'center', gap: 2 },
  nav: { paddingTop: 2, paddingBottom: 6, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  // Pinned under the scroll: the shelves on the left, Settings on the right.
  foot: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 8, paddingLeft: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  // Screen.tsx's new-chat corner button, smaller: the one light circle in the drawer.
  newChat: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.text },
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
