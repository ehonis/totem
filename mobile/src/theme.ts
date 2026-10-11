// The dashboard's design tokens (web/src/styles.css :root), as one object.
// Keep the names the CSS uses so a value can be looked up in either direction.
import { StyleSheet } from 'react-native'

export const colors = {
  bg: '#0f1115',
  bg2: '#161922',
  bg3: '#1d212c',
  line: '#262b38',
  text: '#e6e8ee',
  muted: '#8a91a3',
  accent: '#5b8cff',
  accent2: '#7c5cff',
  green: '#3fb950',
  red: '#f0506e',
  amber: '#e3b341',
  // Shell (shell.css) shades that are not tokens on the web.
  rail: '#0b0c10',
  drawerOn: '#252a37',
  fabVoice: '#2a2f3c',
  fabVoiceBorder: '#3a4152',
  // Toast fills (ToastHost.tsx): white text clears 5.4:1 on each.
  toastError: '#c42d4c',
  toastSuccess: '#1f7a34',
  toastInfo: '#3463d6',
  white: '#ffffff',
} as const

/** `color-mix(in srgb, var(--text) N%, transparent)`, which the shell uses for quiet chrome. */
export const textAlpha = (pct: number) => `rgba(230, 232, 238, ${pct / 100})`
/** Any hex colour at an alpha, for the CSS's `#rrggbbaa` and color-mix tints. */
export function alpha(hex: string, a: number) {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

export const radius = { sm: 8, md: 10, lg: 12, xl: 16, pill: 999 } as const

// Inter for everything, Unbounded for the TOTEM wordmark. Custom fonts on iOS need
// one family per weight; Text maps fontWeight onto these.
export const fonts = {
  400: 'Inter_400Regular',
  500: 'Inter_500Medium',
  600: 'Inter_600SemiBold',
  700: 'Inter_700Bold',
  brand: 'Unbounded_600SemiBold',
  mono: 'Menlo',
} as const

export const hairline = StyleSheet.hairlineWidth
