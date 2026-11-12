// Where a Settings link lands in the app, decided without touching the router so
// it can be tested on its own (paneRoutes.test.mjs). A link names a web section
// (/settings/<sub>#<row>); the retired ones go where their settings went, as the
// web's router does with MOVED_SECTIONS.
import { MOVED_SECTIONS, SETTINGS_SECTIONS, type SettingsSection } from '../../lib/components/settings/sections.ts'

/** Sections the app draws. Keyboard is leader-key shortcuts for a physical keyboard. */
const NOT_IN_APP: readonly string[] = ['shortcuts']

/** Panes only the app has: the web keeps notification history in its bell. */
export const APP_ONLY_PANES = ['notification-history'] as const

export const appPane = (id: string | null | undefined): boolean =>
  !!id && (((SETTINGS_SECTIONS as readonly string[]).includes(id) && !NOT_IN_APP.includes(id)) || (APP_ONLY_PANES as readonly string[]).includes(id))

export type SettingsLanding =
  /** A pane, optionally scrolled to one of its rows. */
  | { pane: string; row?: string }
  /** Another drawer page (Jobs became the Totems page). */
  | { tab: string }
  /** The Settings list itself. */
  | { list: true }

/** A settings link (`sub` the section, `hash` the row) as where the app opens it. */
export function settingsLanding(sub?: string | null, hash?: string | null): SettingsLanding {
  const row = hash ? hash.replace(/^#/, '') || undefined : undefined
  if (!sub) return { list: true }
  // Usage was the bottom of Providers; the bridge's quota notifications still say so.
  if (sub === 'providers' && row === 'usage') return { pane: 'usage' }
  const moved = MOVED_SECTIONS[sub]
  if (moved?.tab) return { tab: moved.tab }
  if (moved?.sub) return landingFor(moved.sub, moved.hash ?? row)
  return landingFor(sub, row)
}

function landingFor(pane: SettingsSection | string, row?: string): SettingsLanding {
  if (!appPane(pane)) return { list: true }
  return row ? { pane, row } : { pane }
}
