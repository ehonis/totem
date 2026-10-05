export type QuickPanelId = 'limits' | 'activity' | 'repositories'

export const QUICK_PANEL_COMMANDS = {
  quickLimits: 'quick-panel.limits',
  quickActivity: 'quick-panel.activity',
  quickRepositories: 'quick-panel.repositories',
} as const

/**
 * Shortcut metadata lives beside the panels rather than being repeated across
 * the action registry, default bindings, and command subscribers.
 */
export const QUICK_PANEL_SHORTCUTS = [
  {
    panel: 'limits',
    actionId: 'cmd.quickLimits',
    label: 'AI usage limits',
    command: QUICK_PANEL_COMMANDS.quickLimits,
    binding: 'u',
    chainable: true,
  },
  {
    panel: 'activity',
    actionId: 'cmd.quickActivity',
    label: 'Totem usage',
    command: QUICK_PANEL_COMMANDS.quickActivity,
    binding: 'ua',
    chainable: false,
  },
  {
    panel: 'repositories',
    actionId: 'cmd.quickRepositories',
    label: 'Repositories',
    command: QUICK_PANEL_COMMANDS.quickRepositories,
    binding: 'ur',
    chainable: false,
  },
] as const
