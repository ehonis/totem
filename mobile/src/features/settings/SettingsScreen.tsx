// Settings: the web's sections in its groups, as an iOS grouped list. Each row
// pushes its pane (SettingsPaneScreen); the search field on top finds a single
// setting and opens its pane scrolled to it, as the web's search does.
import React, { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import IconSearch from '@tabler/icons-react-native/dist/esm/icons/IconSearch.mjs'
import { useConnection } from '../../lib/connection'
import { Hi, ChevronRightIcon, ArrowTopRightOnSquareIcon, XMarkIcon, type IconType } from '../../lib/icons'
import { SETTINGS_LABELS } from '../../lib/components/settings/sections'
import { Screen, FAB_CLEARANCE } from '../../shell/Screen'
import { colors, fonts, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Badge, Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { PANE_GROUPS, paneById } from './panes'
import { searchAppSettings } from './search'
import { useUnreadCount } from '../notifications/useUnread'
import { openDashboard } from './ui'
import { openPane } from './open'


function Row({ icon, label, detail, last, count, onPress, external }: {
  icon: IconType
  label: string
  detail?: string
  last: boolean
  count?: number
  onPress: () => void
  external?: boolean
}) {
  return (
    <Press onPress={() => { tap(); onPress() }} accessibilityRole={external ? 'link' : 'button'} style={st.row}>
      <View style={st.icon}><Hi icon={icon} size={17} color={textAlpha(85)} strokeWidth={1.75} /></View>
      <View style={[st.rowBody, !last && st.rule]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={16}>{label}</T>
          {detail ? <T size={12} muted numberOfLines={1}>{detail}</T> : null}
        </View>
        <Badge count={count} />
        <Hi icon={external ? ArrowTopRightOnSquareIcon : ChevronRightIcon} size={15} color={colors.muted} strokeWidth={2} />
      </View>
    </Press>
  )
}

export default function SettingsScreen() {
  const { sub, row } = useLocalSearchParams<{ sub?: string; row?: string }>()
  const conn = useConnection()
  // The unread count the drawer's gear dots for, on the row that clears it.
  const unread = useUnreadCount()
  const [query, setQuery] = useState('')
  const results = useMemo(() => searchAppSettings(query), [query])
  const searching = query.trim().length > 0

  // A deep link to a pane (navigateTo({ tab: 'settings', sub, hash })) lands here first.
  useEffect(() => {
    if (sub && paneById(sub)) {
      router.setParams({ sub: undefined, row: undefined })
      openPane(sub, row)
    }
  }, [sub, row])

  return (
    <Screen title="Settings" glow="settings">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: FAB_CLEARANCE }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={st.search}>
          <Hi icon={IconSearch} size={16} color={colors.muted} strokeWidth={1.75} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search settings"
            placeholderTextColor={colors.muted}
            selectionColor={colors.accent}
            keyboardAppearance="dark"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="never"
            accessibilityLabel="Search settings"
            style={st.searchInput}
            onSubmitEditing={() => { const r = results[0]; if (r) openPane(r.section, r.id === r.section ? null : r.id) }}
          />
          {searching ? (
            <Press onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
              <Hi icon={XMarkIcon} size={16} color={colors.muted} />
            </Press>
          ) : null}
        </View>

        {searching ? (
          results.length ? (
            <View style={st.group}>
              {results.map((r, i) => {
                const pane = paneById(r.section)
                return pane ? (
                  <Row
                    key={r.key}
                    icon={pane.icon}
                    label={r.title}
                    detail={`${SETTINGS_LABELS[r.section]}${r.where ? ` › ${r.where}` : ''}`}
                    last={i === results.length - 1}
                    onPress={() => openPane(r.section, r.id === r.section ? null : r.id)}
                  />
                ) : null
              })}
            </View>
          ) : <T muted style={{ textAlign: 'center', paddingVertical: 24 }}>No settings match “{query.trim()}”.</T>
        ) : (
          <>
            {PANE_GROUPS.map((g) => (
              <View key={g.heading || 'top'} style={{ marginBottom: 22 }}>
                {g.heading ? <T size={12} muted weight={600} style={st.groupTitle} accessibilityRole="header">{g.heading}</T> : null}
                <View style={st.group}>
                  {g.panes.map((p, i) => (
                    <Row
                      key={p.id}
                      icon={p.icon}
                      label={p.label}
                      last={i === g.panes.length - 1}
                      count={p.id === 'notification-history' ? unread : undefined}
                      onPress={() => openPane(p.id)}
                    />
                  ))}
                </View>
              </View>
            ))}
            <View style={st.group}>
              <Row
                icon={ArrowTopRightOnSquareIcon}
                label="Open the web dashboard"
                detail={conn.baseUrl.replace(/^https?:\/\//, '')}
                last
                external
                onPress={() => openDashboard('/settings')}
              />
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  )
}

const st = StyleSheet.create({
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, paddingHorizontal: 11, marginBottom: 18,
    borderRadius: 10, backgroundColor: colors.bg2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
  },
  searchInput: { flex: 1, color: colors.text, fontFamily: fonts[400], fontSize: 16, paddingVertical: 0 },
  groupTitle: { marginLeft: 16, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  group: { backgroundColor: colors.bg2, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14 },
  icon: { width: 30, height: 30, borderRadius: 8, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  rowBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 50, paddingRight: 14, paddingVertical: 6 },
  rule: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
})
