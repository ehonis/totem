import React from 'react'
import { DEFAULTS, setSetting, useSettings } from '../../settings'
import { IntegrationFieldRow, useIntegrations } from '../IntegrationsSettings'
import { SettingsPage, SettingsRow, SettingsSection, Switch } from './ui'

// Settings → General: where Totem opens, whether it polls, the address other
// devices reach it at, and which build is running.

// Only pages the router actually has (router.ts TAB_IDS / PRODUCTIVITY_APPS).
const PAGES: { group?: string; options: [string, string][] }[] = [
  { options: [['overview', 'Overview'], ['chat', 'Chat'], ['inbox', 'Inbox'], ['search', 'Search']] },
  { group: 'Productivity', options: [['productivity', 'Last app you used'], ['calendar', 'Calendar'], ['todos', 'Tasks'], ['habits', 'Habits'], ['goals', 'Goals'], ['lists', 'Lists'], ['recs', 'Recommendations'], ['journal', 'Journal']] },
  { group: 'More', options: [['totems', 'Totems'], ['dev', 'Dev'], ['fleet', 'Fleet'], ['brain', 'Brain']] },
]

export default function GeneralPane({ onAuthError }: { onAuthError: () => void }) {
  const s = useSettings()
  const { data, saving, save, error } = useIntegrations(onAuthError)
  const { version, date, commit } = __TOTEM_VERSION__
  const known = PAGES.some((g) => g.options.some(([id]) => id === s.landingTab))
  return (
    <SettingsPage>
      <SettingsSection title="Startup">
        <SettingsRow
          id="landing-tab"
          title="Open on"
          description="The page Totem shows when you open it fresh on this device."
          onReset={s.landingTab !== DEFAULTS.landingTab ? () => setSetting('landingTab', DEFAULTS.landingTab) : undefined}
          control={
            <select className="model-select" aria-label="Open on" value={known ? s.landingTab : 'overview'} onChange={(e) => setSetting('landingTab', e.target.value)}>
              {PAGES.map((g) => {
                const opts = g.options.map(([id, label]) => <option key={id} value={id}>{label}</option>)
                return g.group ? <optgroup key={g.group} label={g.group}>{opts}</optgroup> : opts
              })}
            </select>
          }
        />
        <SettingsRow
          id="auto-refresh"
          title="Keep pages live"
          description="Refresh open pages like Usage in the background. Off saves battery; pages still load fresh when you open them."
          onReset={s.autoRefresh !== DEFAULTS.autoRefresh ? () => setSetting('autoRefresh', DEFAULTS.autoRefresh) : undefined}
          control={<Switch label="Keep pages live" checked={s.autoRefresh} onChange={(v) => setSetting('autoRefresh', v)} />}
        />
      </SettingsSection>

      <SettingsSection id="server" title="This server" description="Shared by every device that signs in to this Totem.">
        {data ? (
          <IntegrationFieldRow
            id="public-url"
            field={data.publicUrl}
            placeholder="https://totem.example.com"
            description="The address you open Totem at from other devices. Setup links are built from it."
            saving={saving}
            onSave={(v) => save({ [data.publicUrl.name]: v })}
          />
        ) : <p className={error ? 's-error' : 'muted'}>{error || 'Loading…'}</p>}
      </SettingsSection>

      <SettingsSection id="about" title="About">
        <SettingsRow
          title="Version"
          description={`Built ${date}${commit ? ` from ${commit}` : ''}. It goes up by one with every change merged to main.`}
          control={<span className="muted">Totem {version}</span>}
        />
      </SettingsSection>
    </SettingsPage>
  )
}
