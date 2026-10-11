// Settings. The web shows its sub-tabs as a strip over the pane; on a phone this
// is the iOS grouped list instead, each row pushing its pane (SettingsPaneScreen).
import React, { useEffect } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useConnection } from '../../lib/connection'
import { Hi, ChevronRightIcon, ArrowTopRightOnSquareIcon } from '../../lib/icons'
import { Screen, FAB_CLEARANCE } from '../../shell/Screen'
import { colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Badge, Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { PANES, paneById, type Pane } from './panes'
import { useUnreadCount } from '../notifications/useUnread'
import { openDashboard } from './ui'

export function openPane(id: string) {
  router.push({ pathname: '/settings/[pane]', params: { pane: id } })
}

function Row({ pane, last, count }: { pane: Pane; last: boolean; count?: number }) {
  return (
    <Press onPress={() => { tap(); openPane(pane.id) }} accessibilityRole="button" style={st.row}>
      <View style={st.icon}><Hi icon={pane.icon} size={17} color={textAlpha(85)} /></View>
      <View style={[st.rowBody, !last && st.rule]}>
        <T size={16} style={{ flex: 1 }}>{pane.label}</T>
        {pane.web ? <T size={13} muted>Web</T> : null}
        <Badge count={count} />
        <Hi icon={ChevronRightIcon} size={15} color={colors.muted} strokeWidth={2} />
      </View>
    </Press>
  )
}

function Group({ title, panes, counts }: { title?: string; panes: Pane[]; counts?: Record<string, number> }) {
  return (
    <View style={{ marginBottom: 22 }}>
      {title ? <T size={13} muted style={st.groupTitle}>{title}</T> : null}
      <View style={st.group}>
        {panes.map((p, i) => <Row key={p.id} pane={p} last={i === panes.length - 1} count={counts?.[p.id]} />)}
      </View>
    </View>
  )
}

export default function SettingsScreen() {
  const { sub } = useLocalSearchParams<{ sub?: string }>()
  const conn = useConnection()
  // The unread count the drawer's gear dots for, on the row that clears it.
  const unread = useUnreadCount()

  // A deep link to a pane (navigateTo({ tab: 'settings', sub })) lands here first.
  useEffect(() => {
    if (sub && paneById(sub)) {
      router.setParams({ sub: undefined })
      openPane(sub)
    }
  }, [sub])

  return (
    <Screen title="Settings" glow="settings">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: FAB_CLEARANCE }}>
        <Group panes={PANES.filter((p) => p.group === 0)} counts={{ 'notification-history': unread }} />
        <Group title="AI workshop" panes={PANES.filter((p) => p.group === 1)} />
        <View style={st.group}>
          <Press onPress={() => { tap(); openDashboard('/settings') }} accessibilityRole="link" style={st.row}>
            <View style={st.icon}><Hi icon={ArrowTopRightOnSquareIcon} size={17} color={textAlpha(85)} /></View>
            <View style={st.rowBody}>
              <View style={{ flex: 1 }}>
                <T size={16}>Open the web dashboard</T>
                <T size={12} muted numberOfLines={1}>{conn.baseUrl.replace(/^https?:\/\//, '')}</T>
              </View>
            </View>
          </Press>
        </View>
      </ScrollView>
    </Screen>
  )
}

const st = StyleSheet.create({
  groupTitle: { marginLeft: 16, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 12 },
  group: { backgroundColor: colors.bg2, borderRadius: 12, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14 },
  icon: { width: 30, height: 30, borderRadius: 8, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  rowBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 50, paddingRight: 14 },
  rule: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
})
