// The red button (JournalView.tsx ▸ RecorderPanel on the web), recording with
// expo-audio instead of MediaRecorder. Same three faces: ready/recording (button,
// clock, live waveform, hint, Pause/Resume), review (envelope, playback, Discard /
// Save), and "Type an entry instead" under both idle states.
//
// The panel owns the recorder, so the once-a-second clock re-renders this card
// and not the whole list of entries under it.
import React, { useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { colors, alpha, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { Btn, Press } from '../../ui/kit'
import { impact } from '../../ui/haptics'
import {
  ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon, Hi, MicrophoneIcon, PauseIcon, PencilIcon, PlayIcon,
  StopSolidIcon, TrashIcon,
} from '../../lib/icons'
import { fmtClock } from '../../lib/journal/format'
import { useRecorder, type RecorderResult } from './useRecorder'
import Waveform from './Waveform'
import { AudioBar, Spin } from './bits'

interface RecorderPanelProps {
  engineReady: boolean
  delayMinutes: number
  /** Upload the take. Resolve true when it is saved (the panel then forgets it). */
  onSave: (r: RecorderResult) => Promise<boolean>
  onSaveText: (text: string) => Promise<boolean>
}

export default function RecorderPanel({ engineReady, delayMinutes, onSave, onSaveText }: RecorderPanelProps) {
  const recorder = useRecorder()
  const { state, elapsed, levelRef, samplesRef, result, error } = recorder
  const live = state === 'recording' || state === 'paused'
  const [saving, setSaving] = useState(false)
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const halo = useSharedValue(0)
  const haloStyle = useAnimatedStyle(() => ({
    opacity: withTiming(live ? 1 : 0, { duration: 150 }),
    transform: [{ scale: withTiming(0.9 + halo.value * 0.55, { duration: 80 }) }],
  }), [live])

  const mainLabel = live ? 'Stop recording' : state === 'requesting' ? 'Starting…' : 'Start recording'
  const onMain = () => {
    impact()
    if (state === 'idle' || state === 'denied') void recorder.start()
    else if (live) void recorder.stop()
  }

  const save = async () => {
    if (!result) return
    setSaving(true)
    try { if (await onSave(result)) recorder.reset() } finally { setSaving(false) }
  }
  const saveText = async () => {
    const t = text.trim()
    if (!t) return
    setSaving(true)
    try { if (await onSaveText(t)) { setText(''); setTyping(false) } } finally { setSaving(false) }
  }

  return (
    <View style={[st.panel, live && { borderColor: mixRed }]}>
      {state !== 'stopped' ? (
        <>
          <View style={st.stage}>
            <Animated.View pointerEvents="none" style={[st.ring, haloStyle]} />
            <Press
              onPress={onMain}
              disabled={state === 'requesting'}
              accessibilityRole="button"
              accessibilityLabel={mainLabel}
              style={[st.btn, live && { borderColor: alpha(colors.red, 0.7) }]}
            >
              {live ? <Hi icon={StopSolidIcon} size={30} color={colors.red} /> : (
                <LinearGradient
                  colors={['#ff8aa0', colors.red, '#c4324f']}
                  locations={[0, 0.55, 1]}
                  start={{ x: 0.25, y: 0.15 }}
                  end={{ x: 0.8, y: 0.95 }}
                  style={[st.dot, state === 'requesting' && { opacity: 0.55 }]}
                />
              )}
            </Press>
          </View>
          <View style={st.readout}>
            <T
              size={30}
              weight={600}
              lineHeight={34}
              color={state === 'paused' ? colors.muted : live ? colors.red : colors.text}
              style={{ fontVariant: ['tabular-nums'], letterSpacing: 0.5 }}
            >
              {fmtClock(elapsed)}
            </T>
            <View style={st.wave}>
              <Waveform
                samplesRef={samplesRef}
                levelRef={levelRef}
                halo={halo}
                live={live}
                paused={state === 'paused'}
                height={56}
                label={live ? 'Live microphone level — the bars move while you talk' : 'Microphone level'}
              />
            </View>
            <T size={12.5} muted align="center" lineHeight={18} style={{ maxWidth: 460 }}>
              {state === 'recording' && 'Recording — tap the square when you’re done.'}
              {state === 'paused' && 'Paused.'}
              {state === 'requesting' && 'Waiting for the microphone…'}
              {(state === 'idle' || state === 'denied') && (engineReady
                ? 'Tap to record. Talk about yesterday; it’s transcribed here, then digested into your brain.'
                : 'Transcription isn’t installed on the bridge yet — recordings will wait as failed until it is. Typing works now.')}
            </T>
            {live && (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                {state === 'recording'
                  ? <Btn compact icon={PauseIcon} title="Pause" onPress={recorder.pause} />
                  : <Btn compact icon={PlayIcon} title="Resume" onPress={recorder.resume} />}
              </View>
            )}
          </View>
        </>
      ) : (
        <View style={st.review}>
          <View style={st.reviewHead}>
            <Hi icon={MicrophoneIcon} size={18} color={colors.red} />
            <View style={{ flex: 1 }}>
              <T size={16} weight={600} style={{ fontVariant: ['tabular-nums'] }}>{fmtClock(result?.durationSec ?? 0)} recorded</T>
              <T size={12.5} muted lineHeight={18}>
                Save to transcribe. The digest runs {delayMinutes} min later unless you press <T size={12.5} weight={600}>Don’t ingest</T> on the entry.
              </T>
            </View>
          </View>
          <Waveform samples={result?.waveform || []} height={64} idleColor={colors.accent} label="Waveform of the recording you just made" />
          {result ? <AudioBar source={result.uri} /> : null}
          <View style={st.reviewActions}>
            <Btn compact kind="danger" icon={TrashIcon} title="Discard" onPress={recorder.reset} disabled={saving} />
            <Btn kind="primary" onPress={save} disabled={saving} style={{ paddingHorizontal: 18 }}>
              {saving ? <Spin icon={ArrowPathIcon} size={14} color={colors.white} /> : <Hi icon={CheckCircleIcon} size={16} color={colors.white} />}
              <T weight={600} color={colors.white}>{saving ? 'Saving…' : 'Save'}</T>
            </Btn>
          </View>
        </View>
      )}

      {error ? (
        <View style={st.error}>
          <Hi icon={ExclamationTriangleIcon} size={14} color={colors.red} />
          <View style={{ flex: 1, gap: 6 }}>
            <T size={12.5} color={colors.red} lineHeight={18}>{error}</T>
            {state === 'denied' ? (
              <Press onPress={() => { void Linking.openSettings() }}>
                <T size={12.5} weight={600} color={colors.text} style={{ textDecorationLine: 'underline' }}>Open Settings</T>
              </Press>
            ) : null}
          </View>
        </View>
      ) : null}

      {!live && state !== 'stopped' && (
        <View style={st.type}>
          {typing ? (
            <View style={{ width: '100%', gap: 8 }}>
              <TextInput
                autoFocus
                multiline
                value={text}
                onChangeText={setText}
                editable={!saving}
                placeholder="What happened yesterday? Type it the way you’d say it."
                placeholderTextColor={colors.muted}
                keyboardAppearance="dark"
                selectionColor={colors.accent}
                style={st.textarea}
              />
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                <Btn compact title="Cancel" onPress={() => setTyping(false)} disabled={saving} />
                <Btn compact kind="primary" title={saving ? 'Saving…' : 'Save entry'} onPress={saveText} disabled={saving || !text.trim()} />
              </View>
            </View>
          ) : (
            <Press onPress={() => setTyping(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Hi icon={PencilIcon} size={12} color={colors.muted} />
              <T size={12} muted style={{ textDecorationLine: 'underline' }}>Type an entry instead</T>
            </Press>
          )}
        </View>
      )}
    </View>
  )
}

// color-mix(in srgb, var(--red) 45%, var(--line))
const mixRed = '#813c50'

const st = StyleSheet.create({
  panel: {
    backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 12,
    paddingTop: 22, paddingHorizontal: 18, paddingBottom: 16, alignItems: 'center', gap: 12,
  },
  stage: { width: 112, height: 112, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: 112, height: 112, borderRadius: 56, backgroundColor: alpha(colors.red, 0.2) },
  btn: {
    width: 76, height: 76, borderRadius: 38, backgroundColor: colors.bg3, borderWidth: 3, borderColor: '#3a3f4d',
    alignItems: 'center', justifyContent: 'center',
  },
  dot: {
    width: 56, height: 56, borderRadius: 28,
    shadowColor: colors.red, shadowOpacity: 0.45, shadowRadius: 10, shadowOffset: { width: 0, height: 2 },
  },
  readout: { alignItems: 'center', gap: 6, width: '100%' },
  wave: { width: '100%', maxWidth: 460 },
  review: { width: '100%', gap: 12 },
  reviewHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  reviewActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  error: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, alignSelf: 'stretch',
    backgroundColor: alpha(colors.red, 0.1), borderWidth: 1, borderColor: alpha(colors.red, 0.3), borderRadius: 8,
    paddingVertical: 8, paddingHorizontal: 11,
  },
  type: { width: '100%', alignItems: 'center' },
  textarea: {
    minHeight: 96, textAlignVertical: 'top', backgroundColor: colors.bg, color: colors.text,
    borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10,
    fontSize: 16, fontFamily: fonts[400],
  },
})
