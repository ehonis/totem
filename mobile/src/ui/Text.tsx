// Text in Inter, with fontWeight mapped onto the per-weight font family iOS needs.
// Defaults match the web body (14px/1.5, --text); pass `muted` for --muted.
import React from 'react'
import { Text as RNText, StyleSheet, type TextProps, type TextStyle } from 'react-native'
import { colors, fonts } from '../theme'

export interface TProps extends TextProps {
  size?: number
  weight?: 400 | 500 | 600 | 700
  color?: string
  muted?: boolean
  /** The Unbounded wordmark face. */
  brand?: boolean
  mono?: boolean
  align?: TextStyle['textAlign']
  lineHeight?: number
}

export function T({ size = 14, weight, color, muted, brand, mono, align, lineHeight, style, ...rest }: TProps) {
  // A style's own fontWeight is honoured too, so StyleSheet-driven text still lands on the right face.
  const flat = StyleSheet.flatten(style) || {}
  const w = (weight || Number(flat.fontWeight) || 400) as 400 | 500 | 600 | 700
  const fontSize = flat.fontSize ?? size
  return (
    <RNText
      {...rest}
      style={[
        {
          fontSize: size,
          lineHeight: lineHeight ?? Math.round(fontSize * 1.4),
          color: color || (muted ? colors.muted : colors.text),
          textAlign: align,
        },
        style,
        // Last, so it wins: a custom family per weight, and no synthetic bold on top of it.
        { fontFamily: brand ? fonts.brand : mono ? fonts.mono : fonts[w] || fonts[400], fontWeight: mono ? flat.fontWeight : undefined },
      ]}
    />
  )
}
