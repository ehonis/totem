// The dashboard's small building blocks (styles.css: .btn, .card, .seg, .chip,
// .empty, …) as native components. Views compose these rather than restyling
// Pressables by hand, so a tap target feels the same everywhere.
import React from 'react'
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, TextInput, View,
  type PressableProps, type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native'
import { colors, radius, alpha, fonts, textAlpha } from '../theme'
import { Hi, type IconType } from '../lib/icons'
import { T } from './Text'
import { tap } from './haptics'

/** A Pressable that dims when held, the native stand-in for :hover/:active. */
export function Press({ style, haptic, onPress, ...rest }: PressableProps & { style?: StyleProp<ViewStyle>; haptic?: boolean }) {
  return (
    <Pressable
      {...rest}
      onPress={(e) => { if (haptic) tap(); onPress?.(e) }}
      style={({ pressed }) => [style, pressed && !rest.disabled ? { opacity: 0.6 } : null, rest.disabled ? { opacity: 0.45 } : null]}
    />
  )
}

type BtnKind = 'default' | 'primary' | 'danger' | 'ghost' | 'on'

/** .btn and its variants. */
export function Btn({ title, icon, kind = 'default', compact, onPress, disabled, loading, style, children }: {
  title?: string
  icon?: IconType
  kind?: BtnKind
  compact?: boolean
  onPress?: () => void
  disabled?: boolean
  loading?: boolean
  style?: StyleProp<ViewStyle>
  children?: React.ReactNode
}) {
  const fg = kind === 'primary' ? colors.white : kind === 'danger' ? '#f0879e' : colors.text
  return (
    <Press
      haptic
      onPress={onPress}
      disabled={disabled || loading}
      style={[s.btn, compact && s.btnCompact, kindStyle[kind], style]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : icon ? <Hi icon={icon} size={compact ? 14 : 16} color={fg} /> : null}
      {title ? <T size={compact ? 12 : 14} weight={kind === 'primary' ? 600 : 500} color={fg}>{title}</T> : null}
      {children}
    </Press>
  )
}

const kindStyle: Record<BtnKind, ViewStyle> = {
  default: {},
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  danger: { borderColor: alpha(colors.red, 0.34) },
  ghost: { backgroundColor: 'transparent', borderColor: 'transparent' },
  on: { borderColor: colors.accent, backgroundColor: '#25345a' },
}

/** A square icon-only button (.sh-icon / .btn with only a glyph). */
export function IconBtn({ icon, onPress, size = 20, color = textAlpha(72), box = 40, bordered, label, style, badge, disabled }: {
  icon: IconType
  onPress?: () => void
  size?: number
  color?: string
  box?: number
  bordered?: boolean
  label: string
  style?: StyleProp<ViewStyle>
  /** A small accent dot, top-right (.sh-dot). */
  badge?: boolean
  disabled?: boolean
}) {
  return (
    <Press
      haptic
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={[
        { width: box, height: box, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
        bordered && { backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line },
        style,
      ]}
    >
      <Hi icon={icon} size={size} color={color} />
      {badge ? <View style={s.dot} /> : null}
    </Press>
  )
}

/** .card */
export function Card({ children, style, onPress, onLongPress }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; onLongPress?: () => void }) {
  if (onPress) return <Press onPress={onPress} onLongPress={onLongPress} delayLongPress={400} style={[s.card, style]}>{children}</Press>
  // A long press only: no pressed dimming, which would flash the card on every scroll.
  // Not `accessible`, so VoiceOver still reaches the controls inside.
  if (onLongPress) return <Pressable onLongPress={onLongPress} delayLongPress={400} accessible={false} style={[s.card, style]}>{children}</Pressable>
  return <View style={[s.card, style]}>{children}</View>
}

/** A rounded pill: filters, tags, suggestion chips. */
export function Chip({ label, icon, active, onPress, style, color }: {
  label: string
  icon?: IconType
  active?: boolean
  onPress?: () => void
  style?: StyleProp<ViewStyle>
  color?: string
}) {
  const fg = active ? colors.text : color || colors.muted
  return (
    <Press haptic={!!onPress} onPress={onPress} disabled={!onPress && false} style={[s.chip, active && s.chipOn, style]}>
      {icon ? <Hi icon={icon} size={14} color={fg} /> : null}
      <T size={13} color={fg}>{label}</T>
    </Press>
  )
}

