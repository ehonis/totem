// The phone half of realtime voice (web chat/realtime.ts; chat/voice.mjs is the
// bridge half). One WebRTC call to OpenAI: the mic goes up as an audio track,
// Totem's voice comes back as one, and JSON events ride a data channel. Tools
// run on the bridge (POST /api/voice/tool) exactly as on the web, and each
// finished exchange is saved to the chat thread (POST /api/voice/turns).
//
// What differs from the web, and why:
//
// 1. Who decides the turn is over. The web runs Smart Turn (an ONNX model) on
//    the raw mic PCM and keeps the server's VAD to pause detection only.
//    react-native-webrtc hands JS no mic frames and the app has no ONNX
//    runtime, so the server VAD ends the turn itself (create_response: true).
//    Its silence window is the web's own fallback for when the model can't
//    load: a 300 ms pause plus FALLBACK_WAIT_MS (900) of quiet = 1200 ms.
// 2. Audio routing. A native call plays wherever iOS's voice-chat session puts
//    it, which is the earpiece, and turns the screen off at your ear. InCallManager
//    in "video" mode uses iOS's video-chat session instead: loudspeaker by default,
//    AirPods or a headset when one is connected, proximity sensor off. Nothing is
//    forced to the speaker, because forcing it would take a call off AirPods.
// 3. No playback element and no mic level: WebRTC plays the remote track
//    itself, and the orb animates from the call's phase (as the web's does).
import InCallManager from 'react-native-incall-manager'
import { mediaDevices, RTCPeerConnection, type MediaStream } from 'react-native-webrtc'
import { requestRecordingPermissionsAsync } from 'expo-audio'
import { authHeaders, AuthError } from '../../lib/api'
import { bridgeFetch } from '../../lib/connection'
import { MicError, type RealtimeHandlers, type RtPhase, type ToolRecord } from './types'

export type { RtPhase } from './types'

// The web's fallback turn window (turn/controller.ts): the server's 300 ms pause
// plus FALLBACK_WAIT_MS of silence before answering.
const TURN_SILENCE_MS = 300 + 900

async function post(path: string, body: unknown) {
  const r = await bridgeFetch(path, { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) })
  if (r.status === 401) throw new AuthError()
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
  return data
}

export class RealtimeVoice {
  private pc: RTCPeerConnection | null = null
  private dc: ReturnType<RTCPeerConnection['createDataChannel']> | null = null
  private mic: MediaStream | null = null
  private model = ''
  private closed = false
  private muted = false
  private responding = false
  private speaking = false
  private heardSinceAnswer = false
  private audioOn = false
  private routedOnPlayout = false
  private turn = { user: '', assistant: '', tools: [] as ToolRecord[], usage: null as any }
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private diag: Record<string, number> = {}

  constructor(private threadId: string, private kind: 'regular' | 'temporary', private h: RealtimeHandlers) {}

