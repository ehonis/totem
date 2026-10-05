import React, { useEffect, useRef, useState } from 'react'
import { send, stop, onStreamEvent, useChat, adoptThread, newId } from './store'
import { RealtimeVoice, type RtPhase } from './realtime'
import { api } from '../api'
import { transcribe } from './api'
import { closeMic, listenForUtterance, micUnavailableReason, openMic, type Utterance } from './recorder'
import { createSpeaker, speechSupported, unlockSpeech, type Speaker } from './speech'
import { TI } from './ui'
import { IconX, IconMicrophone, IconMicrophoneOff, IconPlayerStopFilled } from './icons'

// Voice mode: talk, pause, hear the answer, talk again — the ChatGPT loop, run
// against the same chat thread as everything typed, so a spoken conversation is
// a normal chat afterwards (searchable, continuable by keyboard).
//
//   listening  → mic open, waiting for speech then for a pause
//   thinking   → transcribing on the box, then waiting for the first words
//   speaking   → reading the reply aloud as it streams
//
// The mic is closed while Totem speaks, so it can't hear itself. Tap the orb to
// cut it off and talk.

// getUserMedia's errors are DOMException names; say what they mean.
function micError(e: any): string {
  if (e?.name === 'NotAllowedError') return 'Microphone access is blocked. Allow it for this site in your browser settings, then try again.'
  if (e?.name === 'NotFoundError') return 'No microphone found on this device.'
  if (e?.name === 'NotReadableError') return 'The microphone is in use by another app.'
  return e?.message || 'The microphone could not be opened.'
}

type Phase = 'starting' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'error'

