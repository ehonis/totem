// The app's background palettes (Settings → Appearance › Background), ported from
// web/src/backgrounds.ts with the same ids and colours. The web sets CSS variables;
// the app has no stylesheet to restyle at run time, so theme.ts reads the stored
// palette once at launch and the pane restarts the app to apply a new one.
// Per device, like the other appearance settings in settings.ts.

export interface Background {
  id: string
  name: string
  /** Page, behind everything. */
  bg: string
  /** Sidebar and cards. */
  panel: string
  /** Hovered and selected rows, chat bubbles, menus. */
  raised: string
  /** The icon rail on the far left. */
  rail: string
  line: string
  muted: string
}

export const DEFAULT_BACKGROUND = 'true-black'

export const BACKGROUNDS: Background[] = [
  { id: 'original', name: 'Original', bg: '#0f1115', panel: '#161922', raised: '#1f2330', rail: '#0b0c10', line: '#262b38', muted: '#8a91a3' },
  { id: 'true-black', name: 'True black', bg: '#0b0b0c', panel: '#141415', raised: '#1e1e20', rail: '#000000', line: '#2a2a2d', muted: '#9a9a9f' },
  { id: 'charcoal', name: 'Charcoal', bg: '#181818', panel: '#202020', raised: '#2a2a2a', rail: '#0f0f0f', line: '#353535', muted: '#a0a0a0' },
  { id: 'cool-zinc', name: 'Cool zinc', bg: '#1b1c1f', panel: '#24262a', raised: '#2e3035', rail: '#111214', line: '#3a3d43', muted: '#a3a7af' },
  { id: 'warm-graphite', name: 'Warm graphite', bg: '#1d1a18', panel: '#272320', raised: '#322c27', rail: '#12100f', line: '#403831', muted: '#b0a399' },
  { id: 'espresso', name: 'Espresso', bg: '#1e1712', panel: '#2a2019', raised: '#362920', rail: '#130e0b', line: '#47362a', muted: '#bba591' },
  { id: 'oxblood', name: 'Oxblood', bg: '#1e1415', panel: '#2a1c1d', raised: '#362425', rail: '#130c0d', line: '#472f31', muted: '#bba0a1' },
  { id: 'aubergine', name: 'Aubergine', bg: '#1d1820', panel: '#28212c', raised: '#332a38', rail: '#120f14', line: '#423747', muted: '#b2a2b8' },
  { id: 'midnight-navy', name: 'Midnight navy', bg: '#0f1420', panel: '#171e2e', raised: '#20293d', rail: '#0a0e17', line: '#2c374f', muted: '#99a6c0' },
  { id: 'slate-blue', name: 'Slate blue', bg: '#192129', panel: '#232f3b', raised: '#2c3b4a', rail: '#10171e', line: '#3a4c5f', muted: '#a0b1c2' },
  { id: 'deep-teal', name: 'Deep teal', bg: '#122022', panel: '#1a2c2f', raised: '#22383c', rail: '#0b1517', line: '#2e494d', muted: '#98b3b4' },
  { id: 'forest', name: 'Forest', bg: '#121b16', panel: '#1a261f', raised: '#223128', rail: '#0b110d', line: '#2d4034', muted: '#97b2a0' },
  { id: 'muted-olive', name: 'Muted olive', bg: '#191e1a', panel: '#232b24', raised: '#2d372e', rail: '#101510', line: '#39453a', muted: '#9eac9d' },
]

export function findBackground(id: string | null | undefined): Background {
  return BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS.find((b) => b.id === DEFAULT_BACKGROUND)!
}