/** .segmented / .seg: a row of mutually exclusive options. Scrolls when it can't fit. */
export function Segmented<V extends string>({ options, value, onChange, accent, style, scroll }: {
  options: { value: V; label: string; count?: number | string }[]
  value: V
  onChange: (v: V) => void
  /** .segmented fills the active one with the accent; .seg uses bg-3. */
  accent?: boolean
  style?: StyleProp<ViewStyle>
  scroll?: boolean
}) {
  const body = options.map((o) => {
    const on = o.value === value
    return (
      <Press
        key={o.value}
        haptic
        onPress={() => onChange(o.value)}
        style={[s.seg, !scroll && { flex: 1 }, on && { backgroundColor: accent ? colors.accent : colors.bg3 }]}
      >
        <T size={14} weight={on ? 500 : 400} color={on ? (accent ? colors.white : colors.text) : colors.muted} numberOfLines={1}>
          {o.label}
          {o.count !== undefined ? <T size={12} color={on ? colors.text : colors.muted}>{` ${o.count}`}</T> : null}
        </T>
      </Press>
    )
  })
  if (scroll) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[s.segWrap, style]} contentContainerStyle={{ gap: 4 }}>
        {body}
      </ScrollView>
    )
  }
  return <View style={[s.segWrap, { flexDirection: 'row', gap: 4 }, style]}>{body}</View>
}

/** A text field in the dashboard's input style. */
export const Input = React.forwardRef<TextInput, TextInputProps & { icon?: IconType }>(function Input({ style, icon, ...rest }, ref) {
  return (
    <View style={[s.input, style as any]}>
      {icon ? <Hi icon={icon} size={18} color={colors.muted} /> : null}
      <TextInput
        ref={ref}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        keyboardAppearance="dark"
        {...rest}
        style={{ flex: 1, color: colors.text, fontSize: 16, fontFamily: fonts[400], paddingVertical: 0 }}
      />
    </View>
  )
})

/** The settings switch: the platform's own control, in the accent colour. */
export function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Switch
      value={value}
      onValueChange={(v) => { tap(); onChange(v) }}
      disabled={disabled}
      trackColor={{ true: colors.accent, false: '#3a4152' }}
      ios_backgroundColor="#3a4152"
    />
  )
}

/** .spinner */
export function Spinner({ label, style }: { label?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ paddingVertical: 30, alignItems: 'center', gap: 10 }, style]}>
      <ActivityIndicator color={colors.muted} />
      {label ? <T muted>{label}</T> : null}
    </View>
  )
}

/** .empty: centred muted text, optionally with a glyph above it. */
export function Empty({ icon, title, children, style }: { icon?: IconType; title?: string; children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ paddingVertical: 40, alignItems: 'center', gap: 10 }, style]}>
      {icon ? <Hi icon={icon} size={30} color={colors.muted} /> : null}
      {title ? <T muted size={15} align="center">{title}</T> : null}
      {children}
    </View>
  )
}

/** The count bubble on the Inbox row (.sh-badge). */
export function Badge({ count }: { count?: number | null }) {
  if (!count) return null
  return (
    <View style={s.badge}>
      <T size={10} weight={700} color={colors.white} lineHeight={16}>{count > 99 ? '99+' : String(count)}</T>
    </View>
  )
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line }, style]} />
}

/** Section heading inside a screen (.view-head h1). */
export function ViewHead({ title, count, right, style }: { title: string; count?: number | string | null; right?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 10 }, style]}>
      <T size={22} weight={700} style={{ flexShrink: 1 }}>
        {title}
        {count !== undefined && count !== null ? <T size={22} weight={600} color={colors.muted}>{` · ${count}`}</T> : null}
      </T>
      {right ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{right}</View> : null}
    </View>
  )
}

export const s = StyleSheet.create({
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line,
    paddingVertical: 9, paddingHorizontal: 14, borderRadius: 9, minHeight: 40,
  },
  btnCompact: { paddingVertical: 6, paddingHorizontal: 9, borderRadius: 8, minHeight: 32 },
  card: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.line, backgroundColor: 'transparent',
  },
  chipOn: { backgroundColor: colors.bg3, borderColor: '#3a4152' },
  segWrap: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 4, flexGrow: 0 },
  seg: { paddingVertical: 9, paddingHorizontal: 12, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  input: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    paddingHorizontal: 14, minHeight: 46,
  },
  dot: { position: 'absolute', top: 8, right: 8, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  badge: { minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 999, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
})
