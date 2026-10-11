// Productivity: the manila-folder tab strip (ProductivityView.tsx / .app-tabs)
// over the apps. The strip is the only way between apps, as on the web: the apps
// are full of their own horizontal gestures (calendar periods, todo and list row
// swipes, scrolling strips, the drawer's edge swipe), and a pager that also paged
// sideways fought every one of them. Tapping a tab switches at once.
//
// An app mounts the first time it is shown and then stays mounted underneath,
// invisible and untouchable, so going back is instant and keeps its scroll,
// drafts and any recording in progress.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { Image } from 'expo-image'
import { useLocalSearchParams, router } from 'expo-router'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { Screen } from '../../shell/Screen'
import { tap } from '../../ui/haptics'
import { getSettings } from '../../lib/settings'
import TodosView from './TodosView'
import HabitsView from './HabitsView'
import GoalsView from './GoalsView'
import ListsView from './ListsView'
import JournalView from './JournalView'
import CalendarView from './CalendarView'

const APPS = [
  { id: 'todos', label: 'Todos', icon: require('../../../assets/images/connection-icons/totem-todos.png'), View: TodosView },
  { id: 'habits', label: 'Habits', icon: require('../../../assets/images/connection-icons/habits.png'), View: HabitsView },
  { id: 'goals', label: 'Goals', icon: require('../../../assets/images/connection-icons/goals.png'), View: GoalsView },
  { id: 'lists', label: 'Lists', icon: require('../../../assets/images/connection-icons/lists.png'), View: ListsView },
  { id: 'journal', label: 'Journal', icon: require('../../../assets/images/connection-icons/journal.png'), View: JournalView },
  { id: 'calendar', label: 'Calendar', icon: require('../../../assets/images/connection-icons/google-calendar.png'), View: CalendarView },
]

// router.ts DEFAULT_PRODUCTIVITY_APP, overridable by the landing-tab pref.
function initialApp(param?: string) {
  const landing = getSettings().landingTab
  const id = param || (APPS.some((a) => a.id === landing) ? landing : 'calendar')
  return Math.max(0, APPS.findIndex((a) => a.id === id))
}

export default function ProductivityScreen() {
  const { app } = useLocalSearchParams<{ app?: string }>()
  const [index, setIndex] = useState(() => initialApp(app))
  const [seen, setSeen] = useState<Set<number>>(() => new Set([index]))
  const strip = useRef<ScrollView>(null)
  const tabX = useRef<Record<number, { x: number; w: number }>>({})
  const stripW = useRef(0)

  // Keep the active tab in view: the strip scrolls once there are more apps than fit.
  const reveal = useCallback((i: number, animated = true) => {
    const t = tabX.current[i]
    if (t && stripW.current) strip.current?.scrollTo({ x: Math.max(0, t.x + t.w / 2 - stripW.current / 2), animated })
  }, [])

  const go = useCallback((i: number) => {
    setIndex(i)
    setSeen((s) => (s.has(i) ? s : new Set(s).add(i)))
    router.setParams({ app: APPS[i].id })
  }, [])

  // A deep link (Overview's app row, a notification) names the app to show.
  useEffect(() => {
    if (!app) return
    const i = APPS.findIndex((a) => a.id === app)
    if (i >= 0 && i !== index) go(i)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app])

  useEffect(() => { reveal(index) }, [index, reveal])

  return (
    <Screen title="Productivity" glow="productivity">
      <View style={st.tabsBand}>
        <ScrollView
          ref={strip}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={st.tabs}
          onLayout={(e) => { stripW.current = e.nativeEvent.layout.width; reveal(index, false) }}
          accessibilityRole="tablist"
        >
          {APPS.map((a, i) => {
            const on = i === index
            return (
              <Press
                key={a.id}
                onLayout={(e) => {
                  tabX.current[i] = { x: e.nativeEvent.layout.x, w: e.nativeEvent.layout.width }
                  // Layout lands after the first effect; the opening tab still needs revealing.
                  if (i === index) reveal(i, false)
                }}
                onPress={() => { if (!on) { tap(); go(i) } }}
                hitSlop={{ top: 6, bottom: 2 }}
                style={[st.tab, on && st.tabOn]}
                accessibilityRole="tab"
                accessibilityLabel={a.label}
                accessibilityState={{ selected: on }}
              >
                <Image source={a.icon} style={{ width: 16, height: 16, borderRadius: 3 }} />
                <T size={14} weight={on ? 600 : 500} color={on ? colors.text : colors.muted}>{a.label}</T>
              </Press>
            )
          })}
        </ScrollView>
      </View>
      <View style={{ flex: 1 }}>
        {APPS.map((a, i) => {
          if (!seen.has(i)) return null
          const on = i === index
          return (
            <View
              key={a.id}
              style={[StyleSheet.absoluteFill, on ? st.pageOn : st.pageOff]}
              accessibilityElementsHidden={!on}
              importantForAccessibility={on ? 'auto' : 'no-hide-descendants'}
            >
              <a.View active={on} />
            </View>
          )
        })}
      </View>
    </Screen>
  )
}

const st = StyleSheet.create({
  // The strip sits on the sidebar-coloured band; the active tab melts into the page.
  tabsBand: { backgroundColor: colors.bg2, borderBottomWidth: 1, borderBottomColor: colors.line },
  tabs: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, paddingTop: 10, paddingHorizontal: 14 },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 15, minHeight: 40,
    borderTopLeftRadius: 10, borderTopRightRadius: 10, borderWidth: 1, borderBottomWidth: 0, borderColor: 'transparent',
    marginBottom: -1,
  },
  tabOn: { backgroundColor: colors.bg, borderColor: colors.line, paddingBottom: 11 },
  // Hidden apps stay laid out (so their scroll views keep their offsets) but take
  // no touches and draw nothing.
  pageOn: { zIndex: 1, opacity: 1 },
  pageOff: { zIndex: 0, opacity: 0, pointerEvents: 'none' },
})
