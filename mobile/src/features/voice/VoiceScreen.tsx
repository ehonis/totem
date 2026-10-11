// Voice mode (web chat/VoiceMode.tsx, the realtime half): a full-screen call
// over the chat. Talk, pause, hear the answer, cut in whenever; the exchange is
// saved to the same chat thread as everything typed, so a spoken conversation
// is a normal chat afterwards.
//
// The web falls back to a local whisper loop when realtime can't run. The
// phone falls back to the composer's dictation (handoff.ts), which is the same
// whisper on the box without the hands-free loop.
import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useKeepAwake } from 'expo-keep-awake'
import { LinearGradient } from 'expo-linear-gradient'
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg'
import { adoptThread, newId, setActive } from '../../lib/chat/store'
import { api } from '../../lib/api'
import { textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { impact, success, tap } from '../../ui/haptics'
import { TI, vc } from '../chat/ui'
import { IconMicrophone, IconMicrophoneOff, IconX } from '../chat/icons'
import { RealtimeVoice } from './realtime'
import { MicError, type RtPhase, type VoiceStatus } from './types'
import { Orb, type OrbPhase } from './Orb'
import { handToDictation } from './handoff'

const RT_CAPTION: Record<RtPhase, string> = {
  connecting: 'Connecting…',
  listening: 'Listening',
  hearing: 'Listening · tap when you’re done',
  thinking: 'Thinking',
  working: 'Working on it',
  speaking: 'Tap to interrupt',
  paused: 'Mic off. Tap the orb to talk',
  error: 'Voice stopped',
  closed: '',
}

function money(n: number) {
  if (!n) return '$0.00'
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
}

/** Leave voice mode for the composer's dictation, saying why. */
function fallBack(why: string) {
  handToDictation(why)
  if (router.canGoBack()) router.back()
}

function Backdrop() {
  // radial-gradient(120% 80% at 50% 45%, #141824 0%, #08090d 70%)
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
      <Defs>
        <RadialGradient id="vc-voice-bg" cx="50%" cy="45%" rx="120%" ry="80%" fx="50%" fy="45%">
          <Stop offset="0" stopColor="#141824" />
          <Stop offset="0.7" stopColor="#08090d" />
          <Stop offset="1" stopColor="#08090d" />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#vc-voice-bg)" />
    </Svg>
  )
}

function Round({ icon, label, onPress, on, end, disabled, size = 22 }: {
  icon: any; label: string; onPress: () => void; on?: boolean; end?: boolean; disabled?: boolean; size?: number
}) {
  return (
    <Press
      onPress={() => { tap(); onPress() }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[st.round, on && st.roundOn, end && st.roundEnd, disabled && { opacity: 0.4 }]}
    >
      <TI icon={icon} size={size} color={end ? '#0f1115' : on ? '#ffb3c0' : textAlpha(94)} />
    </Press>
  )
}

