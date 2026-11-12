// Settings' building blocks, after iOS Settings rather than the web dialog's look:
// a section is a small heading over one rounded group with an explanation under
// it, and a group is rows split by hairlines, each a title and one line on the
// left and its control on the right. The rows and their ids are the web's
// (web/src/components/settings/ui.tsx), so a search hit or a deep link
// (/settings/<pane>#<row>) scrolls to the same setting.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions,
  type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native'
import { useReducedMotion } from 'react-native-reanimated'
import { MenuView } from '@react-native-menu/menu'
import { useNavigation } from 'expo-router'
import { usePreventRemove } from 'expo-router/react-navigation'
import * as WebBrowser from 'expo-web-browser'
import * as Clipboard from 'expo-clipboard'
import IconCornerUpLeft from '@tabler/icons-react-native/dist/esm/icons/IconCornerUpLeft.mjs'
import { colors, fonts, alpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press, Toggle } from '../../ui/kit'
import { Hi, ChevronDownIcon, ChevronRightIcon, WarnIcon, CheckCircleIcon, InformationCircleIcon } from '../../lib/icons'
import { bridgeUrl } from '../../lib/connection'
import { useSettings } from '../../lib/settings'
import { pushError, pushSuccess } from '../../lib/toast'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { tap } from '../../ui/haptics'
import { confirm } from '../../ui/menu'

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

// ---------------------------------------------------------------------------
// Bringing a row into view
// ---------------------------------------------------------------------------

interface RevealApi {
  target?: string
  reveal: (node: View) => void
}

const Reveal = createContext<RevealApi>({ reveal: () => {} })

/**
 * The ref and highlight for an element a search hit or a link can land on. The
 * pane's data usually loads after it mounts, so the row asks to be revealed
 * when it appears rather than the pane looking for it.
 */
function useStill() {
  const system = useReducedMotion()
  const app = useSettings().reduceMotion
  return system || app
}

function useRevealed(id?: string) {
  const { target, reveal } = useContext(Reveal)
  const ref = useRef<View>(null)
  const [flash, setFlash] = useState(false)
  const still = useStill()
  const hit = !!id && id === target
  useEffect(() => {
    if (!hit) return
    const t = setTimeout(() => { if (ref.current) reveal(ref.current) }, 120)
    if (still) return () => clearTimeout(t)
    setFlash(true)
    const off = setTimeout(() => setFlash(false), 1600)
    return () => { clearTimeout(t); clearTimeout(off) }
  }, [hit, reveal, still])
  return { ref, flash }
}

/** A settings pane's scroll body. `target` is a row or section id to bring into view. */
export function PaneScroll({ children, refreshControl, target }: { children: React.ReactNode; refreshControl?: React.ReactElement<any>; target?: string }) {
  const scroll = useRef<ScrollView>(null)
  const inner = useRef<View>(null)
  const done = useRef(false)
  const still = useStill()
  const stillRef = useRef(still)
  stillRef.current = still
  // A new target (a "Needs you" item, another link) may be revealed again.
  useEffect(() => { done.current = false }, [target])
  // Stable while the target is, so a settings change re-renders no row and flashes nothing again.
  const value = useMemo<RevealApi>(() => ({
    target,
    reveal: (node: View) => {
      if (done.current || !inner.current) return
      done.current = true
      node.measureLayout(inner.current as any, (_x, y) => {
        scroll.current?.scrollTo({ y: Math.max(0, y - 96), animated: !stillRef.current })
      }, () => { done.current = false })
    },
  }), [target])
  return (
    <ScrollView
      ref={scroll}
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: FAB_CLEARANCE }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      refreshControl={refreshControl}
    >
      <Reveal.Provider value={value}>
        <View ref={inner} collapsable={false}>{children}</View>
      </Reveal.Provider>
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------
// Sections and rows
// ---------------------------------------------------------------------------

/**
 * A heading over one rounded group, the explanation under it as iOS puts a
 * group's footer. `plain` children draw their own surface (cards, a chart).
 */
export function Section({ id, title, description, action, plain, footer, children }: {
  id?: string
  title?: React.ReactNode
  /** One or two lines under the group. */
  description?: React.ReactNode
  /** Right of the heading: a count, a refresh, an Add. */
  action?: React.ReactNode
  plain?: boolean
  /** Anything under the description (a saved note, an error). */
  footer?: React.ReactNode
  children?: React.ReactNode
}) {
  const { ref, flash } = useRevealed(id)
  return (
    <View ref={ref} collapsable={false} style={st.section}>
      {title || action ? (
        <View style={st.sectionHead}>
          {title ? <T size={12.5} weight={600} muted style={st.sectionTitle} accessibilityRole="header">{title}</T> : <View style={{ flex: 1 }} />}
          {action ? <View style={st.sectionAction}>{action}</View> : null}
        </View>
      ) : null}
      {plain ? children : <Group flash={flash}>{children}</Group>}
      {description ? (typeof description === 'string'
        ? <T size={12.5} muted lineHeight={17} style={st.footer}>{description}</T>
        : <View style={st.footerBox}>{description}</View>) : null}
      {footer ? <View style={st.footerBox}>{footer}</View> : null}
    </View>
  )
}

/**
 * One rounded group of rows. Each row draws its own bottom hairline (rows can
 * come from fragments), and the group tucks the last one under its edge.
 */
export function Group({ children, flash, style }: { children: React.ReactNode; flash?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[st.group, flash && st.flash, style]}>
      <View style={{ marginBottom: -StyleSheet.hairlineWidth }}>{children}</View>
    </View>
  )
}

