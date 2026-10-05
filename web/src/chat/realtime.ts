// The browser half of realtime voice (chat/voice.mjs is the bridge half).
//
// One WebRTC call to OpenAI: the mic goes up as an audio track, Totem's voice
// comes back as one, and JSON events ride a data channel.
//
// Two things here are deliberate, and both came from it sounding wrong:
//
// 1. Totem's voice plays through a plain <audio> element and nothing else.
//    Attaching Web Audio to a WebRTC stream (an AnalyserNode for the orb) is a
//    known cause of crackling and popping in Safari (WebKit bug 218762), so the
//    orb animates from the call's state, not the audio.
//
// 2. OpenAI decides when you've *paused*; Totem decides when you've *finished*
//    (turn/controller.ts — Smart Turn v3, the open-source model Pipecat ships).
//    The server's VAD runs with create_response: false and a short silence
//    window; nothing is answered until the controller says the turn is over,
//    so a mid-sentence pause no longer gets a reply, and everything said before
//    the answer is one prompt.
import { authHeaders, AuthError } from '../api'
import { openMic, closeMic } from './recorder'
import { TurnController } from './turn/controller'

export type RtPhase = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'working' | 'speaking' | 'paused' | 'error' | 'closed'

export interface ToolRecord { name: string; ok: boolean; output: string; card?: any }

export interface RealtimeHandlers {
  onPhase: (p: RtPhase) => void
  onUserText: (text: string) => void
  onAssistantText: (text: string) => void
  onTool: (label: string | null) => void
  onLevel: (local: number) => void
  onError: (message: string) => void
  /** Realtime can't work at all (e.g. no API credit); fall back to local voice. */
  onFatal?: (message: string) => void
  /** A finished exchange was saved; `thread` is the bridge's copy. */
  onSaved: (thread: any, cost: number) => void
  onDebug?: (msg: string) => void
}

async function post(path: string, body: unknown) {
  const r = await fetch(path, { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) })
  if (r.status === 401) throw new AuthError()
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
  return data
}

const isPhone = () => window.matchMedia?.('(pointer: coarse)').matches

export class RealtimeVoice {
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private mic: MediaStream | null = null
  private audio: HTMLAudioElement | null = null
  private turns: TurnController | null = null
  private model = ''
  private closed = false
  private muted = false
  private responding = false
  private speaking = false
  private turn = { user: '', assistant: '', tools: [] as ToolRecord[], usage: null as any }
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private diag: Record<string, number> = {}

  constructor(private threadId: string, private kind: 'regular' | 'temporary', private h: RealtimeHandlers) {}

  async start() {
    this.h.onPhase('connecting')
    // The <audio> element exists before the track arrives: iOS stutters the first
    // playback when the element is created at track time.
    this.audio = new Audio()
    this.audio.autoplay = true
    ;(this.audio as any).playsInline = true
    this.mic = await openMic()
    const [minted] = await Promise.all([
      post('/api/voice/session', { threadId: this.threadId }),
      (async () => {
        this.turns = new TurnController({
          onEndOfTurn: (why) => this.answer(why),
          onLevel: (l) => this.h.onLevel(this.muted ? 0 : l),
          onDebug: this.h.onDebug,
        })
        await this.turns.start(this.mic!)
      })(),
    ])
    this.model = minted.model
    if (!minted.value) throw new Error('The bridge did not return a voice key')

    const pc = new RTCPeerConnection()
    this.pc = pc
    pc.ontrack = (e) => {
      // A slightly deeper jitter buffer rides out network hiccups that would
      // otherwise be concealed as clicks. Chrome: jitterBufferTarget (ms);
      // Safari: playoutDelayHint (s). Unsupported browsers ignore both.
      try { (e.receiver as any).jitterBufferTarget = 150 } catch {}
      try { (e.receiver as any).playoutDelayHint = 0.15 } catch {}
      if (!this.audio) return
      this.audio.srcObject = e.streams[0]
      this.audio.play().catch(() => {})
    }
    pc.addTrack(this.mic.getAudioTracks()[0], this.mic)
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
              noise_reduction: { type: isPhone() ? 'near_field' : 'far_field' },
              // Pause detection only. 300 ms of quiet is a pause, not an answer;
              // the turn controller decides whether to answer. Barge-in stays on.
              turn_detection: { type: 'server_vad', threshold: 0.55, prefix_padding_ms: 300, silence_duration_ms: 300, create_response: false, interrupt_response: true },
            },
          },
        },
      })
      this.h.onPhase('listening')
    }
    dc.onmessage = (m) => { try { this.onEvent(JSON.parse(m.data)) } catch {} }
    pc.onconnectionstatechange = () => {
      if (!this.closed && ['failed', 'disconnected'].includes(pc.connectionState)) this.h.onError('The voice connection dropped.')
    }

    const offer = await pc.createOffer()
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
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() })
    this.statsTimer = setInterval(() => this.sampleStats(), 4000)
  }

  // Call quality, for telling network trouble from local playback trouble when
  // the voice sounds wrong: concealed samples are what the decoder made up for
  // packets that never arrived. Rising concealment = network; flat = playback.
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

  /** The turn controller says he's finished. */
  private answer(why: string) {
    this.h.onDebug?.(`end of turn: ${why}`)
    if (this.responding || this.closed) return
    this.responding = true
    this.h.onPhase('thinking')
    this.send({ type: 'response.create' })
  }

  private async onEvent(e: any) {
    switch (e.type) {
      case 'input_audio_buffer.speech_started':
        this.turns?.speechStarted()
        if (!this.speaking) this.h.onPhase('hearing')
        break
      case 'input_audio_buffer.speech_stopped':
        this.h.onPhase(this.responding ? 'thinking' : 'listening')
        this.turns?.speechStopped()
        break
      case 'conversation.item.input_audio_transcription.completed':
        if (e.transcript) { this.turn.user = (this.turn.user ? `${this.turn.user} ` : '') + String(e.transcript).trim(); this.h.onUserText(this.turn.user) }
        break
      case 'response.created':
        this.responding = true
        this.turns?.resetTurn()
        break
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        this.turn.assistant += e.delta || ''
        this.h.onAssistantText(this.turn.assistant)
        if (!this.speaking) { this.speaking = true; this.h.onPhase('speaking') }
        break
      case 'output_audio_buffer.started':
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
        // An unknown session field is reported here rather than failing the call;
        // say it and keep talking. An empty API balance is different: nothing will
        // ever answer, so hand over to the local engine.
        if (/insufficient_quota|credit/i.test(`${e.error?.type} ${e.error?.code}`)) {
          this.h.onFatal?.('The OpenAI API account is out of credit. Add some at platform.openai.com → Billing.')
          break
        }
        // A response.create that raced an in-flight one is harmless.
        if (/active response/i.test(e.error?.message || '')) break
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

  /** Tap on the orb: cut Totem off, or — while he's talking — "I'm done, answer". */
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
    this.turns?.finishNow()
  }

  setMuted(muted: boolean) {
    this.muted = muted
    const track = this.mic?.getAudioTracks()[0]
    if (track) track.enabled = !muted
    this.h.onPhase(muted ? 'paused' : 'listening')
  }

  async stop() {
    if (this.closed) return
    await this.flush()
    this.closed = true
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.turns?.stop()
    this.dc?.close()
    this.pc?.close()
    closeMic(this.mic)
    this.mic = null
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null }
    this.h.onPhase('closed')
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