function LocalVoiceMode({ threadId, kind, onThread, onClose, note }: {
  threadId: string | null
  kind: 'regular' | 'temporary'
  onThread: (id: string) => void
  onClose: () => void
  note?: string
}) {
  const [phase, setPhase] = useState<Phase>('starting')
  const [level, setLevel] = useState(0)
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')
  const stream = useRef<MediaStream | null>(null)
  const utterance = useRef<Utterance | null>(null)
  const speaker = useRef<Speaker | null>(null)
  const thread = useRef<string | null>(threadId)
  const alive = useRef(true)
  const paused = useRef(false)
  const runs = useChat((s) => s.runs)

  function listen() {
    if (!alive.current || paused.current || !stream.current) return
    setPhase('listening')
    setLevel(0)
    const u = listenForUtterance(stream.current, { onLevel: setLevel, silenceMs: 1100, maxWaitMs: 45_000 })
    utterance.current = u
    u.result.then(async (blob) => {
      utterance.current = null
      if (!alive.current || paused.current) return
      if (!blob) return listen()
      setPhase('thinking')
      setReply('')
      let text = ''
      try { text = await transcribe(blob) } catch (e: any) { setError(e.message); return listen() }
      if (!alive.current) return
      // Whisper hallucinates these on a cough or a door; they are not requests.
      if (!text || /^\(?\[?(blank_audio|silence|music|beep|inaudible)\]?\)?\.?$/i.test(text) || text.replace(/[^a-z]/gi, '').length < 2) return listen()
      setHeard(text)
      setError('')
      const id = send({ threadId: thread.current, text, voice: true, kind })
      if (id !== thread.current) { thread.current = id; onThread(id) }
    })
  }

  useEffect(() => {
    alive.current = true
    const why = micUnavailableReason()
    if (why) { setError(why); setPhase('error'); return }
    unlockSpeech()
    let fullText = ''
    // One speaker per reply: it tracks how much of *this* reply has been spoken.
    const fresh = () => {
      speaker.current?.stop()
      speaker.current = createSpeaker({
        onStart: () => { if (alive.current) setPhase('speaking') },
        onIdle: () => { if (alive.current && !paused.current) listen() },
      })
    }
    fresh()
    const off = onStreamEvent((id, e) => {
      if (id !== thread.current) return
      if (e.type === 'start') { fullText = ''; fresh(); return }
      if (e.type === 'delta') {
        fullText += e.text
        setReply(fullText)
        speaker.current?.feed(fullText)
      } else if (e.type === 'done') {
        const final = e.message.content || fullText
        setReply(final)
        if (!speechSupported()) return listen()
        speaker.current?.finish(final)
      } else if (e.type === 'error') {
        setError(e.text)
        speaker.current?.finish('Sorry, that one failed.')
      }
    })
    openMic()
      .then((s) => { stream.current = s; if (alive.current) listen(); else closeMic(s) })
      .catch((e) => {
        setError(micError(e))
        setPhase('error')
      })
    return () => {
      alive.current = false
      off()
      utterance.current?.cancel()
      speaker.current?.stop()
      closeMic(stream.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function tapOrb() {
    if (phase === 'speaking') { speaker.current?.stop(); listen(); return }
    if (phase === 'listening') { utterance.current?.finish(); return }
    if (phase === 'thinking' && thread.current && runs[thread.current]) { stop(thread.current); speaker.current?.stop(); return }
    if (phase === 'paused') { paused.current = false; listen() }
  }

  function togglePause() {
    if (paused.current) { paused.current = false; listen(); return }
    paused.current = true
    utterance.current?.cancel()
    speaker.current?.stop()
    setPhase('paused')
  }

  const caption = {
    starting: 'Starting…',
    listening: heard ? 'Listening' : 'Go ahead, I’m listening',
    thinking: 'Thinking',
    speaking: 'Tap to interrupt',
    paused: 'Mic off. Tap the orb to talk',
    error: error || 'Voice mode stopped',
  }[phase]

  return (
    <div className={`vc-voice phase-${phase}`} role="dialog" aria-label="Voice mode">
      <div className="vc-voice-transcript" aria-live="polite">
        {heard && <p className="vc-voice-heard">{heard}</p>}
        {reply && <p className="vc-voice-reply">{reply.length > 420 ? `…${reply.slice(-420)}` : reply}</p>}
      </div>
      <button type="button" className="vc-orb" onClick={tapOrb} aria-label={caption} style={{ ['--lvl' as any]: phase === 'listening' ? level : 0 }}>
        <span className="vc-orb-core" />
        <span className="vc-orb-ring" />
      </button>
      <div className="vc-voice-bottom">
      <div className="vc-voice-caption">{caption}</div>
      {error && phase !== 'error' && <div className="vc-voice-error">{error}</div>}
      <div className="vc-voice-controls">
        <button type="button" className={`vc-round ${phase === 'paused' ? 'on' : ''}`} onClick={togglePause} aria-label={phase === 'paused' ? 'Unmute' : 'Mute'} disabled={phase === 'error'}>
          <TI icon={phase === 'paused' ? IconMicrophoneOff : IconMicrophone} size={22} />
        </button>
        {phase === 'thinking' && thread.current && runs[thread.current] && (
          <button type="button" className="vc-round" onClick={() => stop(thread.current!)} aria-label="Stop the answer"><TI icon={IconPlayerStopFilled} size={18} /></button>
        )}
        <button type="button" className="vc-round end" onClick={onClose} aria-label="End voice mode"><TI icon={IconX} size={22} /></button>
      </div>
      {note && <div className="vc-voice-engine">{note}</div>}
      </div>
    </div>
  )
}

// --- Realtime (ChatGPT-grade) voice ------------------------------------------


interface VoiceStatus {
  realtime: { configured: boolean; model: string; voice: string; models: { id: string; name: string }[] }
  local: { ready: boolean }
  settings: { engine: 'auto' | 'realtime' | 'local' }
  spend: { today: number; month: number }
}

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

function RealtimeVoiceMode({ threadId, kind, onThread, onClose, status, onFallback }: {
  threadId: string | null
  kind: 'regular' | 'temporary'
  onThread: (id: string) => void
  onClose: () => void
  status: VoiceStatus
  onFallback: (why: string) => void
}) {
  const [phase, setPhase] = useState<RtPhase>('connecting')
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [tool, setTool] = useState<string | null>(null)
  const [error, setError] = useState('')
  const orbRef = useRef<HTMLButtonElement>(null)
  const [cost, setCost] = useState(0)
  const session = useRef<RealtimeVoice | null>(null)
  const id = useRef(threadId || newId())

  useEffect(() => {
    let alive = true
    const rt = new RealtimeVoice(id.current, kind, {
      onPhase: (p) => { if (alive) setPhase(p) },
      onUserText: (t) => { if (alive) { setHeard(t); setReply('') } },
      onAssistantText: (t) => { if (alive) setReply(t) },
      onTool: (label) => { if (alive) setTool(label) },
      // Straight to the element: a React render 20 times a second is wasted work
      // on the thread that also feeds the call.
      onLevel: (local) => { orbRef.current?.style.setProperty('--lvl', String(local)) },
      onError: (m) => { if (alive) setError(m) },
      onFatal: (m) => { if (alive) { rt.stop(); onFallback(m) } },
      // Turn decisions, for debugging a session that answered too soon or too late.
      onDebug: (m) => { const w = window as any; (w.__totemVoiceLog ||= []).push(`${new Date().toISOString().slice(11, 23)} ${m}`) },
      onSaved: (thread, c) => {
        if (!alive) return
        adoptThread(thread)
        setCost((x) => x + c)
        if (id.current !== threadId) onThread(id.current)
      },
    })
    session.current = rt
    rt.start().catch((e) => {
      if (!alive) return
      // No mic is final; anything on OpenAI's side drops to the local mode.
      if (e?.name === 'NotAllowedError' || e?.name === 'NotFoundError') { setError(micError(e)); setPhase('error'); return }
      onFallback(String(e?.message || e))
    })
    return () => { alive = false; rt.stop() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const muted = phase === 'paused'
  // Tap: cut Totem off while it talks; while you talk, "I'm done, answer".
  const tapOrb = () => session.current?.tap()
  const orbPhase = phase === 'working' ? 'thinking' : phase === 'connecting' ? 'starting' : phase
  const caption = tool && phase === 'working' ? `${tool}…` : RT_CAPTION[phase]
  const modelName = status.realtime.models.find((m) => m.id === status.realtime.model)?.name || status.realtime.model

  return (
    <div className={`vc-voice phase-${orbPhase}`} role="dialog" aria-label="Voice mode">
      <div className="vc-voice-transcript" aria-live="polite">
        {heard && <p className="vc-voice-heard">{heard}</p>}
        {reply && <p className="vc-voice-reply">{reply.length > 420 ? `…${reply.slice(-420)}` : reply}</p>}
      </div>
      <button ref={orbRef} type="button" className="vc-orb" onClick={tapOrb} aria-label={caption}>
        <span className="vc-orb-core" />
        <span className="vc-orb-ring" />
      </button>
      <div className="vc-voice-bottom">
        <div className="vc-voice-caption">{caption}</div>
        {error && <div className="vc-voice-error">{error}</div>}
        <div className="vc-voice-controls">
          <button type="button" className={`vc-round ${muted ? 'on' : ''}`} onClick={() => session.current?.setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'} disabled={phase === 'error' || phase === 'connecting'}>
            <TI icon={muted ? IconMicrophoneOff : IconMicrophone} size={22} />
          </button>
          <button type="button" className="vc-round end" onClick={onClose} aria-label="End voice mode"><TI icon={IconX} size={22} /></button>
        </div>
        <div className="vc-voice-engine">{modelName} · {money(cost)} this chat · {money(status.spend.today + cost)} today</div>
      </div>
    </div>
  )
}

/** Voice mode: realtime when a key is configured (and not turned off), local otherwise. */
export default function VoiceMode(props: { threadId: string | null; kind: 'regular' | 'temporary'; onThread: (id: string) => void; onClose: () => void }) {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [fallback, setFallback] = useState<string | null>(null)
  useEffect(() => {
    api<VoiceStatus>('/api/voice/status').then(setStatus).catch(() => setFallback('Realtime voice is unavailable.'))
  }, [])
  if (!status && !fallback) return <div className="vc-voice phase-starting"><div className="vc-voice-caption">Starting…</div></div>
  const realtime = !fallback && status?.realtime.configured && status.settings.engine !== 'local'
  if (realtime && status) return <RealtimeVoiceMode {...props} status={status} onFallback={(why) => setFallback(why)} />
  const note = fallback
    ? `Using local voice: ${fallback}`
    : status?.realtime.configured ? 'Local voice (free) · switch in Settings → Voice' : 'Local voice (free) · add OPENAI_API_KEY for ChatGPT-style voice'
  return <LocalVoiceMode {...props} note={note} />
}
