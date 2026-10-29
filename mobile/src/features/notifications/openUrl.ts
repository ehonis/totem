// Follow a notification's link: a dashboard path opens the app screen it names
// (destination.ts decides which), a page elsewhere opens in the in-app browser.
import { router } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { getAppConfig } from '../../lib/api'
import { openProject } from '../../lib/chat/store'
import { getBaseUrl } from '../../lib/connection'
import { getSettings } from '../../lib/settings'
import { navigateTo, openChat } from '../../shell/nav'
import { colors } from '../../theme'
import { openDashboard } from '../settings/ui'
import { notificationDestination, type Destination } from './destination'

/** PUBLIC_URL, when the bridge has one: links it builds may use it instead of the address the app connects to. */
async function publicUrl(): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))
  const config = getAppConfig().then((c) => c.publicUrl, () => null)
  return Promise.race([config, timeout])
}

function go(dest: Destination) {
  switch (dest.kind) {
    case 'external':
      // Only web pages: a feed's <link> is untrusted and must not dial, text or open another app.
      if (/^https?:/i.test(dest.url)) {
        WebBrowser.openBrowserAsync(dest.url, { controlsColor: colors.accent, dismissButtonStyle: 'close' }).catch(() => {})
      }
      return
    case 'web': return openDashboard(dest.path)
    case 'landing': return navigateTo(getSettings().landingTab || 'overview')
    case 'tab': return navigateTo(dest.tab)
    case 'chat':
      if (dest.thread) return openChat(dest.thread)
      if (dest.project) openProject(dest.project)
      // A bare /chat shows whatever chat is open, as on the web.
      router.navigate('/chat')
      return
    case 'totem':
      router.navigate('/totems')
      router.push({ pathname: '/totem/[id]', params: { id: dest.id } })
      return
    case 'device':
      router.navigate('/fleet')
      router.push({ pathname: '/fleet/[id]', params: { id: dest.id } })
      return
    case 'inbox':
      router.navigate({ pathname: '/inbox', params: dest.focus ? { focus: dest.focus } : {} })
      return
    case 'productivity': return navigateTo({ tab: 'productivity', app: dest.app })
    case 'settings': return navigateTo({ tab: 'settings', sub: dest.pane })
    case 'usage': return navigateTo({ tab: 'settings', sub: 'providers', hash: 'usage' })
  }
}

export async function openDashboardUrl(url: string) {
  try {
    const base = getBaseUrl()
    let dest = notificationDestination(url, [base])
    // An absolute link on another host may still be the bridge, under PUBLIC_URL.
    if (dest.kind === 'external' && /^https?:/i.test(dest.url)) {
      const pub = await publicUrl()
      if (pub) dest = notificationDestination(url, [base, pub])
    }
    go(dest)
  } catch {
    // A link that can't be followed leaves the app where it is rather than throwing
    // out of a notification handler.
  }
}
