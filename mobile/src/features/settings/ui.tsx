// Settings' building blocks (styles.css .settings-pane-head, .settings-section-title,
// .setting-row) plus the native pieces the web draws by hand: a <select> is an
// iOS pull-down menu, and a pane is a pushed screen with the system back button.
import React from 'react'
import { Platform, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { MenuView } from '@react-native-menu/menu'
import * as WebBrowser from 'expo-web-browser'
import { colors, fonts, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { Hi, ChevronDownIcon, ArrowTopRightOnSquareIcon } from '../../lib/icons'
import { bridgeUrl } from '../../lib/connection'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { tap } from '../../ui/haptics'

/** Options for a pushed screen: the native header, in the dashboard's colours. */
export function pushedOptions(title: string, backTitle = 'Back') {
  return {
    headerShown: true,
    title,
    headerBackTitle: backTitle,
    headerTintColor: colors.text,
    headerStyle: { backgroundColor: colors.bg },
    headerTitleStyle: { fontFamily: fonts[600], fontSize: 17, color: colors.text },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: colors.bg },
  } as const
}

/** A settings pane's scroll body (.settings-pane: 16px gutters on a phone). */
export function PaneScroll({ children, refreshControl }: { children: React.ReactNode; refreshControl?: React.ReactElement<any> }) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: FAB_CLEARANCE }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      refreshControl={refreshControl}
    >
      {children}
    </ScrollView>
  )
}

/** .settings-pane-head */
export function PaneHead({ title, desc }: { title?: string; desc?: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 8 }}>
      {title ? <T size={18} weight={600} style={{ marginBottom: 5 }}>{title}</T> : null}
      {desc ? <T size={13} muted lineHeight={19}>{desc}</T> : null}
    </View>
  )
}

/** .settings-section-title: a short rule, then the heading. */
export function SectionTitle({ title }: { title: string }) {
  return (
    <View style={st.section}>
      <View style={{ width: 12, height: 1, backgroundColor: colors.line }} />
      <T size={11.5} weight={700} muted>{title}</T>
    </View>
  )
}

/**
 * .setting-list: rows divided by hairlines, the last with none. Each row draws its
 * own rule (rows can come from a component's fragment), and the list clips the
 * last one off by tucking it under its bottom edge.
 */
export function SettingList({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ marginBottom: 8, overflow: 'hidden' }, style]}>
      <View style={{ marginBottom: -1 }}>{children}</View>
    </View>
  )
}

/**
 * .setting-row. Title and hint on the left, control on the right; `stacked` puts
 * the control under the copy, for fields too wide to share a phone's row.
 */
export function SettingRow({ title, desc, children, stacked }: { title: string; desc?: React.ReactNode; children?: React.ReactNode; stacked?: boolean }) {
  return (
    <View style={[st.row, stacked && { flexDirection: 'column', alignItems: 'stretch', gap: 10 }]}>
      <View style={{ flex: stacked ? undefined : 1, minWidth: 0, gap: 2 }}>
        <T size={14} weight={600}>{title}</T>
        {desc ? <T size={12} muted lineHeight={17}>{desc}</T> : null}
      </View>
      {children ? <View style={stacked ? null : { flexShrink: 0, maxWidth: '55%' }}>{children}</View> : null}
    </View>
  )
}

export interface SelectOption { value: string; label: string; disabled?: boolean }

/**
 * The web's <select className="model-select">, as an iOS pull-down menu anchored
 * to the button. The current choice carries the checkmark.
 */
export function Select({ value, options, onChange, disabled, placeholder, style }: {
  value: string
  options: SelectOption[]
  onChange: (v: string) => void
  disabled?: boolean
  placeholder?: string
  style?: StyleProp<ViewStyle>
}) {
  const current = options.find((o) => o.value === value)
  const button = (
    <View style={[st.select, disabled && { opacity: 0.5 }, style]}>
      <T size={13.5} numberOfLines={1} style={{ flexShrink: 1 }}>{current?.label ?? placeholder ?? value}</T>
      <Hi icon={ChevronDownIcon} size={13} color={colors.muted} strokeWidth={2.2} />
    </View>
  )
  if (disabled) return button
  return (
    <MenuView
      shouldOpenOnLongPress={false}
      themeVariant="dark"
      onPressAction={({ nativeEvent }) => { tap(); onChange(nativeEvent.event) }}
      actions={options.map((o) => ({
        id: o.value,
        title: o.label,
        state: o.value === value ? 'on' : 'off',
        attributes: o.disabled ? { disabled: true } : undefined,
      }))}
    >
      {button}
    </MenuView>
  )
}

/** Open a dashboard page in the in-app browser (for what the app does not do yet). */
export function openDashboard(path = '/') {
  WebBrowser.openBrowserAsync(bridgeUrl(path), {
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    controlsColor: colors.accent,
    toolbarColor: colors.bg,
  }).catch(() => {})
}

/** "This pane lives on the web dashboard for now", with a button that opens it there. */
export function WebOnly({ path, what }: { path: string; what: string }) {
  return (
    <View style={st.webOnly}>
      <T size={14} lineHeight={20}>{what} isn’t in the app yet. Open the web dashboard for this.</T>
      <Press haptic onPress={() => openDashboard(path)} style={st.webBtn} accessibilityRole="link">
        <Hi icon={ArrowTopRightOnSquareIcon} size={16} color={colors.accent} />
        <T size={14} weight={600} color={colors.accent}>Open in the web dashboard</T>
      </Press>
    </View>
  )
}

/** A small "Saved." / error line under a form (.text-muted m-0 px-1). */
export function Note({ text, error }: { text?: string; error?: boolean }) {
  if (!text) return null
  return <T size={13} color={error ? colors.red : colors.muted} style={{ paddingHorizontal: 4, paddingVertical: 4 }}>{text}</T>
}

export const st = StyleSheet.create({
  section: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18, marginBottom: 6, marginHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 13, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: colors.line },
  select: {
    flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between',
    minHeight: 36, paddingHorizontal: 12, borderRadius: 8,
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line,
  },
  webOnly: {
    gap: 12, padding: 16, marginTop: 8, borderRadius: 12,
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line,
  },
  webBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: 9,
    backgroundColor: alpha(colors.accent, 0.12), borderWidth: 1, borderColor: alpha(colors.accent, 0.35),
  },
})

export const isIOS = Platform.OS === 'ios'
