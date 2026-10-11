// Form pieces the todo sheets share: the dashboard's .field / .field select /
// .todo-inline-error, with native menus standing in for <select> and the
// platform date picker standing in for <input type="date">.
import React, { useState } from 'react'
import { Modal, Pressable, StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { KeyboardAwareScrollView, type KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller'
import { colors, fonts, radius } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, IconBtn, Press } from '../../ui/kit'
import { Hi, CalendarDaysIcon, ChevronDownIcon, XMarkIcon } from '../../lib/icons'
import { tap } from '../../ui/haptics'
import WhenPicker from './WhenPicker'
import { dateKey, localDateTimeKey, parseDateKey } from './format'

// The card palette (styles.css .todo-source / .priority-pN / .todo-due).
export const tone = {
  red: { color: '#ff7f95', borderColor: '#f0506e45', backgroundColor: '#f0506e12' },
  amber: { color: '#efc765', borderColor: '#e3b34145', backgroundColor: '#e3b34112' },
  blue: { color: '#86aaff', borderColor: '#5b8cff45', backgroundColor: '#5b8cff12' },
  grey: { color: '#aeb5c4', borderColor: colors.line, backgroundColor: 'rgba(29, 33, 44, 0.72)' },
  sheet: { color: '#79cf91', borderColor: '#3fb95045', backgroundColor: '#3fb95012' },
  github: { color: '#cbd2e1', borderColor: '#94a3b845', backgroundColor: '#94a3b812' },
} as const
export type Tone = (typeof tone)[keyof typeof tone]

export const STATUS_COLOR = { todo: colors.accent, doing: colors.amber, done: colors.green } as const

/** .field: a muted label over its control. */
export function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ gap: 6, minWidth: 0 }, style]}>
      <T size={12} muted>{label}</T>
      {children}
    </View>
  )
}

/** .field input / textarea. 16px so iOS does not zoom, as the web's phone rules do. */
export const FieldInput = React.forwardRef<TextInput, TextInputProps>(function FieldInput({ style, multiline, ...rest }, ref) {
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.muted}
      selectionColor={colors.accent}
      keyboardAppearance="dark"
      multiline={multiline}
      {...rest}
      style={[st.input, multiline && { minHeight: 88, textAlignVertical: 'top', paddingTop: 11 }, style]}
    />
  )
})

export interface Option<V extends string | number> { value: V; label: string; disabled?: boolean }

/** .field select, as the platform's menu: tap the field, pick a row. */
export function SelectField<V extends string | number>({ value, options, onChange, disabled, placeholder, label, style }: {
  value: V
  options: Option<V>[]
  onChange: (value: V) => void
  disabled?: boolean
  placeholder?: string
  label?: string
  style?: StyleProp<ViewStyle>
}) {
  const current = options.find((option) => option.value === value)
  const actions: MenuAction[] = options.map((option) => ({
    id: String(option.value),
    title: option.label,
    state: option.value === value ? 'on' : 'off',
    attributes: option.disabled ? { disabled: true } : undefined,
  }))
  // An empty menu opens as nothing at all, which reads as a dead control.
  if (!actions.length) actions.push({ id: '', title: 'Nothing to choose yet', attributes: { disabled: true } })
  const body = (
    <View style={[st.select, disabled && { opacity: 0.45 }, style]} accessibilityRole="button" accessibilityLabel={label}>
      <T size={15} numberOfLines={1} style={{ flex: 1 }} color={current ? colors.text : colors.muted}>{current?.label ?? placeholder ?? ''}</T>
      <Hi icon={ChevronDownIcon} size={14} color={colors.muted} />
    </View>
  )
  if (disabled) return body
  return (
    <MenuView
      title={label}
      actions={actions}
      themeVariant="dark"
      onPressAction={({ nativeEvent }) => {
        const picked = nativeEvent.event ? options.find((option) => String(option.value) === nativeEvent.event) : undefined
        if (picked) { tap(); onChange(picked.value) }
      }}
    >
      {body}
    </MenuView>
  )
}

/**
 * A due date ("YYYY-MM-DD") or a snooze/archive time, as the native compact
 * picker. Empty shows a quiet "None" you tap to start from a sensible default.
 */
