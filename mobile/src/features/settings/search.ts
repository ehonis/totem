// Settings search on the phone: the web's index (lib/components/settings/searchIndex.ts,
// a byte-for-byte copy), less what the app does not draw. A hit opens the pane at
// that row, as /settings/<pane>#<row> does on the web. paneRoutes.test.mjs checks
// every id left here is drawn by the app's own pane.
import { SEARCH_ITEMS, searchSettings, type SettingsSearchItem } from '../../lib/components/settings/searchIndex'
import { appPane } from './paneRoutes'

/**
 * Rows the web has and the app does not. Reading aloud picks one of the
 * browser's speech voices, and the app has no read-aloud; no screen in the app
 * has a denser layout for Compact density to switch to.
 */
export const APP_SKIPS = new Set(['voice:reading-voice', 'voice:speaking-rate', 'appearance:compact'])

export const APP_SEARCH_ITEMS: SettingsSearchItem[] = SEARCH_ITEMS.filter((i) => appPane(i.section) && !APP_SKIPS.has(i.key))

export const searchAppSettings = (query: string) => searchSettings(query, APP_SEARCH_ITEMS)
