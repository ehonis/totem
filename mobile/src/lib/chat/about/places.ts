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
    web: ['web/src/components/TodosView.tsx', 'web/src/todos/TaskRow.tsx', 'web/src/todos/TaskPane.tsx'],
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
  'dev.issue': {
    label: 'Dev › Issues',
    route: '/dev',
    web: ['web/src/dev/IssuesCard.tsx', 'web/src/dev/issues.ts'],
    data: ['dev/issues.mjs', 'dev/github.mjs'],
  },
  'settings.general': { label: 'Settings › General', route: '/settings/general', web: ['web/src/components/settings/GeneralPane.tsx', 'web/src/components/IntegrationsSettings.tsx'], app: ['mobile/src/features/settings/panes/GeneralPane.tsx', 'mobile/src/features/settings/integrations.tsx'] },
  'settings.appearance': { label: 'Settings › Appearance', route: '/settings/appearance', web: ['web/src/components/settings/AppearancePane.tsx', 'web/src/backgrounds.ts'], app: ['mobile/src/features/settings/panes/AppearancePane.tsx', 'mobile/src/lib/backgrounds.ts'] },
  'settings.chat': { label: 'Settings › Chat', route: '/settings/chat', web: ['web/src/components/ChatSettings.tsx'], app: ['mobile/src/features/settings/panes/ChatPane.tsx'] },
  'settings.voice': { label: 'Settings › Voice', route: '/settings/voice', web: ['web/src/components/VoiceSettings.tsx'], app: ['mobile/src/features/settings/panes/VoicePane.tsx'] },
  'settings.notifications': { label: 'Settings › Notifications', route: '/settings/notifications', web: ['web/src/components/NotificationsSettings.tsx'], app: ['mobile/src/features/settings/panes/NotificationsPane.tsx'], data: ['notify/notifier.mjs'] },
  'settings.shortcuts': { label: 'Settings › Keyboard', route: '/settings/shortcuts', web: ['web/src/components/ShortcutsSettings.tsx', 'web/src/shortcuts.ts'] },
  'settings.providers': { label: 'Settings › Providers', route: '/settings/providers', web: ['web/src/components/ProvidersView.tsx'], app: ['mobile/src/features/settings/panes/ProvidersPane.tsx', 'mobile/src/features/settings/providers/AccountScreen.tsx'], data: ['providers/instances.mjs', 'ai/settings.mjs'] },
  'settings.tasks': { label: 'Settings › Tasks', route: '/settings/tasks', web: ['web/src/components/TaskSettings.tsx'], app: ['mobile/src/features/settings/panes/TasksPane.tsx', 'mobile/src/features/settings/integrations.tsx'], data: ['todos/service.mjs'] },
  'settings.security': { label: 'Settings › Security', route: '/settings/security', web: ['web/src/components/settings/SecurityPane.tsx'], app: ['mobile/src/features/settings/panes/SecurityPane.tsx'], data: ['auth/approval-code.mjs'] },
} satisfies Record<string, Place>

export type PlaceId = keyof typeof PLACES
