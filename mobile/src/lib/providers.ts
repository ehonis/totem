/**
 * Driver-level facts about the agent CLIs, shared by every view.
 *
 * The bridge now identifies an agent by *account* (`codex`, `codex_work`,
 * `claude_work`, …) rather than by CLI, so nothing in the UI may key a logo, an
 * accent or a capability off the provider id — a second Codex account would draw
 * a blank where its logo should be. Everything here is keyed by `driver`, which
 * every provider-shaped payload from the bridge now carries.
 */
import type { ImageSourcePropType } from 'react-native'

// PNGs rendered from the web's SVGs (react-native has no <img src="x.svg">).
export const DRIVER_LOGOS: Record<string, ImageSourcePropType> = {
  cursor: require('../../assets/images/provider-logos/cursor.png'),
  codex: require('../../assets/images/provider-logos/codex.png'),
  claude: require('../../assets/images/provider-logos/claude.png'),
  opencode: require('../../assets/images/provider-logos/opencode.png'),
}

/** The brand colour each CLI is drawn in when an account sets no accent of its own. */
export const DRIVER_ACCENTS: Record<string, string> = {
  codex: '#f3f4f6',
  claude: '#d97757',
  cursor: '#5b8cff',
  opencode: '#f0506e',
}

/**
 * The driver behind a provider row. Payloads from the bridge carry `driver`;
 * the fallback covers a row that predates it, where the id *is* the driver.
 */
export function driverOf(row: { driver?: string; id?: string } | null | undefined): string {
  return row?.driver || row?.id || ''
}

export function driverLogo(row: { driver?: string; id?: string } | null | undefined): ImageSourcePropType | undefined {
  return DRIVER_LOGOS[driverOf(row)]
}

export function driverAccent(row: { driver?: string; id?: string; accentColor?: string } | null | undefined): string {
  return row?.accentColor || DRIVER_ACCENTS[driverOf(row)] || '#8a91a3'
}

/** Two-letter-ish fallback mark for an account with no logo of its own. */
export function providerInitial(row: { name?: string; id?: string } | null | undefined): string {
  return (row?.name || row?.id || '?').slice(0, 1).toUpperCase()
}
