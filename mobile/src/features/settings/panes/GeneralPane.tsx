// Settings → General (web components/settings/GeneralPane.tsx): where the app
// opens, whether it polls, the address other devices reach Totem at, and which
// build is running.
import React from 'react'
import Constants from 'expo-constants'
import * as Updates from 'expo-updates'
import { DEFAULTS, setSetting, useSettings } from '../../../lib/settings'
import { PRODUCTIVITY_APPS, TOOL_LABELS } from '../../../shell/routes'
import { IntegrationFieldRow, useIntegrations } from '../integrations'
import { Loading, Picker, Row, Section, Switch } from '../ui'
import { RestoreDeviceDefaults } from './restoreDefaults'

// The pages the app has (routes.ts), in the web's groups. The web's Dev and Brain
// are left out: the app has no page for them. Every
// Productivity tool is its own page here, and "productivity" opens the hub.
const PAGES = [
  { options: [{ value: 'overview', label: 'Overview' }, { value: 'chat', label: 'Chat' }, { value: 'inbox', label: 'Inbox' }, { value: 'search', label: 'Search' }] },
  {
    title: 'Productivity',
    options: [
      { value: 'productivity', label: 'All tools' },
      ...PRODUCTIVITY_APPS.map((app) => ({ value: app, label: TOOL_LABELS[app] })),
    ],
  },
  { title: 'More', options: [{ value: 'totems', label: 'Totems' }, { value: 'fleet', label: 'Fleet' }] },
]

function buildLine(): string {
  const version = Constants.expoConfig?.version || '?'
  const build = Constants.nativeBuildVersion
  const update = Updates.updateId && !Updates.isEmbeddedLaunch
    ? ` · update ${Updates.updateId.slice(0, 8)}${Updates.createdAt ? ` from ${Updates.createdAt.toLocaleDateString()}` : ''}`
    : ''
  return `Totem for iPhone ${version}${build ? ` (${build})` : ''}${update}`
}

export default function GeneralPane() {
  const s = useSettings()
  const { data, saving, save, error } = useIntegrations()
  const known = PAGES.some((g) => g.options.some((o) => o.value === s.landingTab))
  return (
    <>
      <Section title="Startup">
        <Row
          id="landing-tab"
          title="Open on"
          description="The page the app shows when you open it fresh."
          onReset={s.landingTab !== DEFAULTS.landingTab ? () => setSetting('landingTab', DEFAULTS.landingTab) : undefined}
          control={<Picker label="Open on" value={known ? s.landingTab : 'overview'} groups={PAGES} onChange={(v) => setSetting('landingTab', v)} />}
        />
        <Row
          id="auto-refresh"
          title="Keep pages live"
          description="Refresh open pages like Usage in the background. Off saves battery; pages still load fresh when you open them."
          onReset={s.autoRefresh !== DEFAULTS.autoRefresh ? () => setSetting('autoRefresh', DEFAULTS.autoRefresh) : undefined}
          control={<Switch label="Keep pages live" value={s.autoRefresh} onChange={(v) => setSetting('autoRefresh', v)} />}
        />
      </Section>

      <Section id="server" title="This server" description="Shared by every device that signs in to this Totem.">
        {data ? (
          <IntegrationFieldRow
            id="public-url"
            field={data.publicUrl}
            placeholder="https://totem.example.com"
            description="The address you open Totem at from other devices. Setup links are built from it."
            saving={saving}
            onSave={(v) => save({ [data.publicUrl.name]: v })}
          />
        ) : <Loading error={error} />}
      </Section>

      <Section id="about" title="About">
        <Row title="Version" description={buildLine()} />
      </Section>

      <RestoreDeviceDefaults prefs={[['landingTab', 'Open on'], ['autoRefresh', 'Keep pages live']]} />
    </>
  )
}