/**
 * A row. Title and one line of description on the left, the control on the
 * right; `stacked` puts the control under the copy, for fields too wide to share
 * a phone's row. `onPress` makes the copy (with its `accessory`, the value and
 * the chevron) a button; a `control` and `children` stay outside it, so a tap
 * inside an open form never folds its row and VoiceOver reaches each control on
 * its own. The parts of the button dim together, as one iOS cell does.
 */
export function Row({ id, title, description, status, control, accessory, onReset, stacked, onPress, chevron, value, tone, icon, disabled, accessibilityLabel, children }: {
  id?: string
  title: React.ReactNode
  description?: React.ReactNode
  /** A short live reading under the description (a test result, "Saved"). */
  status?: React.ReactNode
  /** Something to act on (a switch, a button, a picker): never part of the row's own press. */
  control?: React.ReactNode
  /** Something to read (a status pill, a caret): part of the row's press when it has one. */
  accessory?: React.ReactNode
  /** Shown only when the value differs from its default. */
  onReset?: () => void
  stacked?: boolean
  onPress?: () => void
  chevron?: boolean
  /** Muted text on the right, iOS's "detail" (a current value). */
  value?: React.ReactNode
  /** The title in red (a destructive row) or the accent (an action row). */
  tone?: 'danger' | 'accent'
  /** A glyph left of the title. */
  icon?: React.ReactNode
  disabled?: boolean
  /** What VoiceOver reads for a tappable row; left out, it reads all the row's text. */
  accessibilityLabel?: string
  /** Anything below the row's head, full width. */
  children?: React.ReactNode
}) {
  const { ref, flash } = useRevealed(id)
  const [pressed, setPressed] = useState(false)
  const label = accessibilityLabel ?? (typeof title === 'string' ? title : undefined)
  const titleColor = tone === 'danger' ? colors.red : tone === 'accent' ? colors.accent : undefined
  const copy = (
    <View style={{ flex: stacked ? undefined : 1, minWidth: 0, gap: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon}
        {typeof title === 'string'
          ? <T size={15} weight={500} color={titleColor} style={{ flexShrink: 1 }}>{title}</T>
          : <View style={{ flexShrink: 1 }}>{title}</View>}
        {onReset ? (
          <Press haptic onPress={onReset} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Reset ${label || 'setting'} to default`} style={st.reset}>
            <Hi icon={IconCornerUpLeft} size={13} color={colors.muted} />
          </Press>
        ) : null}
      </View>
      {description ? (typeof description === 'string'
        ? <T size={12.5} muted lineHeight={17}>{description}</T>
        : description) : null}
      {status ? (typeof status === 'string' ? <T size={12.5} lineHeight={17}>{status}</T> : status) : null}
    </View>
  )
  const detail = value != null || chevron ? (
    <>
      {value != null ? (typeof value === 'string' ? <T size={14} muted numberOfLines={1}>{value}</T> : value) : null}
      {chevron ? <Hi icon={ChevronRightIcon} size={15} color={colors.muted} strokeWidth={2} /> : null}
    </>
  ) : null
  const press = (child: React.ReactNode, style: StyleProp<ViewStyle>, a11y: boolean) => onPress ? (
    <Pressable
      onPress={() => { tap(); onPress() }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      disabled={disabled}
      accessible={a11y}
      accessibilityRole={a11y ? 'button' : undefined}
      // Unnamed, iOS reads every text in the cell, the pill and the value included,
      // as a table cell does; a title alone would hide them.
      accessibilityLabel={a11y ? accessibilityLabel : undefined}
      accessibilityState={a11y ? { disabled: !!disabled } : undefined}
      style={[style, pressed && !disabled && { opacity: 0.6 }, disabled && { opacity: 0.45 }]}
    >{child}</Pressable>
  ) : <View style={style}>{child}</View>
  const lead = accessory ? <>{copy}<View style={st.accessory}>{accessory}</View></> : copy
  return (
    <View ref={ref} collapsable={false} style={[st.row, flash && st.flash]}>
      <View style={[st.rowHead, stacked && st.rowStacked]}>
        {/* Without a control in between, the value and chevron are the same button as the copy. */}
        {!control && detail
          ? press(<>{lead}<View style={st.detail}>{detail}</View></>, st.copyRow, true)
          : press(lead, stacked ? st.copyStacked : accessory ? st.copyRow : st.copy, true)}
        {control ? <View style={stacked ? st.controlStacked : st.control}>{control}</View> : null}
        {/* Past a control the chevron is its own target, but not a second stop for VoiceOver. */}
        {control && detail ? press(detail, st.detail, false) : null}
      </View>
      {children ? <View style={{ paddingBottom: 12 }}>{children}</View> : null}
    </View>
  )
}

/** The settings switch: the platform's own control. */
export function Switch({ value, onChange, disabled, label }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <Toggle value={value} onChange={onChange} disabled={disabled} label={label} />
}

/** A callout inside a pane: why something is off, what to do about it. */
export function Notice({ tone = 'info', children, style }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = tone === 'ok' ? colors.green : tone === 'error' ? colors.red : tone === 'warn' ? colors.amber : colors.accent
  return (
    <View
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      style={[{ flexDirection: 'row', gap: 9, padding: 12, marginBottom: 16, borderRadius: 12, backgroundColor: alpha(c, 0.08), borderWidth: 1, borderColor: alpha(c, 0.3) }, style]}
    >
      {tone === 'ok' ? <Hi icon={CheckCircleIcon} size={16} color={colors.green} />
        : tone === 'info' ? <Hi icon={InformationCircleIcon} size={16} color={colors.accent} />
          : <WarnIcon />}
      <View style={{ flex: 1, gap: 8 }}>{typeof children === 'string' ? <T size={13} lineHeight={19}>{children}</T> : children}</View>
    </View>
  )
}

/** A pane still loading, or one that could not load. */
export function Loading({ error, label }: { error?: string; label?: string }) {
  return <T size={14} color={error ? colors.red : colors.muted} style={{ paddingVertical: 24, textAlign: 'center' }}>{error || label || 'Loading…'}</T>
}

/** A small "Saved." / error line under a form. */
export function Note({ text, error, style }: { text?: string | null; error?: boolean; style?: StyleProp<ViewStyle> }) {
  if (!text) return null
  return <T size={13} lineHeight={18} color={error ? colors.red : colors.muted} style={[{ paddingHorizontal: 4, paddingVertical: 4 }, style as any]}>{text}</T>
}

/** A status chip (the web's .pill). */
export function Pill({ label, tone }: { label: string; tone?: 'ok' | 'warn' | 'error' }) {
  const c = tone === 'ok' ? colors.green : tone === 'warn' ? colors.amber : tone === 'error' ? colors.red : colors.muted
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: alpha(c, 0.14), borderWidth: 1, borderColor: alpha(c, 0.35) }}>
      <T size={11.5} weight={600} color={c}>{label}</T>
    </View>
  )
}

/** A text field in a settings row. */
export const Field = React.forwardRef<TextInput, TextInputProps & { mono?: boolean }>(function Field({ style, mono, ...props }, ref) {
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.muted}
      selectionColor={colors.accent}
      keyboardAppearance="dark"
      autoCapitalize="none"
      autoCorrect={false}
      {...props}
      style={[st.field, mono && { fontFamily: fonts.mono, fontSize: 13.5 }, props.multiline && { minHeight: 96, paddingTop: 10, textAlignVertical: 'top' }, style]}
    />
  )
})

/** Monospace text on a dark chip (a variable name, a command). */
export function Code({ children, selectable = true }: { children: React.ReactNode; selectable?: boolean }) {
  return (
    <View style={st.code}>
      <T size={12.5} selectable={selectable} style={{ fontFamily: fonts.mono }}>{children}</T>
    </View>
  )
}

/**
 * Ask before leaving a screen with unsaved edits: Back, and the edge swipe,
 * which the native stack holds while this is on. A long prompt is a lot to lose
 * to one swipe.
 */
export function useDiscardGuard(dirty: boolean) {
  const navigation = useNavigation()
  usePreventRemove(dirty, ({ data }) => {
    void confirm('Discard your changes?', { message: 'What you changed here is not saved.', confirmLabel: 'Discard' })
      .then((ok) => { if (ok) navigation.dispatch(data.action) })
  })
}

/** Copy to the clipboard and say so. */
export async function copy(text: string, what = 'Copied') {
  try {
    await Clipboard.setStringAsync(text)
    pushSuccess(what)
  } catch {
    pushError('Could not copy that.')
  }
}

export interface SelectOption { value: string; label: string; disabled?: boolean }

/**
 * The web's <select>, as an iOS pull-down menu anchored to the button. The
 * current choice carries the checkmark. `groups` draws headed sections, as an
 * <optgroup> does.
 */
export function Select({ value, options, groups, onChange, disabled, placeholder, style, label, inline }: {
  value: string
  options?: SelectOption[]
  groups?: { title?: string; options: SelectOption[] }[]
  onChange: (v: string) => void
  disabled?: boolean
  placeholder?: string
  style?: StyleProp<ViewStyle>
  label?: string
  /** iOS's in-row picker: the value and a chevron, no box. Settings rows use `Picker`. */
  inline?: boolean
}) {
  const all = groups ? groups.flatMap((g) => g.options) : options || []
  const current = all.find((o) => o.value === value)
  const { width } = useWindowDimensions()
  const button = (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={label ? `${label}: ${current?.label ?? placeholder ?? value}` : undefined}
      accessibilityState={{ disabled: !!disabled }}
      style={[inline ? [st.picker, { maxWidth: Math.round(width * 0.5) }] : st.select, disabled && { opacity: 0.5 }, style]}
    >
      <T size={inline ? 14 : 13.5} muted={inline} numberOfLines={1} style={{ flexShrink: 1 }}>{current?.label ?? placeholder ?? value}</T>
      <Hi icon={ChevronDownIcon} size={13} color={colors.muted} strokeWidth={2.2} />
    </View>
  )
  if (disabled) return button
  const action = (o: SelectOption) => ({
    id: o.value,
    title: o.label,
    state: (o.value === value ? 'on' : 'off') as 'on' | 'off',
    attributes: o.disabled ? { disabled: true } : undefined,
  })
  return (
    <MenuView
      shouldOpenOnLongPress={false}
      themeVariant="dark"
      title={label}
      onPressAction={({ nativeEvent }) => { tap(); onChange(nativeEvent.event) }}
      actions={groups
        // One level of submenu only (Fabric drops deeper ones); inline groups keep it flat.
        ? groups.map((g, i) => ({ id: `group-${i}`, title: g.title || '', displayInline: true, subactions: g.options.map(action) }))
        : all.map(action)}
    >
      {button}
    </MenuView>
  )
}

/** The picker on the right of a settings row. */
export function Picker(props: Omit<React.ComponentProps<typeof Select>, 'inline'>) {
  return <Select {...props} inline />
}

/** Open a dashboard page in the in-app browser (a sign-in the phone cannot finish itself). */
export function openDashboard(path = '/') {
  WebBrowser.openBrowserAsync(bridgeUrl(path), {
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    controlsColor: colors.accent,
    toolbarColor: colors.bg,
  }).catch(() => {})
}

/** Button-shaped text links in a row's description ("Providers › API keys"). */
export function Link({ title, onPress }: { title: string; onPress: () => void }) {
  return <T size={12.5} weight={600} color={colors.accent} onPress={() => { tap(); onPress() }} accessibilityRole="link" suppressHighlighting>{title}</T>
}

export const st = StyleSheet.create({
  section: { marginBottom: 24 },
  sectionHead: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, minHeight: 22, marginBottom: 7, paddingHorizontal: 14 },
  sectionTitle: { flex: 1, textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 12 },
  sectionAction: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  footer: { marginTop: 7, paddingHorizontal: 14 },
  footerBox: { marginTop: 7, paddingHorizontal: 14, gap: 4 },
  group: { backgroundColor: colors.bg2, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: 'hidden' },
  flash: { backgroundColor: alpha(colors.accent, 0.14) },
  // The vertical padding lives in the row's parts, so the whole height of the copy is its tap target.
  row: { paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, minHeight: 48, justifyContent: 'center' },
  rowHead: { flexDirection: 'row', alignItems: 'stretch', gap: 12 },
  rowStacked: { flexDirection: 'column', gap: 10, paddingBottom: 12 },
  copy: { flex: 1, minWidth: 0, paddingVertical: 12, justifyContent: 'center' },
  copyStacked: { paddingTop: 12 },
  copyRow: { flex: 1, minWidth: 0, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  accessory: { flexShrink: 0, maxWidth: '45%', flexDirection: 'row', alignItems: 'center', gap: 8 },
  control: { flexShrink: 0, maxWidth: '58%', flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 8 },
  controlStacked: {},
  detail: { flexShrink: 0, maxWidth: '45%', flexDirection: 'row', alignItems: 'center', gap: 8 },
  reset: { padding: 2 },
  field: {
    minHeight: 40, paddingHorizontal: 12, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
    backgroundColor: colors.bg, color: colors.text, fontFamily: fonts[400], fontSize: 15,
  },
  code: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7, backgroundColor: colors.bg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  select: {
    flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between',
    minHeight: 36, paddingHorizontal: 12, borderRadius: 8,
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line,
  },
  picker: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'flex-end', minHeight: 44, paddingLeft: 12 },
})
