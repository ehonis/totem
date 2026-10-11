// The frame the Calendar and Journal sheets share: the web's phone `.event-modal`
// (styles.css, @media max-width 720px) as a form sheet. The head (kicker, title,
// close) stays put with a rule under it while the fields scroll; the actions share
// the last row at full thumb height; and the scroll view keeps the focused field
// above the keyboard, which ScrollView's own keyboard insets don't do reliably
// inside a formSheet.
import React from 'react'
import { StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { IconBtn } from '../../ui/kit'
import { XMarkIcon } from '../../lib/icons'

export function SheetFrame({ kicker, title, onClose, children, actions }: {
  kicker: string
  title: string
  onClose: () => void
  children: React.ReactNode
  /** The .modal-actions buttons; each gets an equal share of the row. */
  actions?: React.ReactNode
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={st.sheet}>
      <View style={st.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={11.5} muted numberOfLines={1} style={{ marginBottom: 2 }}>{kicker}</T>
          <T size={18} weight={700} numberOfLines={2}>{title}</T>
        </View>
        <IconBtn icon={XMarkIcon} size={20} label="Close" onPress={onClose} style={{ marginTop: -6, marginRight: -8 }} />
      </View>
      <KeyboardAwareScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[st.body, { paddingBottom: Math.max(insets.bottom, 12) + 16 }]}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
      >
        {children}
        {actions ? <View style={st.actions}>{actions}</View> : null}
      </KeyboardAwareScrollView>
    </View>
  )
}

/** .field: a muted label over its control, with optional help under it. */
export function Field({ label, help, children, style }: { label: string; help?: string; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ gap: 6 }, style]}>
      <T size={12} muted>{label}</T>
      {children}
      {help ? <T size={11.5} muted lineHeight={17}>{help}</T> : null}
    </View>
  )
}

/** .field input / textarea at phone size (16px, so iOS never zooms). */
export const FieldInput = React.forwardRef<TextInput, TextInputProps>(function FieldInput({ style, multiline, ...rest }, ref) {
  return (
    <TextInput
      ref={ref}
      multiline={multiline}
      placeholderTextColor={colors.muted}
      keyboardAppearance="dark"
      selectionColor={colors.accent}
      {...rest}
      style={[st.input, multiline && st.textarea, style]}
    />
  )
})

/** A button's share of the actions row (.modal-actions .btn on a phone). */
export const actionStyle: ViewStyle = { flexGrow: 1, flexBasis: 120, minHeight: 44 }

const st = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.bg2 },
  // Room above for the sheet's grabber.
  head: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 16,
    paddingTop: 20, paddingBottom: 10, marginHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  body: { paddingHorizontal: 16, paddingTop: 14, gap: 14 },
  input: {
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: 8, minHeight: 44,
    color: colors.text, paddingVertical: 11, paddingHorizontal: 12, fontSize: 16, fontFamily: fonts[400],
  },
  textarea: { minHeight: 88, textAlignVertical: 'top', lineHeight: 22 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
})
