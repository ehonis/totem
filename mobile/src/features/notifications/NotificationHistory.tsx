// The bell (web NotificationCenter.tsx), as Settings → Notification history: every
// notification Totem has raised, whether or not it reached a phone, what it is about
// to say, and the thumbs that teach it. On the phone it is a pushed pane rather than
// a popover off a bell, so it gets the whole screen and the system back button.
// A downvote asks one optional follow-up as chips, because
// "not useful", "wrong time", "too many" and "badly worded" have opposite fixes;
// an upvote is one tap.
import React, { useCallback, useEffect, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Hi, HandThumbUpIcon, HandThumbDownIcon, ClockIcon } from '../../lib/icons'
import {
  getNotificationHistory, markNotificationsRead, rateNotification,
  DOWNVOTE_REASONS, type HistoryItem, type Upcoming,
} from '../../lib/push'
import { colors, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { IconBtn, Press, Spinner } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { refreshUnread } from './useUnread'
import { openDashboardUrl } from './openUrl'

// styles.css --dim / --fg-2 are not tokens; the panel falls back to these shades.
const DIM = colors.muted
const FG2 = '#c3c8d4'

const when = (ts: number) => {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const until = (ts: number) => {
  const diff = ts - Date.now()
  if (diff <= 0) return 'any moment'
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `at ${new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

export default function NotificationHistory() {
  const insets = useSafeAreaInsets()
  const [items, setItems] = useState<HistoryItem[]>([])
  const [upcoming, setUpcoming] = useState<Upcoming[]>([])
  const [loaded, setLoaded] = useState(false)
  const [rating, setRating] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const data = await getNotificationHistory()
      setItems(data.items)
      setUpcoming(data.upcoming)
    } catch {
      // The bell is not worth an error screen; an empty list reads the same as a
      // quiet week, and the Logs pane is where a real failure gets diagnosed.
    } finally {
      setLoaded(true)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Mark read on open rather than per item: the dot is "is there anything new",
    // not a to-do list. The beat lets the unread tint show first.
    const timer = setTimeout(() => {
      void markNotificationsRead().then(refresh).then(refreshUnread).catch(() => {})
    }, 1200)
    return () => clearTimeout(timer)
  }, [refresh])

  const vote = async (item: HistoryItem, v: 'up' | 'down', reasons: string[] = []) => {
    tap()
    setBusy(true)
    // Optimistic: the rating is advisory and a failed write is not worth an alert.
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, feedback: { vote: v, reasons, at: Date.now() } } : i)))
    try { await rateNotification(item, v, reasons) } catch { /* advisory */ }
    setRating(null)
    setBusy(false)
    void refresh()
  }

  // A deep link leaves Settings for the screen it names (openDashboardUrl navigates
  // back down to the drawer), the way a tapped push notification does.
  const open = (url: string) => { tap(); openDashboardUrl(url) }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.muted} onRefresh={() => { setRefreshing(true); void refresh() }} />}
      >
        {upcoming.length > 0 ? (
          <>
            <View style={st.section}>
              <Hi icon={ClockIcon} size={13} color={DIM} />
              <T size={11.5} color={DIM}>Coming up</T>
            </View>
            {upcoming.map((u) => (
              <View key={u.id} style={[st.row, { opacity: 0.72 }]}>
                <View style={st.copy}>
                  <T size={13.5} weight={600} lineHeight={18}>{u.title}</T>
                  {u.body ? <T size={12.5} lineHeight={18} color={FG2}>{u.body}</T> : null}
                </View>
                <T size={11.5} color={DIM} style={{ paddingTop: 2 }}>{until(u.deliverAt)}</T>
              </View>
            ))}
          </>
        ) : null}

        <View style={st.section}><T size={11.5} color={DIM}>Sent</T></View>
        {/* Only the first load shows a spinner; a refresh keeps the list in place. */}
        {!loaded ? <Spinner /> : null}
        {loaded && items.length === 0 ? (
          <T size={13} lineHeight={19} color={DIM} style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 18 }}>
            Nothing yet. Totem only speaks when it has something specific to say.
          </T>
        ) : null}

        {items.map((item) => (
          <View key={item.id} style={[st.row, !item.read && { backgroundColor: alpha(colors.accent, 0.07) }]}>
            <View style={st.copy}>
              {item.url ? (
                <Press onPress={() => open(item.url!)} accessibilityRole="link">
                  <T size={13.5} weight={600} lineHeight={18}>{item.title}</T>
                </Press>
              ) : (
                <T size={13.5} weight={600} lineHeight={18}>{item.title}</T>
              )}
              {item.body ? <T size={12.5} lineHeight={18} color={FG2}>{item.body}</T> : null}
              <T size={11.5} color={DIM}>
                {when(item.ts)}
                {item.openedAt ? ' · opened' : ''}
                {item.state === 'failed' ? ' · not delivered' : ''}
              </T>

              {rating === item.id ? (
                <View style={st.reasons}>
                  <T size={11.5} color={DIM} style={{ width: '100%' }}>What was wrong with it?</T>
                  {DOWNVOTE_REASONS.map((r) => (
                    <Press key={r.id} disabled={busy} accessibilityHint={r.hint} onPress={() => vote(item, 'down', [r.id])} style={st.chip}>
                      <T size={11.5} color={FG2}>{r.label}</T>
                    </Press>
                  ))}
                  {/* Skipping the detail still records the downvote: a thumb with no
                      reason is worth more than a thumb nobody gave. */}
                  <Press disabled={busy} onPress={() => vote(item, 'down')} style={[st.chip, { borderStyle: 'dashed' }]}>
                    <T size={11.5} color={FG2}>Just less of this</T>
                  </Press>
                </View>
              ) : null}
            </View>

            {item.ratable ? (
              <View style={{ flexDirection: 'row', gap: 2 }}>
                <IconBtn
                  icon={HandThumbUpIcon}
                  size={16}
                  box={34}
                  label="Useful"
                  disabled={busy}
                  color={item.feedback?.vote === 'up' ? colors.accent : colors.muted}
                  onPress={() => vote(item, 'up')}
                />
                <IconBtn
                  icon={HandThumbDownIcon}
                  size={16}
                  box={34}
                  label="Not useful"
                  disabled={busy}
                  color={item.feedback?.vote === 'down' ? colors.red : colors.muted}
                  onPress={() => setRating(rating === item.id ? null : item.id)}
                />
              </View>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

const st = StyleSheet.create({
  section: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 14, paddingHorizontal: 16, paddingBottom: 6 },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    paddingVertical: 11, paddingLeft: 16, paddingRight: 12, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  reasons: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999, backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line },
})
