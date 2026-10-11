import '../lib/boot'
import React, { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Stack, ThemeProvider, DarkTheme } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter'
import { Unbounded_600SemiBold } from '@expo-google-fonts/unbounded'
import { loadConnection, useConnection, clearSecretStored } from '../lib/connection'
import { initChat } from '../lib/chat/store'
import ToastHost from '../ui/ToastHost'
import { pushedOptions } from '../features/settings/ui'
import { ScreenError } from '../shell/ScreenError'
import { colors } from '../theme'

SplashScreen.preventAutoHideAsync()

// A screen that throws shows ScreenError instead of closing the app (release
// builds otherwise die on any render error). Applies to every nested screen.
export const unstable_settings = { screenErrorBoundary: ScreenError }
export { ScreenError as ErrorBoundary }

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.bg, card: colors.bg2, text: colors.text, border: colors.line, primary: colors.accent },
}

// How every route over the drawer is presented. This has to be declared here, on
// the navigator: set from inside the screen (<Stack.Screen options> in its body),
// the presentation arrives after the push has begun, so a sheet slides in from the
// right as a card and then re-lays itself out. Screens may still set a title.
//
// Detents are fractions of the screen; content in a numeric-detent sheet can use
// flex: 1. 'fitToContents' is avoided: it can't size a flex: 1 root.
type Detents = number[]
const sheet = (detents: Detents, background: string = colors.bg2) => ({
  presentation: 'formSheet' as const,
  sheetAllowedDetents: detents,
  sheetGrabberVisible: true,
  sheetCornerRadius: 22,
  contentStyle: { backgroundColor: background },
})

/** One row per route under src/app, outside the drawer and Connect. */
const ROUTES: { name: string; options: object }[] = [
  // Chat (features/chat, features/voice)
  { name: 'chat/model', options: sheet([0.5, 1]) },
  { name: 'chat/usage', options: sheet([0.6, 1]) },
  { name: 'chat/agents', options: sheet([0.6, 1]) },
  { name: 'chat/file', options: sheet([0.75, 1], colors.bg) },
  { name: 'chat/snooze', options: sheet([0.5]) },
  // Voice takes the whole screen and stays until ended: no swipe-down to leave it live.
  { name: 'chat/voice', options: { presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false, contentStyle: { backgroundColor: '#08090d' } } },
  // Tasks
  { name: 'todo/new', options: sheet([0.92]) },
  { name: 'todo/[id]', options: sheet([0.92]) },
  { name: 'todo/lifecycle', options: sheet([0.6, 0.92]) },
  // Habits: the day sheet is short without a number to log and taller with one,
  // so it opens at three quarters and expands to full.
  { name: 'habit/new', options: sheet([1]) },
  { name: 'habit/edit', options: sheet([1]) },
  { name: 'habit/day', options: sheet([0.75, 1]) },
  { name: 'habit/period', options: sheet([0.75, 1]) },
  // The morning check-in: a page of rows, full height like WHOOP's journal.
  { name: 'habit/checkin', options: sheet([1]) },
  { name: 'overview/habit-day', options: sheet([0.75, 1]) },
  // Goals
  { name: 'goal/new', options: sheet([1]) },
  // Opens with the keyboard up on the title (or the note), so it starts full height.
  { name: 'goal/edit', options: sheet([1]) },
  { name: 'goal/numbers', options: sheet([1]) },
  // Calendar, journal, search
  { name: 'calendar/event', options: sheet([0.85, 1]) },
  { name: 'journal/[id]', options: sheet([1]) },
  { name: 'journal/settings', options: sheet([0.9, 1]) },
  { name: 'search-result', options: sheet([0.75, 1]) },
  // Pushed screens with the system back button.
  { name: 'settings/[pane]', options: pushedOptions('Settings', 'Settings') },
  { name: 'totem/[id]', options: pushedOptions('', 'Totems') },
  { name: 'totem/new', options: pushedOptions('', 'Totems') },
  // A list draws its own header (back, title, its "…" menu).
  { name: 'list/[id]', options: {} },
]

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Unbounded_600SemiBold })
  const [ready, setReady] = useState(false)
  const conn = useConnection()
  const connected = Boolean(conn.baseUrl && conn.secret)

  useEffect(() => { loadConnection().finally(() => setReady(true)) }, [])
  useEffect(() => { if (fontsLoaded && ready) SplashScreen.hideAsync() }, [fontsLoaded, ready])
  // The chat store is the app's one long-lived sync loop; start it once signed in.
  // A 401 anywhere in it means the secret is wrong now: back to Connect.
  useEffect(() => { if (connected) initChat(() => { void clearSecretStored() }) }, [connected])

  if (!fontsLoaded || !ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        {/* Keyboard-aware views anywhere (the chat composer rides the keyboard). */}
        <KeyboardProvider>
          <ThemeProvider value={theme}>
            <StatusBar style="light" />
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
              <Stack.Protected guard={connected}>
                <Stack.Screen name="(app)" />
                {ROUTES.map((r) => <Stack.Screen key={r.name} name={r.name} options={r.options} />)}
              </Stack.Protected>
              <Stack.Protected guard={!connected}>
                <Stack.Screen name="connect" options={{ animation: 'fade' }} />
              </Stack.Protected>
            </Stack>
            <ToastHost />
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
