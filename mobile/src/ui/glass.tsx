// iOS 26's liquid glass for the app's floating controls: the drawer's foot, the
// corner new-chat button and the sheets opened from the drawer. Each control is its
// own glass shape; a GlassGroup lets shapes within `spacing` of each other melt
// together, the way iOS 26's toolbars do, so a row of buttons reads as one piece.
// Older iOS, Android and the web preview get the solid `fallback` style instead.
import React from 'react'
import { Platform, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native'
import { GlassContainer, GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect'
import { Press } from './kit'

export const GLASS = Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable()

/** The light glass of the app's one primary button: New chat, in the corner and the drawer's foot. */
export const FAB_TINT = 'rgba(230, 232, 238, 0.82)'

/** Shapes inside melt into one another when closer than `spacing`. */
export function GlassGroup({ spacing = 12, style, children }: { spacing?: number; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  if (!GLASS) return <View style={style}>{children}</View>
  return <GlassContainer spacing={spacing} style={style}>{children}</GlassContainer>
}

/**
 * A pressable glass shape. `shape` is its size and corner radius, `fallback` the solid
 * look without glass (a fill, a border), `tint` the glass's colour (the light new-chat
 * button). The press target fills the shape, so the whole capsule takes the tap.
 */
export function GlassButton({ shape, fallback, tint, inner, children, ...press }: PressableProps & {
  haptic?: boolean
  shape: StyleProp<ViewStyle>
  fallback?: StyleProp<ViewStyle>
  tint?: string
  /** The content's layout inside the shape (a row of label and count). */
  inner?: StyleProp<ViewStyle>
  children: React.ReactNode
}) {
  const body = <Press {...press} style={[{ flexGrow: 1, alignItems: 'center', justifyContent: 'center' }, inner]}>{children}</Press>
  if (!GLASS) return <View style={[shape, fallback]}>{body}</View>
  return (
    <GlassView glassEffectStyle="regular" isInteractive colorScheme="dark" tintColor={tint} style={shape}>
      {body}
    </GlassView>
  )
}
