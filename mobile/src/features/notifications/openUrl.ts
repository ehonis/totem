// A notification's deep link is a dashboard path ("/inbox#P12",
// "/chat?thread=…", "/productivity/todos", "/totems?totem=…"). This maps it onto
// the app's routes the way web router.ts parseLocation reads the address bar.
import { router } from 'expo-router'
import { openProject } from '../../lib/chat/store'
import { navigateTo, openChat, PRODUCTIVITY_APPS, TAB_ROUTES } from '../../shell/nav'
import { openDashboard } from '../settings/ui'

export function openDashboardUrl(url: string) {
  let u: URL
  try { u = new URL(url, 'http://totem.local') } catch { return }
  const params = u.searchParams
  const hash = u.hash ? decodeURIComponent(u.hash.slice(1)) : null
  const [first, second] = u.pathname.split('/').filter(Boolean)
  const tab = first || params.get('tab') || (params.get('thread') || params.get('project') ? 'chat' : 'overview')

  if (tab === 'chat') {
    const thread = params.get('thread')
    const project = params.get('project')
    if (thread) { openChat(thread); return }
    if (project) { openProject(project); router.navigate('/chat'); return }
    openChat(null)
    return
  }
  if (tab === 'totems' && params.get('totem')) {
    router.navigate('/totems')
    router.push({ pathname: '/totem/[id]', params: { id: params.get('totem')! } })
    return
  }
  if (tab === 'inbox') {
    router.navigate({ pathname: '/inbox', params: hash ? { focus: hash } : {} })
    return
  }
  // Tabs the app doesn't have (Messages, Code, Brain, Logs) open on the dashboard.
  if (!(tab in TAB_ROUTES) && !(PRODUCTIVITY_APPS as readonly string[]).includes(tab)) {
    openDashboard(u.pathname + u.search + u.hash)
    return
  }
  navigateTo({ tab, app: second || params.get('app'), sub: second || params.get('stab'), hash })
}
