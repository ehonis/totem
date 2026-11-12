import React from 'react'
import { DEFAULTS, setSetting, useSettings } from '../../settings'
import { BACKGROUNDS, findBackground } from '../../backgrounds'
import { SettingsPage, SettingsRow, SettingsSection, Switch } from './ui'

// Settings → Appearance: how Totem looks on this device. Every value here is
// kept in this browser only (settings.ts), so a phone and a laptop can differ.

export default function AppearancePane() {
  const s = useSettings()
  const current = findBackground(s.background)
  return (
    <SettingsPage>
      <SettingsSection title="Theme" description="Saved on this device only.">
        <SettingsRow
          id="background"
          stack
          title="Background"
          description={`The colour behind the app, the sidebar and the rail. Now: ${current.name}.`}
          onReset={current.id !== findBackground(DEFAULTS.background).id ? () => setSetting('background', DEFAULTS.background) : undefined}
          control={
            <div className="bg-swatches" role="radiogroup" aria-label="Background">
              {BACKGROUNDS.map((b) => {
                const on = current.id === b.id
                return (
                  <button key={b.id} type="button" role="radio" aria-checked={on} className={`bg-swatch${on ? ' on' : ''}`} onClick={() => setSetting('background', b.id)} title={b.name}>
                    <span className="bg-swatch-chip" style={{ background: b.bg }}>
                      <i style={{ background: b.rail }} />
                      <i style={{ background: b.panel }} />
                    </span>
                    <span className="bg-swatch-name">{b.name}</span>
                  </button>
                )
              })}
            </div>
          }
        />
        <SettingsRow
          id="chat-glow"
          title="Colour glow in chats"
          description="Each chat’s slowly moving colour. It keeps the graphics card busy while a chat is open; off gives a plain background."
          onReset={s.chatGlow !== DEFAULTS.chatGlow ? () => setSetting('chatGlow', DEFAULTS.chatGlow) : undefined}
          control={<Switch label="Colour glow in chats" checked={s.chatGlow} onChange={(v) => setSetting('chatGlow', v)} />}
        />
      </SettingsSection>

      <SettingsSection title="Layout and motion">
        <SettingsRow
          id="compact"
          title="Compact density"
          description="Tighter spacing, so more fits on screen."
          onReset={s.compact !== DEFAULTS.compact ? () => setSetting('compact', DEFAULTS.compact) : undefined}
          control={<Switch label="Compact density" checked={s.compact} onChange={(v) => setSetting('compact', v)} />}
        />
        <SettingsRow
          id="reduce-motion"
          title="Reduce motion"
          description="Turn off animations and transitions across the app."
          onReset={s.reduceMotion !== DEFAULTS.reduceMotion ? () => setSetting('reduceMotion', DEFAULTS.reduceMotion) : undefined}
          control={<Switch label="Reduce motion" checked={s.reduceMotion} onChange={(v) => setSetting('reduceMotion', v)} />}
        />
      </SettingsSection>
    </SettingsPage>
  )
}
