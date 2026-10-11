// The dashboard's dialog furniture (.event-modal, .modal-head, .field, .field-row,
// .checkbox-field, .modal-actions, .cal-viewswitch) as native pieces, shared by the
// habit and goal sheets. On a phone the web already draws these dialogs as bottom
// sheets, so here each one is a formSheet route wearing the same head and fields.
import React from 'react'
import { Platform, StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { IconBtn, Press } from '../../ui/kit'
import { Hi, CheckIcon, ChevronDownIcon, XMarkIcon } from '../../lib/icons'
import { showMenu } from '../../ui/menu'
import { tap } from '../../ui/haptics'

export const closeSheet = () => { if (router.canGoBack()) router.back() }

/**
 * A formSheet's body with the web dialog's head: kicker, title, close. The sheet
 * itself (presentation, detents) is declared on its route in app/_layout.tsx.
 */
export function Sheet({ kicker, title, children, footer }: {
  kicker?: React.ReactNode
  title: string
  children: React.ReactNode
  /** .modal-actions, under the fields. */
  footer?: React.ReactNode
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg2 }}>
      <View style={f.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {kicker ? (typeof kicker === 'string' ? <T size={11.5} muted style={{ marginBottom: 2 }}>{kicker}</T> : kicker) : null}
          <T size={18} weight={700}>{title}</T>
        </View>
        <IconBtn icon={XMarkIcon} size={20} box={36} color={colors.muted} label="Close" onPress={closeSheet} />
      </View>
      {/* Keyboard-aware rather than automaticallyAdjustKeyboardInsets, which does
          not keep the focused field visible inside a form sheet. */}
      <KeyboardAwareScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[f.body, { paddingBottom: Math.max(insets.bottom, 16) + 24 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        bottomOffset={24}
      >
        {children}
        {footer ? <View style={f.actions}>{footer}</View> : null}
      </KeyboardAwareScrollView>
    </View>
  )
}

/** .field: a muted caption over its control. */
export function Field({ label, hint, children, style }: { label?: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ gap: 6 }, style]}>
      {label ? (typeof label === 'string' ? <T size={12} muted>{label}</T> : label) : null}
      {children}
      {hint ? <T size={11} muted>{hint}</T> : null}
    </View>
  )
}

/** .field-row: fields side by side. */
export function FieldRow({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', gap: 12 }}>{React.Children.map(children, (c) => c ? <View style={{ flex: 1, minWidth: 0 }}>{c}</View> : null)}</View>
}

/** .field input — 16px so iOS never zooms, the web's own phone rule. */
export const FieldInput = React.forwardRef<TextInput, TextInputProps>(function FieldInput({ style, multiline, ...rest }, ref) {
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.muted}
      selectionColor={colors.accent}
      keyboardAppearance="dark"
      multiline={multiline}
      {...rest}
      style={[f.input, multiline && { minHeight: 72, textAlignVertical: 'top', paddingTop: 9 }, style]}
    />
  )
})

export interface SelectOption<V extends string> { value: V; label: string; group?: string }

/**
 * A native <select>: the iOS menu, anchored to the field, with a tick on the
 * current choice. Grouped options become inline sections (the web's <optgroup>).
 */
export function Select<V extends string>({ value, options, onChange, label, style }: {
  value: V
  options: SelectOption<V>[]
  onChange: (v: V) => void
  label: string
  style?: StyleProp<ViewStyle>
}) {
  const current = options.find((o) => o.value === value)
  const field = (
    <View style={[f.input, f.select, style]} accessibilityRole="button" accessibilityLabel={label}>
      <T size={15} numberOfLines={1} style={{ flex: 1 }}>{current?.label ?? ''}</T>
      <Hi icon={ChevronDownIcon} size={14} color={colors.muted} />
    </View>
  )
  if (Platform.OS !== 'ios') {
    return (
      <Press onPress={() => showMenu(options.map((o) => ({ label: o.label, onPress: () => onChange(o.value) })), { title: label })}>
        {field}
      </Press>
    )
  }
  const action = (o: SelectOption<V>): MenuAction => ({ id: o.value || '__empty', title: o.label, state: o.value === value ? 'on' : 'off' })
  const actions: MenuAction[] = []
  const groups = new Map<string, MenuAction[]>()
  for (const o of options) {
    if (!o.group) { actions.push(action(o)); continue }
    if (!groups.has(o.group)) {
      const list: MenuAction[] = []
      groups.set(o.group, list)
      actions.push({ id: `group:${o.group}`, title: o.group, displayInline: true, subactions: list })
    }
    groups.get(o.group)!.push(action(o))
  }
  return (
    <MenuView
      title={label}
      actions={actions}
      themeVariant="dark"
      onPressAction={({ nativeEvent }) => { tap(); onChange((nativeEvent.event === '__empty' ? '' : nativeEvent.event) as V) }}
    >
      {field}
    </MenuView>
  )
}

/** .checkbox-field: a tick box and its sentence; the whole row toggles. */
export function CheckField({ value, onChange, children }: { value: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <Press haptic onPress={() => onChange(!value)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
      <View style={[f.box, value && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
        {value ? <Hi icon={CheckIcon} size={13} color={colors.white} strokeWidth={3} /> : null}
      </View>
      <T size={14} style={{ flex: 1 }}>{children}</T>
    </Press>
  )
}

/** .cal-viewswitch with .seg buttons: the small two- or three-way switch. */
export function SegSwitch<V extends string>({ options, value, onChange, small }: {
  options: { value: V; label: string }[]
  value: V
  onChange: (v: V) => void
  small?: boolean
}) {
  return (
    <View style={f.segWrap}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <Press key={o.value} haptic onPress={() => onChange(o.value)} style={[f.seg, small && { paddingVertical: 3, paddingHorizontal: 9 }, on && { backgroundColor: colors.bg3 }]}>
            <T size={small ? 11 : 12} color={on ? colors.text : colors.muted}>{o.label}</T>
          </Press>
        )
      })}
    </View>
  )
}

export const f = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 16,
    paddingHorizontal: 14, paddingTop: 22, paddingBottom: 10, backgroundColor: colors.bg2,
  },
  body: { paddingHorizontal: 14, paddingTop: 4, gap: 13 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  input: {
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: 8,
    color: colors.text, paddingVertical: 9, paddingHorizontal: 10, fontSize: 16, fontFamily: fonts[400], minHeight: 42,
  },
  select: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  box: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: '#3a4152', alignItems: 'center', justifyContent: 'center' },
  segWrap: { flexDirection: 'row', backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 9, padding: 2 },
  seg: { paddingVertical: 5, paddingHorizontal: 12, borderRadius: 7 },
})
