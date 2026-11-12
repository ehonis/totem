// Settings → Appearance (web components/settings/AppearancePane.tsx): how the app
// looks on this phone. Every value is kept on this device only (settings.ts).
// A background repaints every screen, and the app's colours are fixed when it
// starts (theme.ts), so a new one applies on a restart the pane offers.
import React from 'react'
import { DevSettings, StyleSheet, View } from 'react-native'
import * as Updates from 'expo-updates'
import { BACKGROUNDS, findBackground } from '../../../lib/backgrounds'
import { DEFAULTS, setSetting, useSettings } from '../../../lib/settings'
import { activeBackground, colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Btn, Press } from '../../../ui/kit'
import { confirm } from '../../../ui/menu'
import { Notice, Row, Section, Switch } from '../ui'
import { RestoreDeviceDefaults } from './restoreDefaults'

async function restart() {
  try {
    await Updates.reloadAsync()
  } catch {
    // A development build without expo-updates' launcher reloads through Metro.
    DevSettings.reload()
  }
}

async function offerRestart() {
  const ok = await confirm('Restart to apply?', {
    message: 'The new background shows once the app restarts. Nothing you were doing is lost.',
    confirmLabel: 'Restart now',
    destructive: false,
  })
  if (ok) await restart()
}

export default function AppearancePane() {
  const s = useSettings()
  const current = findBackground(s.background)
  const pending = current.id !== activeBackground

  const pick = (id: string) => {
    if (id === current.id) return
    setSetting('background', id)
    if (id !== activeBackground) void offerRestart()
  }

  return (
    <>
      {pending ? (
        <Notice tone="info">
          <T size={13} lineHeight={19}>{current.name} shows after a restart.</T>
          <Btn compact title="Restart now" onPress={() => void restart()} style={{ alignSelf: 'flex-start' }} />
        </Notice>
      ) : null}

      <Section title="Theme" description="Saved on this phone only.">
        <Row
          id="background"
          stacked
          title="Background"
          description={`The colour behind the app, the drawer and the cards. Now: ${current.name}.`}
          onReset={current.id !== findBackground(DEFAULTS.background).id ? () => pick(DEFAULTS.background) : undefined}
          control={
            <View style={st.swatches} accessibilityRole="radiogroup" accessibilityLabel="Background">
              {BACKGROUNDS.map((b) => {
                const on = current.id === b.id
                return (
                  <Press
                    key={b.id}
                    haptic
                    onPress={() => pick(b.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={b.name}
                    style={st.swatch}
                  >
                    <View style={[st.chip, { backgroundColor: b.bg, borderColor: on ? colors.accent : b.line }, on && st.chipOn]}>
                      <View style={[st.bar, { backgroundColor: b.rail }]} />
                      <View style={[st.card, { backgroundColor: b.panel }]} />
                    </View>
                    <T size={11.5} muted={!on} weight={on ? 600 : 400} numberOfLines={1} style={{ textAlign: 'center' }}>{b.name}</T>
                  </Press>
                )
              })}
            </View>
          }
        />
        <Row
          id="chat-glow"
          title="Colour glow in chats"
          description="Each chat’s slowly moving colour. It keeps the graphics busy while a chat is open; off gives a plain background."
          onReset={s.chatGlow !== DEFAULTS.chatGlow ? () => setSetting('chatGlow', DEFAULTS.chatGlow) : undefined}
          control={<Switch label="Colour glow in chats" value={s.chatGlow} onChange={(v) => setSetting('chatGlow', v)} />}
        />
      </Section>

      {/* The web's Compact density is not here: no screen in the app has a denser layout to switch to. */}
      <Section title="Motion">
        <Row
          id="reduce-motion"
          title="Reduce motion"
          description="Turn off animations and transitions across the app. The phone’s own Reduce Motion setting does too."
          onReset={s.reduceMotion !== DEFAULTS.reduceMotion ? () => setSetting('reduceMotion', DEFAULTS.reduceMotion) : undefined}
          control={<Switch label="Reduce motion" value={s.reduceMotion} onChange={(v) => setSetting('reduceMotion', v)} />}
        />
      </Section>

      <RestoreDeviceDefaults
        prefs={[['background', 'Background'], ['chatGlow', 'Colour glow in chats'], ['reduceMotion', 'Reduce motion']]}
        onRestored={(keys) => { if (keys.includes('background') && DEFAULTS.background !== activeBackground) void offerRestart() }}
      />
    </>
  )
}

const st = StyleSheet.create({
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  swatch: { width: 70, gap: 5 },
  chip: { height: 46, borderRadius: 9, borderWidth: 1.5, overflow: 'hidden', flexDirection: 'row', padding: 5, gap: 4 },
  chipOn: { borderWidth: 2 },
  bar: { width: 9, borderRadius: 3 },
  card: { flex: 1, borderRadius: 4 },
})
