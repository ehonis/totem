// Where each page and card is drawn: its route, and the files behind it on the
// dashboard, in the iPhone app and on the bridge. "Chat about this" quotes the
// row so the agent can open the code instead of guessing at it.
// places.test.ts fails when a file listed here no longer exists, so a rename
// has to update this table. mobile/src/lib/chat/about/places.ts is a byte-for-byte
// copy (the same test checks that).
// Idea after github.com/mattabate/life-distributable's places.js (MIT).

export interface Place {
  label: string
  route: string
  web: string[]
  app?: string[]
  data?: string[]
}

export const PLACES = {
  'overview.schedule': {
    label: 'Overview › Schedule',
    route: '/overview',
    web: ['web/src/components/OverviewView.tsx', 'web/src/components/overview/time.ts'],
    app: ['mobile/src/features/overview/OverviewScreen.tsx'],
    data: ['bridge.mjs'],
  },
  'overview.tasks': {
    label: 'Overview › Tasks',
    route: '/overview',
    web: ['web/src/components/OverviewView.tsx', 'web/src/components/overview/time.ts'],
    app: ['mobile/src/features/overview/OverviewScreen.tsx'],
    data: ['todos/service.mjs'],
  },
  'overview.goals': {
    label: 'Overview › Goals',
    route: '/overview',
    web: ['web/src/components/OverviewView.tsx'],
    app: ['mobile/src/features/overview/OverviewScreen.tsx'],
    data: ['goals/service.mjs', 'goals/progress.mjs'],
  },
  'overview.habits': {
    label: 'Overview › Habits',
    route: '/overview',
    web: ['web/src/components/OverviewView.tsx', 'web/src/components/HabitsView.tsx'],
    app: ['mobile/src/features/overview/OverviewScreen.tsx', 'mobile/src/features/overview/HabitRow.tsx'],
    data: ['bridge.mjs'],
  },
  'overview.metric': {
    label: 'Overview › Pinned number',
    route: '/overview',
    web: ['web/src/components/OverviewView.tsx', 'web/src/components/MetricChart.tsx'],
    app: ['mobile/src/features/overview/MetricTile.tsx'],
    data: ['bridge.mjs'],
  },
  'overview.system': {
    label: 'Overview › AI limits, jobs and activity',
    route: '/overview',
    web: ['web/src/components/OverviewView.tsx', 'web/src/useAiUsageLive.ts'],
    app: ['mobile/src/features/overview/OverviewScreen.tsx'],
    data: ['ai-usage/poller.mjs', 'jobs/store.mjs'],
  },
  todos: {
    label: 'Tasks',
    route: '/productivity/todos',
    web: ['web/src/components/TodosView.tsx', 'web/src/todos/TodoBoard.tsx', 'web/src/todos/TodoCard.tsx'],
    app: ['mobile/src/features/productivity/TodosView.tsx', 'mobile/src/features/todos/TodoCard.tsx'],
    data: ['todos/service.mjs', 'todos/http.mjs'],
  },
  goals: {
    label: 'Goals',
    route: '/productivity/goals',
    web: ['web/src/components/GoalsView.tsx', 'web/src/goals/GoalCard.tsx'],
    app: ['mobile/src/features/productivity/GoalsView.tsx', 'mobile/src/features/goals/GoalCard.tsx'],
    data: ['goals/service.mjs', 'goals/progress.mjs'],
  },
  habits: {
    label: 'Habits',
    route: '/productivity/habits',
    web: ['web/src/components/HabitsView.tsx', 'web/src/components/MetricChart.tsx'],
    app: ['mobile/src/features/productivity/HabitsView.tsx', 'mobile/src/features/habits/HabitGrid.tsx'],
    data: ['bridge.mjs'],
  },
  fleet: {
    label: 'Fleet',
    route: '/fleet',
    web: ['web/src/fleet/FleetView.tsx', 'web/src/fleet/format.ts'],
    app: ['mobile/src/features/fleet/FleetScreen.tsx'],
    data: ['fleet/http.mjs', 'fleet/store.mjs', 'fleet/power.mjs', 'fleet/pricing.mjs'],
  },
  'fleet.device': {
    label: 'Fleet › Machine',
    route: '/fleet',
    web: ['web/src/fleet/FleetView.tsx', 'web/src/fleet/format.ts'],
    app: ['mobile/src/features/fleet/FleetDeviceScreen.tsx'],
    data: ['fleet/http.mjs', 'fleet/collect.mjs', 'fleet/store.mjs'],
  },
  'dev.repo': {
    label: 'Dev › Repository',
    route: '/dev',
    web: ['web/src/components/DevView.tsx'],
    data: ['dev/service.mjs', 'dev/github.mjs'],
  },
  'dev.shipped': {
    label: 'Dev › Shipped',
    route: '/dev',
    web: ['web/src/components/ShippedCard.tsx'],
    data: ['dev/service.mjs', 'dev/github.mjs'],
  },
  'settings.general': { label: 'Settings › General', route: '/settings/general', web: ['web/src/components/SettingsView.tsx'], app: ['mobile/src/features/settings/panes/GeneralPane.tsx'] },
  'settings.chat': { label: 'Settings › Chat', route: '/settings/chat', web: ['web/src/components/ChatSettings.tsx'], app: ['mobile/src/features/settings/panes/ChatPane.tsx'] },
  'settings.ai': { label: 'Settings › AI', route: '/settings/ai', web: ['web/src/components/AiSettings.tsx'], app: ['mobile/src/features/settings/panes/AiPane.tsx'], data: ['ai/settings.mjs'] },
  'settings.integrations': { label: 'Settings › Integrations', route: '/settings/integrations', web: ['web/src/components/IntegrationsSettings.tsx'], app: ['mobile/src/features/settings/panes/IntegrationsPane.tsx'], data: ['ai/settings.mjs'] },
  'settings.tasks': { label: 'Settings › Tasks', route: '/settings/tasks', web: ['web/src/components/TaskSettings.tsx'], app: ['mobile/src/features/settings/panes/TasksPane.tsx'], data: ['todos/service.mjs'] },
  'settings.providers': { label: 'Settings › Providers', route: '/settings/providers', web: ['web/src/components/ProvidersView.tsx', 'web/src/components/AiUsagePanel.tsx'], data: ['providers/instances.mjs'] },
  'settings.shortcuts': { label: 'Settings › Shortcuts', route: '/settings/shortcuts', web: ['web/src/components/ShortcutsSettings.tsx', 'web/src/shortcuts.ts'] },
  'settings.notifications': { label: 'Settings › Notifications', route: '/settings/notifications', web: ['web/src/components/NotificationsSettings.tsx'], app: ['mobile/src/features/settings/panes/NotificationsPane.tsx'], data: ['notify/notifier.mjs'] },
  'settings.voice': { label: 'Settings › Voice', route: '/settings/voice', web: ['web/src/components/VoiceSettings.tsx'], app: ['mobile/src/features/settings/panes/VoicePane.tsx'] },
} satisfies Record<string, Place>

export type PlaceId = keyof typeof PLACES
