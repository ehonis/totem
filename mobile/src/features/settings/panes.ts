// Settings' panes, in the web's groups and order (lib/components/settings/sections.ts,
// a byte-for-byte copy of the web's). Two differences, both deliberate:
// - Keyboard is left out: its leader-key shortcuts need a physical keyboard.
// - Notification history follows Notifications: the web keeps it in the bell,
//   and the phone has no bell in its chrome.
import type React from 'react'
import IconSettings from '@tabler/icons-react-native/dist/esm/icons/IconSettings.mjs'
import IconPalette from '@tabler/icons-react-native/dist/esm/icons/IconPalette.mjs'
import IconMessages from '@tabler/icons-react-native/dist/esm/icons/IconMessages.mjs'
import IconMicrophone from '@tabler/icons-react-native/dist/esm/icons/IconMicrophone.mjs'
import IconBell from '@tabler/icons-react-native/dist/esm/icons/IconBell.mjs'
import IconHistory from '@tabler/icons-react-native/dist/esm/icons/IconHistory.mjs'
import IconCpu from '@tabler/icons-react-native/dist/esm/icons/IconCpu.mjs'
import IconChartBar from '@tabler/icons-react-native/dist/esm/icons/IconChartBar.mjs'
import IconSparkles from '@tabler/icons-react-native/dist/esm/icons/IconSparkles.mjs'
import IconPlugConnected from '@tabler/icons-react-native/dist/esm/icons/IconPlugConnected.mjs'
import IconCircleCheck from '@tabler/icons-react-native/dist/esm/icons/IconCircleCheck.mjs'
import IconShieldLock from '@tabler/icons-react-native/dist/esm/icons/IconShieldLock.mjs'
import IconActivity from '@tabler/icons-react-native/dist/esm/icons/IconActivity.mjs'
import type { IconType } from '../../lib/icons'
import { SETTINGS_GROUPS, SETTINGS_LABELS, type SettingsSection } from '../../lib/components/settings/sections'
import { appPane } from './paneRoutes'
import GeneralPane from './panes/GeneralPane'
import AppearancePane from './panes/AppearancePane'
import ChatPane from './panes/ChatPane'
import VoicePane from './panes/VoicePane'
import NotificationsPane from './panes/NotificationsPane'
import NotificationHistory from '../notifications/NotificationHistory'
import ProvidersPane from './panes/ProvidersPane'
import UsagePane from './panes/UsagePane'
import SkillsPane from './panes/SkillsPane'
import ConnectionsPane from './panes/ConnectionsPane'
import TasksPane from './panes/TasksPane'
import SecurityPane from './panes/SecurityPane'
import ActivityPane from './panes/ActivityPane'

export type PaneId = Exclude<SettingsSection, 'shortcuts'> | 'notification-history'

export interface Pane {
  id: PaneId
  label: string
  icon: IconType
  component: React.ComponentType<{ target?: string }>
  /** The component scrolls (and refreshes) itself, edge to edge, instead of sitting in PaneScroll. */
  bare?: boolean
}

const PANE: Record<PaneId, Omit<Pane, 'id' | 'label'> & { label?: string }> = {
  general: { icon: IconSettings, component: GeneralPane },
  appearance: { icon: IconPalette, component: AppearancePane },
  chat: { icon: IconMessages, component: ChatPane },
  voice: { icon: IconMicrophone, component: VoicePane },
  notifications: { icon: IconBell, component: NotificationsPane },
  'notification-history': { label: 'Notification history', icon: IconHistory, component: NotificationHistory, bare: true },
  providers: { icon: IconCpu, component: ProvidersPane },
  usage: { icon: IconChartBar, component: UsagePane },
  skills: { icon: IconSparkles, component: SkillsPane },
  connections: { icon: IconPlugConnected, component: ConnectionsPane },
  tasks: { icon: IconCircleCheck, component: TasksPane },
  security: { icon: IconShieldLock, component: SecurityPane },
  logs: { icon: IconActivity, component: ActivityPane },
}

const pane = (id: PaneId): Pane => ({
  id,
  label: PANE[id].label || SETTINGS_LABELS[id as SettingsSection],
  ...PANE[id],
})

/** The grouped list, as the web's nav draws it. */
export const PANE_GROUPS: { heading: string | null; panes: Pane[] }[] = SETTINGS_GROUPS.map((g) => ({
  heading: g.heading,
  panes: g.items.flatMap((id): Pane[] => {
    if (!appPane(id)) return []
    return id === 'notifications' ? [pane('notifications'), pane('notification-history')] : [pane(id as PaneId)]
  }),
}))

export const PANES: Pane[] = PANE_GROUPS.flatMap((g) => g.panes)

export const paneById = (id?: string | null) => PANES.find((p) => p.id === id)
