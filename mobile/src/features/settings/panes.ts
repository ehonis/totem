// Settings' panes, in the web's order (SettingsView.tsx SUB_TABS, less Shortcuts,
// which are keyboard-only). `web` is the dashboard path for panes the app doesn't
// draw yet; their screen says so and opens the dashboard there.
import type React from 'react'
import {
  Cog6ToothIcon, AdjustmentsHorizontalIcon, BellAlertIcon, MicrophoneIcon, ChatBubbleLeftRightIcon,
  SparklesIcon, BoltIcon, CircleStackIcon, ShieldCheckIcon, LinkIcon, CheckCircleIcon, type IconType,
} from '../../lib/icons'
import { BellIcon } from 'react-native-heroicons/outline'
import GeneralPane from './panes/GeneralPane'
import ChatPane from './panes/ChatPane'
import AiPane from './panes/AiPane'
import IntegrationsPane from './panes/IntegrationsPane'
import TasksPane from './panes/TasksPane'
import VoicePane from './panes/VoicePane'
import NotificationsPane from './panes/NotificationsPane'
import NotificationHistory from '../notifications/NotificationHistory'

export interface Pane {
  id: string
  label: string
  icon: IconType
  /** The section of the grouped list it sits in. */
  group: 0 | 1
  component?: React.ComponentType
  web?: string
  /** The component scrolls (and refreshes) itself, edge to edge, instead of sitting in PaneScroll. */
  bare?: boolean
}

export const PANES: Pane[] = [
  { id: 'general', label: 'General', icon: Cog6ToothIcon, group: 0, component: GeneralPane },
  { id: 'chat', label: 'Chat', icon: ChatBubbleLeftRightIcon, group: 0, component: ChatPane },
  { id: 'ai', label: 'AI', icon: SparklesIcon, group: 0, component: AiPane },
  { id: 'integrations', label: 'Integrations', icon: LinkIcon, group: 0, component: IntegrationsPane },
  { id: 'tasks', label: 'Tasks', icon: CheckCircleIcon, group: 0, component: TasksPane },
  { id: 'providers', label: 'Providers', icon: AdjustmentsHorizontalIcon, group: 0, web: '/settings/providers' },
  { id: 'notifications', label: 'Notifications', icon: BellAlertIcon, group: 0, component: NotificationsPane },
  // The web's bell. The phone has no bell in its chrome, so its history lives here.
  { id: 'notification-history', label: 'Notification history', icon: BellIcon, group: 0, component: NotificationHistory, bare: true },
  { id: 'voice', label: 'Voice', icon: MicrophoneIcon, group: 0, component: VoicePane },
  // The AI workshop, formerly Studio and Logs in the web's side nav.
  { id: 'skills', label: 'Skills', icon: SparklesIcon, group: 1, web: '/settings/skills' },
  { id: 'jobs', label: 'Jobs', icon: BoltIcon, group: 1, web: '/settings/jobs' },
  { id: 'connections', label: 'Connections', icon: CircleStackIcon, group: 1, web: '/settings/connections' },
  { id: 'logs', label: 'Logs', icon: ShieldCheckIcon, group: 1, web: '/settings/logs' },
]

export const paneById = (id?: string | null) => PANES.find((p) => p.id === id)