function RealtimeVoiceMode({ threadId, kind, status }: { threadId: string | null; kind: 'regular' | 'temporary'; status: VoiceStatus }) {
  const insets = useSafeAreaInsets()
  const [phase, setPhase] = useState<RtPhase>('connecting')
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [tool, setTool] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [cost, setCost] = useState(0)
  const [fadeTo, setFadeTo] = useState(0)
  const session = useRef<RealtimeVoice | null>(null)
  const id = useRef(threadId || newId())
  const adopted = useRef(false)
  const last = useRef<RtPhase>('connecting')

  useEffect(() => {
    let alive = true
    const rt = new RealtimeVoice(id.current, kind, {
      onPhase: (p) => {
        const prev = last.current
        last.current = p
        // The two moments worth feeling: the call is live, and the answer starts.
        if (p === 'listening' && prev === 'connecting') success()
        if (p === 'speaking' && prev !== 'speaking') impact()
        if (alive) setPhase(p)
      },
      onUserText: (t) => { if (alive) { setHeard(t); setReply('') } },
      onAssistantText: (t) => { if (alive) setReply(t) },
      onTool: (label) => { if (alive) setTool(label) },
      onError: (m) => { if (alive) setError(m) },
      onFatal: (m) => { if (alive) { alive = false; rt.stop(); fallBack(m) } },
      // Turn decisions, for debugging a session that answered too soon or too late.
      onDebug: (m) => { const g = globalThis as any; (g.__totemVoiceLog ||= []).push(`${new Date().toISOString().slice(11, 23)} ${m}`) },
      // Saved even after the screen closes (ending the call flushes the last
      // exchange), so the chat underneath shows it straight away.
      onSaved: (thread, c) => {
        adoptThread(thread)
        if (!adopted.current && id.current !== threadId) { adopted.current = true; setActive(id.current) }
        if (alive) setCost((x) => x + c)
      },
    })
    session.current = rt
    rt.start().catch((e) => {
      if (!alive) return
      // No mic is final; anything on OpenAI's or the bridge's side drops to dictation.
      if (e instanceof MicError) { setError(e.message); setPhase('error'); rt.stop(); return }
      alive = false
      rt.stop()
      fallBack(String(e?.message || e))
    })
    return () => { alive = false; rt.stop() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const muted = phase === 'paused'
  // Tap: cut Totem off while it talks; while you talk, "I'm done, answer".
  const tapOrb = () => { impact(); session.current?.tap() }
  const orbPhase: OrbPhase = phase === 'working' ? 'thinking' : phase === 'connecting' || phase === 'closed' ? 'starting' : phase
  const caption = tool && phase === 'working' ? `${tool}…` : RT_CAPTION[phase]
  const modelName = status.realtime.models.find((m) => m.id === status.realtime.model)?.name || status.realtime.model
  const shown = reply.length > 420 ? `…${reply.slice(-420)}` : reply

  return (
    <View style={[st.voice, { paddingTop: 24 + insets.top, paddingBottom: 28 + insets.bottom }]} accessibilityLabel="Voice mode">
      <Backdrop />
      <View style={st.transcript} accessibilityLiveRegion="polite" onLayout={(e) => setFadeTo(e.nativeEvent.layout.y + e.nativeEvent.layout.height * 0.3)}>
        {heard ? <T size={16} lineHeight={23} color={vc.soft} align="center">{heard}</T> : null}
        {shown ? <T size={19} lineHeight={28} color={vc.text} align="center">{shown}</T> : null}
      </View>
      {/* mask-image: linear-gradient(to bottom, transparent, #000 30%). No masks in
          React Native, so the backdrop's own colour fades over the top of the
          transcript instead, edge to edge so it has no visible sides. */}
      <LinearGradient pointerEvents="none" colors={['#0a0b10', 'rgba(10,11,16,0)']} style={[st.fade, { height: fadeTo }]} />
      <Orb phase={orbPhase} onPress={tapOrb} label={caption} />
      <View style={st.bottom}>
        <T size={15} lineHeight={22} color={vc.soft} align="center" style={st.caption}>{caption}</T>
        {error ? <T size={13} color="#ffb3c0" align="center" style={st.caption}>{error}</T> : null}
        <View style={st.controls}>
          <Round
            icon={muted ? IconMicrophoneOff : IconMicrophone}
            label={muted ? 'Unmute' : 'Mute'}
            on={muted}
            disabled={phase === 'error' || phase === 'connecting'}
            onPress={() => session.current?.setMuted(!muted)}
          />
          <Round icon={IconX} label="End voice mode" end onPress={() => router.back()} />
        </View>
        <T size={12} color={vc.faint} align="center" style={{ marginTop: 4 }}>
          {modelName} · {money(cost)} this chat · {money(status.spend.today + cost)} today
        </T>
      </View>
    </View>
  )
}

/** Voice mode: realtime when the bridge has a key (and it isn't turned off), dictation otherwise. */
export default function VoiceScreen() {
  useKeepAwake('totem-voice')
  const params = useLocalSearchParams<{ threadId?: string; kind?: string }>()
  const threadId = params.threadId || null
  const kind = params.kind === 'temporary' ? 'temporary' : 'regular'
  const [status, setStatus] = useState<VoiceStatus | null>(null)

  useEffect(() => {
    api<VoiceStatus>('/api/voice/status')
      .then((s) => {
        // The web's notes for its local mode, as the reason for dictating.
        if (!s.realtime.configured) return fallBack('Realtime voice needs OPENAI_API_KEY on the bridge.')
        if (s.settings.engine === 'local') return fallBack('Voice is set to local in Settings → Voice.')
        setStatus(s)
      })
      .catch(() => fallBack('Realtime voice is unavailable.'))
  }, [])

  return (
    <>
      {status ? (
        <RealtimeVoiceMode threadId={threadId} kind={kind} status={status} />
      ) : (
        <View style={[st.voice, { justifyContent: 'center' }]}>
          <Backdrop />
          <T size={15} lineHeight={22} color={vc.soft} align="center">Starting…</T>
        </View>
      )}
    </>
  )
}

const st = StyleSheet.create({
  voice: { flex: 1, alignItems: 'center', gap: 22, paddingHorizontal: 24, backgroundColor: '#08090d' },
  transcript: { flex: 1, alignSelf: 'stretch', justifyContent: 'flex-end', gap: 12, minHeight: 0, overflow: 'hidden' },
  bottom: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'space-between', gap: 14, minHeight: 0 },
  fade: { position: 'absolute', top: 0, left: 0, right: 0 },
  caption: { minHeight: 22, maxWidth: 520 },
  controls: { flexDirection: 'row', gap: 18, marginTop: 'auto' },
  round: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff14' },
  roundOn: { backgroundColor: '#f0506e30' },
  roundEnd: { backgroundColor: '#ffffff' },
})