export function DateField({ value, onChange, mode, emptyLabel = 'None', defaultValue }: {
  value: string
  onChange: (value: string) => void
  mode: 'date' | 'datetime' | 'time'
  emptyLabel?: string
  /** What tapping an empty field starts from. */
  defaultValue?: () => Date
}) {
  const toKey = (next: Date) => mode === 'date' ? dateKey(next) : mode === 'time'
    ? `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
    : localDateTimeKey(next)
  const parsed = !value ? null : mode === 'date' ? parseDateKey(value) : mode === 'time'
    ? (() => { const [h, m] = value.split(':').map(Number); const at = new Date(); at.setHours(h || 0, m || 0, 0, 0); return at })()
    : new Date(value)
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return (
      <Press haptic style={st.select} onPress={() => onChange(toKey(defaultValue ? defaultValue() : new Date()))} accessibilityRole="button">
        <T size={15} muted style={{ flex: 1 }}>{emptyLabel}</T>
        <Hi icon={CalendarDaysIcon} size={16} color={colors.muted} />
      </Press>
    )
  }
  return (
    <View style={[st.select, { paddingVertical: 4, paddingRight: 4 }]}>
      <View style={{ flex: 1, alignItems: 'flex-start' }}>
        <WhenPicker value={parsed} mode={mode} onChange={(next) => onChange(toKey(next))} />
      </View>
      <IconBtn icon={XMarkIcon} size={16} box={34} color={colors.muted} label="Clear" onPress={() => onChange('')} />
    </View>
  )
}

/**
 * "Pick a date and time" from a card menu: the web's little inline form inside the
 * popover, as a bottom sheet with the full calendar.
 */
export function PickWhenSheet({ visible, title, mode, submitLabel, initial, minimum, onSubmit, onClose }: {
  visible: boolean
  title: string
  mode: 'date' | 'datetime'
  submitLabel: string
  initial: Date
  minimum?: Date
  onSubmit: (value: Date) => void
  onClose: () => void
}) {
  const insets = useSafeAreaInsets()
  const [value, setValue] = useState(initial)
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onShow={() => setValue(initial)}>
      <Pressable style={st.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={[st.pickSheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
        <View style={st.pickHead}>
          <T size={17} weight={600}>{title}</T>
          <IconBtn icon={XMarkIcon} size={20} label="Close" onPress={onClose} />
        </View>
        <View style={{ alignItems: 'center' }}>
          <WhenPicker value={value} onChange={setValue} mode={mode} variant="graphical" minimum={minimum} />
        </View>
        <Btn kind="primary" title={submitLabel} onPress={() => onSubmit(value)} style={{ minHeight: 46 }} />
      </View>
    </Modal>
  )
}

export function InlineError({ children }: { children: React.ReactNode }) {
  if (!children) return null
  return <View style={st.error} accessibilityRole="alert"><T size={13} color="#ff9caf">{children}</T></View>
}

export function InlineNotice({ children }: { children: React.ReactNode }) {
  if (!children) return null
  return <View style={st.notice}><T size={13} color="#79cf91">{children}</T></View>
}

/** .modal-head: kicker, title, close. On a phone it stays put over the scrolling form, ruled off below. */
export function SheetHead({ kicker, title, onClose, style }: { kicker: string; title: string; onClose: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[st.head, style]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={11.5} muted style={{ marginBottom: 2 }}>{kicker}</T>
        <T size={18} weight={700} numberOfLines={1}>{title}</T>
      </View>
      <IconBtn icon={XMarkIcon} size={20} label="Close" onPress={onClose} style={{ marginRight: -8 }} />
    </View>
  )
}

/**
 * A task sheet: the fixed head, then the form scrolling under it. The scroll view
 * keeps the focused field above the keyboard (a plain ScrollView's
 * automaticallyAdjustKeyboardInsets does not, inside a form sheet).
 */
export const SheetFrame = React.forwardRef<KeyboardAwareScrollViewRef, {
  kicker: string
  title: string
  onClose: () => void
  children: React.ReactNode
}>(function SheetFrame({ kicker, title, onClose, children }, ref) {
  const insets = useSafeAreaInsets()
  return (
    <View style={st.frame}>
      <SheetHead kicker={kicker} title={title} onClose={onClose} />
      <KeyboardAwareScrollView
        ref={ref}
        style={{ flex: 1 }}
        contentContainerStyle={[st.body, { paddingBottom: Math.max(insets.bottom, 16) + 20 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        bottomOffset={24}
      >
        {children}
      </KeyboardAwareScrollView>
    </View>
  )
})

/** .todo-detail-heading */
export function SectionHead({ title, aside }: { title: string; aside?: string | number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
      <T size={13} weight={600}>{title}</T>
      {aside !== undefined ? <T size={11.5} muted style={{ marginLeft: 'auto' }}>{String(aside)}</T> : null}
    </View>
  )
}

export const st = StyleSheet.create({
  frame: { flex: 1, backgroundColor: colors.bg2 },
  // Room above for the grabber; the rule is inset like the other Productivity sheets'.
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 16, paddingTop: 20, paddingBottom: 10, marginHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  body: { paddingHorizontal: 16, paddingTop: 14, gap: 14 },
  input: {
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm,
    color: colors.text, paddingVertical: 11, paddingHorizontal: 12, fontSize: 16, fontFamily: fonts[400], minHeight: 44,
  },
  select: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: 12,
  },
  error: { padding: 10, borderWidth: 1, borderColor: '#f0506e55', borderRadius: 8, backgroundColor: '#f0506e0f' },
  notice: { padding: 10, borderWidth: 1, borderColor: '#3fb95055', borderRadius: 8, backgroundColor: '#3fb9500f' },
  section: { gap: 9, paddingTop: 13, borderTopWidth: 1, borderTopColor: colors.line },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  pickSheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, gap: 14, padding: 18,
    backgroundColor: colors.bg2, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: 1, borderColor: colors.line,
  },
  pickHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
})