  async start() {
    this.h.onPhase('connecting')
    const perm = await requestRecordingPermissionsAsync().catch(() => ({ granted: false }))
    if (!perm.granted) throw new MicError('Microphone access is off. Turn it on in Settings → Totem, then try again.')
    if (this.closed) return
    this.startAudio()
    const [minted, mic] = await Promise.all([
      post('/api/voice/session', { threadId: this.threadId }),
      mediaDevices.getUserMedia({ audio: true, video: false }).catch((e: any) => {
        throw new MicError(e?.message || 'The microphone could not be opened.')
      }),
    ])
    this.mic = mic
    if (this.closed) return this.release()
    this.model = minted.model
    if (!minted.value) throw new Error('The bridge did not return a voice key')

    const pc = new RTCPeerConnection()
    this.pc = pc
    pc.addTrack(mic.getAudioTracks()[0], mic)
    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    dc.onopen = () => {
      const session = minted.session || {}
      this.send({
        type: 'session.update',
        session: {
          ...session,
          model: this.model,
          audio: {
            ...(session.audio || {}),
            input: {
              ...(session.audio?.input || {}),
              // A phone held in front of you.
              noise_reduction: { type: 'near_field' },
              // The server ends the turn (see the top of this file). Barge-in stays on.
              turn_detection: { type: 'server_vad', threshold: 0.55, prefix_padding_ms: 300, silence_duration_ms: TURN_SILENCE_MS, create_response: true, interrupt_response: true },
            },
          },
        },
      })
      this.h.onPhase('listening')
    }
    dc.onmessage = (m: any) => { try { this.onEvent(JSON.parse(String(m.data))) } catch {} }
    pc.onconnectionstatechange = () => {
      if (this.closed) return
      // WebRTC resets the audio session when the call's audio starts; route it now.
      if (pc.connectionState === 'connected') this.routeToSpeaker()
      if (['failed', 'disconnected'].includes(pc.connectionState)) this.h.onError('The voice connection dropped.')
    }

    const offer = await pc.createOffer({})
    await pc.setLocalDescription(offer)
    const r = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { authorization: `Bearer ${minted.value}`, 'content-type': 'application/sdp' },
      body: offer.sdp,
    })
    if (!r.ok) {
      const body = await r.text()
      if (/insufficient_quota|credit/i.test(body)) { this.h.onFatal?.('The OpenAI API account is out of credit. Add some at platform.openai.com → Billing.'); return }
      throw new Error(`OpenAI refused the call (${r.status}): ${body.slice(0, 200)}`)
    }
    if (this.closed) return
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() })
    this.statsTimer = setInterval(() => this.sampleStats(), 4000)
  }

  // The audio session for the call, before the mic opens so iOS sets it up once.
  private startAudio() {
    if (this.audioOn) return
    this.audioOn = true
    InCallManager.start({ media: 'video' })
    InCallManager.stopProximitySensor()
  }

  // WebRTC resets the session to voice-chat (earpiece) when the call is
  // established. "Not forced" makes InCallManager put video-chat routing back:
  // the speaker, or whatever headphones iOS has routed to.
  private routeToSpeaker() {
    if (!this.audioOn) return
    InCallManager.setForceSpeakerphoneOn(false)
    InCallManager.stopProximitySensor()
  }

  // Call quality, for telling network trouble from playback trouble when the
  // voice sounds wrong: rising concealment = network; flat = playback.
  private async sampleStats() {
    if (!this.pc) return
    try {
      const report = await this.pc.getStats()
      report.forEach((r: any) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'audio') return
        const prev = this.diag
        const next = {
          packetsLost: r.packetsLost || 0, packetsReceived: r.packetsReceived || 0,
          concealedSamples: r.concealedSamples || 0, totalSamplesReceived: r.totalSamplesReceived || 0,
          jitterMs: Math.round((r.jitter || 0) * 1000),
          jitterBufferMs: r.jitterBufferEmittedCount ? Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) : 0,
        }
        const concealedNow = next.concealedSamples - (prev.concealedSamples || 0)
        const receivedNow = next.totalSamplesReceived - (prev.totalSamplesReceived || 0)
        if (receivedNow > 0 && concealedNow / receivedNow > 0.01) {
          this.h.onDebug?.(`audio: ${(100 * concealedNow / receivedNow).toFixed(1)}% concealed, lost ${next.packetsLost - (prev.packetsLost || 0)} packets, jitter ${next.jitterMs}ms`)
        }
        this.diag = next
      })
    } catch {}
  }

  private send(event: any) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event))
  }

  private idlePhase(): RtPhase { return this.muted ? 'paused' : 'listening' }

  private async onEvent(e: any) {
    switch (e.type) {
      case 'input_audio_buffer.speech_started':
        this.heardSinceAnswer = true
        if (!this.speaking) this.h.onPhase('hearing')
        break
      case 'input_audio_buffer.speech_stopped':
        // The server answers this pause itself (create_response: true).
        this.h.onDebug?.('end of turn: server silence')
        this.h.onPhase('thinking')
        break
      case 'conversation.item.input_audio_transcription.completed':
        if (e.transcript) { this.turn.user = (this.turn.user ? `${this.turn.user} ` : '') + String(e.transcript).trim(); this.h.onUserText(this.turn.user) }
        break
      case 'response.created':
        this.responding = true
        this.heardSinceAnswer = false
        break
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        this.turn.assistant += e.delta || ''
        this.h.onAssistantText(this.turn.assistant)
        if (!this.speaking) { this.speaking = true; this.h.onPhase('speaking') }
        break
      case 'output_audio_buffer.started':
        // The first playout can re-route the session too; settle it on the speaker once more.
        if (!this.routedOnPlayout) { this.routedOnPlayout = true; this.routeToSpeaker() }
        this.speaking = true
        this.h.onPhase('speaking')
        break
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.speaking = false
        if (!this.responding) this.h.onPhase(this.idlePhase())
        break
      case 'response.done':
        await this.onResponseDone(e.response || {})
        break
      case 'error':
        // An empty API balance means nothing will ever answer: hand over to dictation.
        if (/insufficient_quota|credit/i.test(`${e.error?.type} ${e.error?.code}`)) {
          this.h.onFatal?.('The OpenAI API account is out of credit. Add some at platform.openai.com → Billing.')
          break
        }
        // A response.create that raced the server's own, or a tap's commit of an
        // empty buffer, is harmless.
        if (/active response|buffer too small|buffer is empty/i.test(e.error?.message || '')) break
        this.h.onError(e.error?.message || 'Voice error')
        break
    }
  }

  private async onResponseDone(response: any) {
    if (response.usage) this.turn.usage = addUsage(this.turn.usage, response.usage)
    const calls = (response.output || []).filter((o: any) => o.type === 'function_call')
    if (!calls.length) {
      this.responding = false
      if (!this.speaking) this.h.onPhase(this.idlePhase())
      if (response.status === 'cancelled' && !this.turn.assistant) return
      return this.flush()
    }
    this.h.onPhase('working')
    await Promise.all(calls.map(async (c: any) => {
      let result: any
      try { result = await post('/api/voice/tool', { name: c.name, arguments: c.arguments, threadId: this.threadId }) }
      catch (err: any) { result = { ok: false, output: JSON.stringify({ error: err.message }) } }
      this.h.onTool(result.card?.title || c.name)
      this.turn.tools.push({ name: c.name, ok: !!result.ok, output: result.output, card: result.card })
      this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: result.output } })
    }))
    this.h.onTool(null)
    if (this.closed) return
    this.send({ type: 'response.create' })
  }

  private async flush() {
    const t = this.turn
    this.turn = { user: '', assistant: '', tools: [], usage: null }
    if (!t.user && !t.assistant && !t.tools.length) return
    try {
      const saved = await post('/api/voice/turns', {
        threadId: this.threadId, kind: this.kind, model: this.model, usage: t.usage,
        turns: [{ role: 'user', text: t.user }, { role: 'assistant', text: t.assistant, tools: t.tools }],
        diag: this.diag,
      })
      this.h.onSaved(saved.thread, saved.cost || 0)
    } catch (e: any) { this.h.onError(`Couldn't save the conversation: ${e.message}`) }
  }

  /** Tap on the orb: cut Totem off, or — while you're talking — "I'm done, answer". */
  tap() {
    if (this.speaking || this.responding) {
      this.send({ type: 'response.cancel' })
      this.send({ type: 'output_audio_buffer.clear' })
      this.speaking = false
      this.responding = false
      this.h.onPhase(this.idlePhase())
      return
    }
    if (this.muted) { this.setMuted(false); return }
    // Nothing said since the last answer: an answer now would be unprompted.
    if (!this.heardSinceAnswer) return
    this.h.onDebug?.('end of turn: tapped')
    this.send({ type: 'input_audio_buffer.commit' })
    this.send({ type: 'response.create' })
    this.h.onPhase('thinking')
  }

  setMuted(muted: boolean) {
    this.muted = muted
    const track = this.mic?.getAudioTracks()[0]
    if (track) track.enabled = !muted
    this.h.onPhase(muted ? 'paused' : 'listening')
  }

  async stop() {
    if (this.closed) return
    this.closed = true
    await this.flush()
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.dc?.close()
    this.pc?.close()
    this.release()
    this.h.onPhase('closed')
  }

  // Let go of the mic and the call's audio session, so the next recording (dictation,
  // the journal) and other apps' audio get a normal session back.
  private release() {
    this.mic?.getTracks().forEach((t) => t.stop())
    this.mic?.release?.()
    this.mic = null
    if (this.audioOn) { this.audioOn = false; InCallManager.stop() }
  }
}

function addUsage(a: any, b: any) {
  if (!a) return b
  const sum = (x: any, y: any): any => {
    if (typeof x === 'number' || typeof y === 'number') return (Number(x) || 0) + (Number(y) || 0)
    const out: any = {}
    for (const k of new Set([...Object.keys(x || {}), ...Object.keys(y || {})])) out[k] = sum(x?.[k], y?.[k])
    return out
  }
  return sum(a, b)
}
