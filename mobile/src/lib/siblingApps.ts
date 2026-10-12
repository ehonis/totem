// Krakatoa and Bushido have their own iPhone apps (each repo's mobile/), with the
// URL schemes `krakatoa://` and `bushido://`. A link that points at one of them,
// whether a linked habit, a goal's link, a todo's source or a link in a chat,
// opens that app when it is installed and the web page when it is not.
//
// Which hosts belong to which app comes from the bridge (`apps` on the habits
// payload: KRAKATOA_URL, BUSHIDO_URL), remembered here so a link works before the
// Habits tab has loaded. Nothing about a particular install is written in code.
import { Linking } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { colors } from '../theme'
import { APP_NAME, type LinkedApp } from '../features/habits/logic'

const KEY = 'totem:sibling-apps'
const APPS = Object.keys(APP_NAME) as LinkedApp[]

let hosts: Partial<Record<LinkedApp, string>> = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
})()

const hostOf = (url: string) => { try { return new URL(url).host.toLowerCase() } catch { return '' } }

/** Remember each app's host from the bridge's `apps` (null: not configured). */
export function rememberSiblingApps(apps: Partial<Record<LinkedApp, string | null>> | null | undefined) {
  if (!apps) return
  const next: Partial<Record<LinkedApp, string>> = {}
  for (const app of APPS) {
    const host = apps[app] ? hostOf(apps[app]!) : ''
    if (host) next[app] = host
  }
  hosts = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* the next load tries again */ }
}

/** Which sibling app a web address belongs to, if any. */
export function siblingAppFor(url: string): LinkedApp | null {
  const host = hostOf(url)
  if (!host) return null
  return APPS.find((app) => hosts[app] === host) ?? null
}

const openWeb = (url: string): Promise<void> =>
  WebBrowser.openBrowserAsync(url, { controlsColor: colors.accent, dismissButtonStyle: 'close' }).then(() => {}, () => {})

/**
 * Open the app itself; without it installed, `fallback` in the in-app browser.
 * iOS rejects openURL for a scheme no installed app claims, which is the signal:
 * canOpenURL would need the schemes declared in Info.plist, and a native rebuild.
 */
export async function openSiblingApp(app: LinkedApp, fallback?: string | null): Promise<void> {
  try {
    await Linking.openURL(`${app}://`)
  } catch {
    if (fallback) await openWeb(fallback)
  }
}

/** Open any web link: a sibling app's address goes to that app, the rest to the browser. */
export function openUrl(url: string): Promise<void> {
  const app = siblingAppFor(url)
  return app ? openSiblingApp(app, url) : openWeb(url)
}
