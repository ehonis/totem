// The dashboard's design tokens (web/src/styles.css :root), as one object.
// Keep the names the CSS uses so a value can be looked up in either direction.
import { StyleSheet } from 'react-native'
import { findBackground, type Background } from './lib/backgrounds'

// Settings → Appearance › Background (backgrounds.ts), read once at launch: every
// StyleSheet below and in the screens is built from these values at import time,
// so a new palette applies when the app restarts (the pane offers to). Read
// straight from storage, not through settings.ts, so nothing here imports React.
function storedPalette(): Background | null {
  try {
    const raw = globalThis.localStorage?.getItem('app_settings')
    const id = raw ? JSON.parse(raw)?.background : null
    const b = id ? findBackground(id) : null
    return b && b.id !== 'original' ? b : null
  } catch {
    return null
  }
}

const palette = storedPalette()

/** The palette this launch drew with; null for Original, the stylesheet's own colours. */
export const activePalette: Background | null = palette
/** A code block's header and a table's head (Original's own values otherwise). */
export const surfaces = {
  codeHead: palette ? palette.panel : '#161922',
  tableHead: palette ? palette.panel : '#1a1d26',
}

/** Its id ('original' when none is set). */
export const activeBackground: string = palette?.id ?? 'original'

const base = {
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
  // --away: trips and days off (the Overview band, the calendar).
  away: '#2dd4bf',
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

export const colors: { readonly [K in keyof typeof base]: string } = palette
  ? {
    ...base,
    bg: palette.bg,
    bg2: palette.panel,
    bg3: palette.raised,
    line: palette.line,
    muted: palette.muted,
    rail: palette.rail,
    // The web points --rail-on and --rail-hover at the palette's own surfaces.
    drawerOn: palette.raised,
  }
  : base

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
