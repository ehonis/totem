// The Settings sections, in nav order, and where the retired ones went. Pure data:
// router.ts reads it too, so it must not import React or a component.

export const SETTINGS_GROUPS = [
  { heading: null, items: ['general', 'appearance', 'chat', 'voice', 'notifications', 'shortcuts'] },
  { heading: 'AI', items: ['providers', 'usage', 'skills'] },
  { heading: 'Data', items: ['connections', 'tasks'] },
  { heading: 'Account', items: ['security', 'logs'] },
] as const

export type SettingsSection = (typeof SETTINGS_GROUPS)[number]['items'][number]

export const SETTINGS_SECTIONS: readonly SettingsSection[] = SETTINGS_GROUPS.flatMap((g) => g.items)

export const SETTINGS_LABELS: Record<SettingsSection, string> = {
  general: 'General',
  appearance: 'Appearance',
  chat: 'Chat',
  voice: 'Voice',
  notifications: 'Notifications',
  shortcuts: 'Keyboard',
  providers: 'Providers',
  usage: 'Usage',
  skills: 'Skills',
  connections: 'Connections',
  tasks: 'Tasks',
  security: 'Security',
  logs: 'Activity',
}

/**
 * Panes that were folded into others. Old links (bookmarks, notifications the
 * bridge already sent, the iPhone app) still land on the setting they meant.
 * `jobs` became the Totems page: every job is a totem.
 */
export const MOVED_SECTIONS: Record<string, { sub?: SettingsSection; hash?: string; tab?: string }> = {
  ai: { sub: 'providers' },
  integrations: { sub: 'general', hash: 'public-url' },
  jobs: { tab: 'totems' },
}
