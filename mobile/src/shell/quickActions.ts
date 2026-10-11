// Long-press the app icon: the same front doors as the phone's FABs, plus the
// two places Totem is usually opened to check on. Handled once the drawer is up,
// so a cold start from an action still lands inside the signed-in app.
import { useEffect } from 'react'
import { Platform } from 'react-native'
import { router } from 'expo-router'
import * as QuickActions from 'expo-quick-actions'
import { newChat, startVoice } from './nav'

const ITEMS: QuickActions.Action[] = [
  { id: 'new-chat', title: 'New chat', icon: 'symbol:square.and.pencil' },
  { id: 'voice', title: 'Talk to Totem', icon: 'symbol:waveform' },
  { id: 'inbox', title: 'Inbox', icon: 'symbol:tray.and.arrow.down' },
  { id: 'search', title: 'Search', icon: 'symbol:magnifyingglass' },
]

function run(action: QuickActions.Action | null | undefined) {
  switch (action?.id) {
    case 'new-chat': return newChat()
    case 'voice': return startVoice()
    case 'inbox': return router.navigate('/inbox')
    case 'search': return router.navigate('/search')
  }
}

export function useQuickActions() {
  useEffect(() => {
    if (Platform.OS === 'web') return
    QuickActions.setItems(ITEMS).catch(() => {})
    // Launched from an action: the navigator has just mounted, so defer a tick.
    const initial = QuickActions.initial
    if (initial) setTimeout(() => run(initial), 0)
    const sub = QuickActions.addListener(run)
    return () => sub.remove()
  }, [])
}
