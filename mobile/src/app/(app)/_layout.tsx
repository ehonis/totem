// The signed-in app: the push drawer around every tab (ChatGPT's layout — the
// page slides right to reveal the sidebar, and follows a finger from the edge).
import React, { useEffect } from 'react'
import { useWindowDimensions } from 'react-native'
import { Drawer } from 'expo-router/drawer'
import AppDrawer from '../../shell/AppDrawer'
import { keepDrawerPan } from '../../shell/drawerGesture'
import { useQuickActions } from '../../shell/quickActions'
import { usePush } from '../../shell/push'
import { useAccessReauth } from '../../shell/accessReauth'
import { useMorningCheckin } from '../../shell/morningCheckin'
import { navigateTo } from '../../shell/nav'
import { getSettings } from '../../lib/settings'
import { colors } from '../../theme'

export default function AppLayout() {
  const { width } = useWindowDimensions()
  useQuickActions()
  usePush()
  useAccessReauth()
  useMorningCheckin()
  // Settings → General → Default tab. The app always opens on "/", so a different
  // landing tab is one navigation on first mount. (A quick action, handled a tick
  // later, still wins.)
  useEffect(() => {
    const landing = getSettings().landingTab
    if (landing && landing !== 'overview') navigateTo(landing)
  }, [])
  return (
    <Drawer
      drawerContent={(props) => <AppDrawer {...props} />}
      screenOptions={{
        headerShown: false,
        drawerType: 'slide',
        // shell.css: --sh-w: min(84vw, 330px)
        drawerStyle: { width: Math.min(width * 0.84, 330), backgroundColor: colors.bg2 },
        overlayColor: 'rgba(0,0,0,0.35)',
        swipeEnabled: true,
        swipeEdgeWidth: 40,
        configureGestureHandler: keepDrawerPan,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Drawer.Screen name="index" options={{ title: 'Overview' }} />
      <Drawer.Screen name="search" options={{ title: 'Search' }} />
      <Drawer.Screen name="totems" options={{ title: 'Totems' }} />
      <Drawer.Screen name="chat" options={{ title: 'Chat' }} />
      <Drawer.Screen name="productivity" options={{ title: 'Productivity' }} />
      <Drawer.Screen name="inbox" options={{ title: 'Inbox' }} />
      <Drawer.Screen name="fleet" options={{ title: 'Fleet' }} />
      <Drawer.Screen name="settings" options={{ title: 'Settings' }} />
    </Drawer>
  )
}
