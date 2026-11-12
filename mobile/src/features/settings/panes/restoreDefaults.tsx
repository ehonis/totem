// T3's "Restore device defaults" (web SettingsView.tsx), at the foot of General
// and Appearance: each resets only its own pane's device preferences.
import React from 'react'
import { DEFAULTS, setSetting, useSettings, type Settings } from '../../../lib/settings'
import { pushSuccess } from '../../../lib/toast'
import { confirm } from '../../../ui/menu'
import { Row, Section } from '../ui'

export function RestoreDeviceDefaults({ prefs, onRestored }: { prefs: [keyof Settings, string][]; onRestored?: (keys: (keyof Settings)[]) => void }) {
  const s = useSettings()
  const changed = prefs.filter(([k]) => JSON.stringify(s[k]) !== JSON.stringify(DEFAULTS[k]))
  return (
    <Section description={changed.length ? `Changed on this phone: ${changed.map(([, label]) => label).join(', ')}.` : 'Nothing here differs from the defaults.'}>
      <Row
        title="Restore device defaults"
        tone={changed.length ? 'accent' : undefined}
        disabled={!changed.length}
        onPress={async () => {
          if (!changed.length) return
          const ok = await confirm('Restore device defaults?', {
            message: changed.map(([, label]) => `• ${label}`).join('\n'),
            confirmLabel: 'Restore',
            destructive: false,
          })
          if (!ok) return
          for (const [k] of changed) setSetting(k, DEFAULTS[k] as never)
          pushSuccess('Device defaults restored')
          onRestored?.(changed.map(([k]) => k))
        }}
      />
    </Section>
  )
}
