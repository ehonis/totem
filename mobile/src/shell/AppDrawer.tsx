// The phone sidebar (Shell.tsx MobileDrawer): TOTEM, search chats, Settings, close; then
// Overview and New chat, and the chats underneath. The drawer navigator slides
// the page aside to reveal it, the way the ChatGPT app does.
//
// Unlike the web there are no tabs here: on the phone Totem is a chat app first,
// and every other screen opens from the Overview's app row. Settings is the gear
// beside search; its dot is the old bell's, since the notification history now
// lives in Settings.
import React, { useState } from 'react'
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, usePathname } from 'expo-router'
import type { DrawerContentComponentProps } from 'expo-router/drawer'
import { colors, textAlpha } from '../theme'
import { T } from '../ui/Text'
import { Badge, IconBtn, Press } from '../ui/kit'
import { Hi, Squares2X2Icon, Cog6ToothIcon } from '../lib/icons'
import { IconEdit, IconSearch, IconX } from '../lib/chat/icons'
import { useInboxCount } from '../lib/useInboxCount'
import { useUnreadNotifications } from '../features/notifications/useUnread'
import ChatsNav, { ChatShelfDock } from '../features/chat/ChatsNav'
import { newChat, openChat, TAB_ROUTES } from './nav'
import { tap } from '../ui/haptics'

export default function AppDrawer({ navigation }: DrawerContentComponentProps) {
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const path = usePathname()
  const onOverview = path === '/' || path === ''
  const onSettings = path.startsWith('/settings')
  // The Inbox tab is gone from here, so its count rides on the Overview row, where
  // the waiting-proposals banner it leads to lives.
  const { open: inboxOpen } = useInboxCount(true)
  // Mounted for the life of the app: keeps the icon badge in step with the unread count.
  const unread = useUnreadNotifications()
  const [searchSignal, setSearchSignal] = useState(0)
  const close = () => navigation.closeDrawer()
  const go = (to: string) => { tap(); router.navigate(to as any); close() }

  return (
    <View style={[st.drawer, { paddingTop: insets.top }]}>
      <View style={st.head}>
        <T brand size={17} style={{ flex: 1, letterSpacing: 2, textTransform: 'uppercase', paddingLeft: 10 }}>Totem</T>
        <IconBtn icon={IconSearch} size={20} label="Search chats" onPress={() => setSearchSignal((n) => n + 1)} />
        <IconBtn
          icon={Cog6ToothIcon}
          size={21}
          label="Settings"
          badge={unread > 0}
          color={onSettings ? colors.text : textAlpha(72)}
          style={onSettings ? { backgroundColor: colors.drawerOn } : undefined}
          onPress={() => go(TAB_ROUTES.settings)}
        />
        <IconBtn icon={IconX} size={21} label="Close" onPress={close} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16 }} keyboardShouldPersistTaps="handled">
        <View style={st.nav}>
          <Press style={[st.item, onOverview && st.itemOn]} onPress={() => go(TAB_ROUTES.overview)} accessibilityRole="button">
            <Hi icon={Squares2X2Icon} size={20} color={onOverview ? colors.text : textAlpha(86)} />
            <T size={15.5} color={onOverview ? colors.text : textAlpha(86)} style={{ flex: 1 }}>Overview</T>
            <Badge count={inboxOpen} />
          </Press>
          <Press haptic style={st.item} onPress={() => { newChat(); close() }} accessibilityRole="button">
            <Hi icon={IconEdit} size={19} color={colors.text} />
            <T size={15.5}>New chat</T>
          </Press>
        </View>
        <ChatsNav onOpenChat={(id) => { openChat(id); close() }} searchSignal={searchSignal} />
      </ScrollView>
      {/* Snoozed and Settled sit at the bottom, as in T3 Code's sidebar. */}
      <View style={{ paddingBottom: Math.max(insets.bottom, 10) }}>
        <ChatShelfDock maxHeight={Math.round(height * 0.42)} />
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  drawer: { flex: 1, backgroundColor: colors.bg2, paddingHorizontal: 8 },
  head: { height: 58, flexDirection: 'row', alignItems: 'center', gap: 2 },
  nav: { paddingTop: 2, paddingBottom: 6, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  item: { flexDirection: 'row', alignItems: 'center', gap: 13, height: 44, paddingHorizontal: 12, borderRadius: 10 },
  itemOn: { backgroundColor: colors.drawerOn },
})
