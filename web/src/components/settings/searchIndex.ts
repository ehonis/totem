import { SETTINGS_LABELS, SETTINGS_SECTIONS, type SettingsSection } from './sections'

// What the Settings search finds. `id` is the element the pane gives that row
// or section (SettingsRow / SettingsSection `id`), so a hit opens the pane and
// brings the row into view. A hit on a whole pane uses the pane's own id.
// settingsSections.test.ts checks every id here is drawn by some pane.

export interface SettingsSearchItem {
  key: string
  section: SettingsSection
  id: string
  title: string
  /** The section inside the pane, shown under the title. */
  where?: string
  keywords?: string
}

type Entry = [id: string, title: string, where?: string, keywords?: string]

const ENTRIES: Partial<Record<SettingsSection, Entry[]>> = {
  general: [
    ['landing-tab', 'Open on', 'Startup', 'default tab landing start page home'],
    ['auto-refresh', 'Keep pages live', 'Startup', 'auto refresh poll background battery'],
    ['public-url', 'Public URL', 'This server', 'address domain host PUBLIC_URL setup link'],
    ['about', 'Version', 'About', 'build commit release'],
  ],
  appearance: [
    ['background', 'Background', 'Theme', 'colour color theme palette dark black'],
    ['chat-glow', 'Colour glow in chats', 'Theme', 'color glow gpu animation'],
    ['compact', 'Compact density', 'Layout and motion', 'spacing dense'],
    ['reduce-motion', 'Reduce motion', 'Layout and motion', 'animation transitions accessibility'],
  ],
  chat: [
    ['follow-up', 'While a reply is running', 'Sending', 'queue steer follow-up enter'],
    ['auto-settle', 'Settle quiet chats', 'Chat list', 'archive settled days'],
    ['totems-in-chat', 'Let chats bring in totems', 'Totems', 'group totem agents'],
    ['titles', 'Name chats automatically', 'Titles', 'thread title naming'],
    ['title-account', 'Title account', 'Titles', 'title model provider effort'],
  ],
  voice: [
    ['voice-engine', 'Voice engine', 'Voice mode', 'realtime local openai spend cost'],
    ['realtime-model', 'Realtime model', 'Voice mode', 'openai gpt realtime'],
    ['realtime-voice', 'Realtime voice', 'Voice mode', 'marin cedar'],
    ['transcription', 'Local transcription', 'Voice mode', 'whisper dictation speech to text'],
    ['reading-voice', 'Reading voice', 'Reading aloud', 'read aloud tts text to speech'],
    ['speaking-rate', 'Speaking rate', 'Reading aloud', 'speed tts'],
  ],
  notifications: [
    ['push-toggle', 'Push notifications', 'This device', 'notify alerts permission'],
    ['push-test', 'Send a test notification', 'This device', 'test push'],
    ['push-devices', 'Devices', 'Devices', 'phones registered expired'],
    ['dedupe', 'Hold back repeats', 'Duplicates', 'dedupe duplicates repeats'],
    ['same-story', 'Same story', 'Duplicates', 'headline match news'],
    ['model-check', 'Ask a model about close calls', 'Duplicates', 'dedupe ai'],
  ],
  shortcuts: [
    ['shortcuts-enabled', 'Keyboard shortcuts', 'Shortcuts', 'hotkeys keys'],
    ['leader', 'Leader key', 'Shortcuts', 'hotkey prefix'],
    ['grace', 'Grace period', 'Shortcuts', 'timeout sequence'],
    ['shortcut-hints', 'Show hints', 'Shortcuts', 'hud overlay'],
  ],
  providers: [
    ['default-account', 'Default account', 'Defaults', 'default provider ai cli agent'],
    ['default-model', 'Default model', 'Defaults', 'model ai'],
    ['accounts', 'Accounts', 'Accounts', 'claude codex cursor opencode login sign in streaming models environment'],
    ['api-keys', 'API keys', 'API keys', 'anthropic openai cursor key token'],
    ['cliproxy', 'CLIProxy', 'CLIProxy', 'proxy pool management key'],
  ],
  usage: [
    ['quota', 'Live quota', 'Usage', 'limits rate quota meters tracking prices'],
    ['activity', 'Assistant activity', 'Usage', 'requests channels'],
    ['subscriptions', 'Subscriptions', 'Usage', 'price renewal plan cost'],
  ],
  skills: [
    ['skills', 'Skills', undefined, 'prompts commands slash instructions'],
  ],
  connections: [
    ['conn-sources', 'Data sources', 'Connections', 'health sync failing'],
    ['conn-mcp', 'MCP servers', 'Connections', 'mcp gateway servers sign in'],
    ['conn-accounts', 'Gmail, Drive, WHOOP and Strava', 'Accounts', 'google email drive whoop strava'],
    ['conn-data', 'Weather and news', 'Built-in data', 'weather news feeds'],
    ['conn-claude', 'Claude tools', 'Connections', 'connectors claude tools allow deny'],
    ['conn-add', 'Add a connection', 'Connections', 'catalog custom server'],
  ],
  tasks: [
    ['venture-tags', 'Venture tags', 'Tasks', 'ventures tags projects clients'],
    ['task-sheet', 'Task sheet', 'Tasks', 'spreadsheet action items sheet google drive read-only assignees'],
    ['task-retention', 'Retention', 'Tasks', 'archive completed finished recycle bin purge empty delete days time'],
  ],
  security: [
    ['approval-code', 'Approval code', 'Security', 'approve send second factor'],
    ['change-login', 'Change password', 'Sign-in', 'passphrase credentials'],
    ['sign-out', 'Sign out', 'Sign-in', 'logout log out'],
  ],
  logs: [
    ['logs', 'Activity log', undefined, 'logs audit approvals runs history outputs'],
  ],
}

export const SEARCH_ITEMS: SettingsSearchItem[] = [
  ...SETTINGS_SECTIONS.map((section) => ({ key: section, section, id: section, title: SETTINGS_LABELS[section] })),
  ...Object.entries(ENTRIES).flatMap(([section, entries]) => (entries || [])
    .filter(([id]) => id !== section)
    .map(([id, title, where, keywords]) => ({ key: `${section}:${id}`, section: section as SettingsSection, id, title, where, keywords }))),
]

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

/** Every word of the query must appear; titles that start with it rank first. */
export function searchSettings(query: string, items: SettingsSearchItem[] = SEARCH_ITEMS): SettingsSearchItem[] {
  const words = norm(query).split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const scored: { item: SettingsSearchItem; score: number }[] = []
  for (const item of items) {
    const title = norm(item.title)
    const hay = `${title} ${norm(item.where || '')} ${norm(SETTINGS_LABELS[item.section])} ${norm(item.keywords || '')}`
    if (!words.every((w) => hay.includes(w))) continue
    const first = words[0]
    const score = (title.startsWith(first) ? 0 : title.includes(first) ? 1 : 2) + (item.id === item.section ? 0.5 : 0)
    scored.push({ item, score })
  }
  return scored.sort((a, b) => a.score - b.score || a.item.title.localeCompare(b.item.title)).slice(0, 30).map((s) => s.item)
}
