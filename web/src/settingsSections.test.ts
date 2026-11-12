// Settings' sections, the old addresses that still have to land, and the search
// index that points into the panes.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPath, parseLocation, toRoute } from './router'
import { SETTINGS_SECTIONS } from './components/settings/sections'
import { SEARCH_ITEMS, searchSettings } from './components/settings/searchIndex'

const at = (path: string) => {
  const [pathname, hash = ''] = path.split('#')
  return buildPath(parseLocation({ pathname, search: '', hash: hash && `#${hash}` } as Location))
}

describe('settings routes', () => {
  it('opens every section at its own address', () => {
    for (const id of SETTINGS_SECTIONS) expect(at(`/settings/${id}`)).toBe(`/settings/${id}`)
  })

  it('sends the retired panes to where their settings went', () => {
    expect(at('/settings/ai')).toBe('/settings/providers')
    expect(at('/settings/integrations')).toBe('/settings/general#public-url')
    expect(at('/settings/jobs')).toBe('/totems')
    // The bridge's quota notifications still link here.
    expect(at('/settings/providers#usage')).toBe('/settings/usage')
    expect(at('/logs')).toBe('/settings/logs')
    expect(toRoute({ tab: 'studio', sub: 'skills' })).toMatchObject({ tab: 'settings', sub: 'skills' })
  })

  it('keeps a row anchor on a pane that still exists', () => {
    expect(at('/settings/providers#api-keys')).toBe('/settings/providers#api-keys')
  })
})

describe('settings search', () => {
  it('finds a row by its words and by its keywords', () => {
    expect(searchSettings('api key')[0]).toMatchObject({ section: 'providers', id: 'api-keys' })
    expect(searchSettings('dark')[0]).toMatchObject({ section: 'appearance', id: 'background' })
    expect(searchSettings('   ')).toEqual([])
    expect(searchSettings('zzzz-nothing')).toEqual([])
  })

  it('has unique keys', () => {
    const keys = SEARCH_ITEMS.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  // A hit jumps to the element with this id; a renamed or moved row would
  // silently land at the top of the pane instead. Each id must be drawn by its
  // own pane's files.
  it('points only at ids its own pane draws', () => {
    const PANE_FILES: Record<string, string[]> = {
      general: ['components/settings/GeneralPane.tsx'],
      appearance: ['components/settings/AppearancePane.tsx'],
      chat: ['components/ChatSettings.tsx'],
      voice: ['components/VoiceSettings.tsx'],
      notifications: ['components/NotificationsSettings.tsx'],
      shortcuts: ['components/ShortcutsSettings.tsx'],
      providers: ['components/ProvidersView.tsx', 'components/settings/ProviderDefaults.tsx', 'components/settings/ApiKeysSection.tsx'],
      usage: ['components/UsageView.tsx'],
      skills: ['components/SkillsView.tsx'],
      connections: ['components/McpSettingsView.tsx', 'components/ClaudeToolsPanel.tsx', 'components/DataConnectionsPanel.tsx', 'sources/SourceHealthPanel.tsx'],
      tasks: ['components/TaskSettings.tsx'],
      security: ['components/settings/SecurityPane.tsx'],
      logs: ['components/LogsView.tsx'],
    }
    const root = resolve(__dirname)
    const missing = SEARCH_ITEMS.filter((i) => i.id !== i.section).filter((i) => {
      const source = (PANE_FILES[i.section] || []).map((f) => readFileSync(join(root, f), 'utf8')).join('\n')
      return !source.includes(`id="${i.id}"`)
    }).map((i) => i.key)
    expect(missing).toEqual([])
    expect(Object.keys(PANE_FILES).sort()).toEqual([...SETTINGS_SECTIONS].sort())
  })
})
