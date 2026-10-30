// The Overview's own palette and small pieces (overview.css: the ovx-* rules).
// The page uses the chat's visual language rather than the dashboard's cards, so
// these tokens are kept here instead of in theme.ts.
import React, { useEffect, useRef } from 'react'
import { Animated, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { alpha, colors, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { IconAlertTriangle, IconChevronRight } from '../../lib/components/overview/icons'
import type { ChatContext } from '../../lib/chat/about/context'
import { chatAboutMenu } from '../../ui/chatAbout'

export const ov = {
  text: textAlpha(94),
  soft: textAlpha(62),
  faint: textAlpha(40),
  // Glass rather than slabs, so the backdrop's glow comes through the cards.
  // Over the dark top of the page these land on the old solid colours.
  surface: 'rgba(23, 26, 34, 0.68)',
  raise: 'rgba(255, 255, 255, 0.06)',
  line: 'rgba(255, 255, 255, 0.085)',
  /** color-mix(--ovx-line 70%, transparent): the rule between rows. */
  rowLine: 'rgba(255, 255, 255, 0.06)',
  /** A card's colour without the glass, for strokes that knock a mark out of a line. */
  knock: '#171a22',
  /** .ovx-sys: the system tiles' tint. */
  tile: alpha(colors.bg, 0.4),
  bar: textAlpha(70),
  overdue: '#ff8095',
  /** The AI half of the activity sparkline. */
  sparkAi: textAlpha(28),
} as const

type Tabler = React.ComponentType<any>


/** The web's <TI>: a Tabler glyph at the chat's 1.75 stroke. */
export function TI({ icon: Icon, size = 18, stroke = 1.75, color = ov.text }: { icon: Tabler; size?: number; stroke?: number; color?: string }) {
  return <Icon size={size} strokeWidth={stroke} color={color} />
}

export function Section({ title, meta, onOpen, openLabel = 'Open', style, about, children }: {
  title: string
  /** "Chat about this" on a long press: what the card shows. */
  about?: () => ChatContext | null
  meta?: React.ReactNode
  onOpen?: () => void
  openLabel?: string
  style?: StyleProp<ViewStyle>
  children: React.ReactNode
}) {
  return (
    // Not `accessible`: the card's own controls stay separate for VoiceOver.
    <Pressable style={[s.card, style]} onLongPress={about && (() => chatAboutMenu(about))} delayLongPress={400} disabled={!about} accessible={false}>
      <View style={s.cardHead}>
        <T size={15} weight={600} color={colors.text}>{title}</T>
        {meta != null && meta !== '' && (
          typeof meta === 'string'
            ? <T size={13} color={ov.faint} numberOfLines={1} style={{ flexShrink: 1 }}>{meta}</T>
            : <View style={{ flexShrink: 1 }}>{meta}</View>
        )}
        {onOpen && (
          <Press haptic onPress={onOpen} style={s.link} hitSlop={8} accessibilityRole="button">
            <T size={13} color={ov.soft}>{openLabel}</T>
            <TI icon={IconChevronRight} size={15} color={ov.soft} />
          </Press>
        )}
      </View>
      {children}
    </Pressable>
  )
}

export const Quiet = ({ children }: { children: React.ReactNode }) => (
  <T size={14} color={ov.faint} style={s.quiet}>{children}</T>
)

export const Failed = ({ msg }: { msg: string }) => (
  <View style={[s.quiet, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
    <TI icon={IconAlertTriangle} size={15} color={colors.amber} />
    <T size={14} color={colors.amber} style={{ flex: 1 }}>{msg}</T>
  </View>
)

/** Three pulsing bars (.ovx-skel) while a card's data is on its way. */
export function Loading() {
  const pulse = useRef(new Animated.Value(1)).current
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [pulse])
  return (
    <Animated.View accessibilityLabel="Loading" style={[s.skel, { opacity: pulse }]}>
      <View style={s.skelBar} />
      <View style={[s.skelBar, { width: '78%' }]} />
      <View style={[s.skelBar, { width: '56%' }]} />
    </Animated.View>
  )
}

/** .ovx-bar: a 4px track with a fill. */
export function Bar({ value, tone }: { value: number; tone?: string }) {
  return (
    <View style={s.bar}>
      <View style={[s.barFill, { width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: tone || ov.bar }]} />
    </View>
  )
}

export function Subhead({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return <T size={13} color={ov.faint} style={{ paddingTop: first ? 2 : 12, paddingBottom: 4 }}>{children}</T>
}

/** .ovx-more: "3 more due". */
export function More({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Press onPress={onPress} style={{ alignSelf: 'flex-start', marginTop: 4, paddingVertical: 6 }}>
      <T size={13} color={ov.soft}>{label}</T>
    </Press>
  )
}

export const s = StyleSheet.create({
  card: {
    backgroundColor: ov.surface, borderWidth: 1, borderColor: ov.line, borderRadius: 16,
    paddingTop: 12, paddingHorizontal: 14, paddingBottom: 10,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8, minHeight: 28 },
  link: {
    marginLeft: 'auto', marginRight: -6, flexDirection: 'row', alignItems: 'center', gap: 2,
    height: 28, paddingLeft: 10, paddingRight: 6, borderRadius: 8,
  },
  quiet: { paddingTop: 6, paddingBottom: 8 },
  skel: { gap: 10, paddingTop: 6, paddingBottom: 10 },
  skelBar: { height: 12, borderRadius: 6, backgroundColor: ov.raise },
  bar: { height: 4, borderRadius: 2, backgroundColor: ov.raise, overflow: 'hidden', flex: 1, minWidth: 0 },
  barFill: { height: '100%', borderRadius: 2 },
})
