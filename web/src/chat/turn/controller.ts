// End-of-turn detection, the way Pipecat does it.
//
// OpenAI's own turn detection answers the moment you pause. People pause in the
// middle of sentences ("I want to… move my dentist appointment"), so it kept
// jumping in, and each fragment became its own prompt. Here the server's VAD
// only reports the pause (create_response: false); this decides whether the
// pause is the end:
//
//   pause reported  → run Smart Turn on the turn so far (the last 8 s of it)
//     complete      → answer after a short beat (COMPLETE_GRACE_MS)
//     incomplete    → wait; speech resuming cancels the wait, and after
//                     INCOMPLETE_WAIT_MS of silence answer anyway
//   model missing   → plain silence timer (FALLBACK_WAIT_MS)
//
// Audio for the model is recorded with MediaRecorder and decoded offline at
// 16 kHz (OfflineAudioContext never opens the audio hardware). There is no live
// AudioContext anywhere in a call: on iOS, one running alongside WebRTC — even
// one only listening to the mic — is what made Totem's voice crackle and pop
// (WebKit 218762; the sample-rate switch it forces).

import { SAMPLE_RATE } from './features'

// Even a confident "finished" waits one beat: a dramatic pause ("And so, my
// fellow Americans…") can sound final, and the beat costs a third of a second.
export const COMPLETE_GRACE_MS = 350
export const INCOMPLETE_WAIT_MS = 2200
export const FALLBACK_WAIT_MS = 900
const THRESHOLD = 0.5
const KEEP_SECONDS = 12

function pickMime() {
  const options = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
  return options.find((t) => (window as any).MediaRecorder?.isTypeSupported?.(t)) || ''
}

async function decode16k(blob: Blob): Promise<Float32Array | null> {
  try {
    const Off = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext
    const ctx: OfflineAudioContext = new Off(1, SAMPLE_RATE, SAMPLE_RATE)
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    return buf.getChannelData(0).slice()
  } catch {
    return null
  }
}

let worker: Worker | null = null
let workerReady: Promise<boolean> | null = null
let seq = 0
const pending = new Map<number, (r: { p: number; ms: number } | null) => void>()

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const { id, type, p, ms } = e.data || {}
      const done = pending.get(id)
      if (!done) return
      pending.delete(id)
      done(type === 'result' ? { p, ms } : type === 'ready' ? { p: 1, ms: 0 } : null)
    }
    worker.onerror = () => { for (const d of pending.values()) d(null); pending.clear() }
    workerReady = new Promise((resolve) => {
      const id = ++seq
      pending.set(id, (r) => resolve(!!r))
      worker!.postMessage({ id, type: 'warm' })
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(false) } }, 20_000)
    })
  }
  return worker
}

/** Start loading the model early (opening voice mode), so the first pause isn't slow. */
export function warmTurnModel() {
  getWorker()
  return workerReady!
}

function predict(audio: Float32Array): Promise<{ p: number; ms: number } | null> {
  const w = getWorker()
  return new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    w.postMessage({ id, type: 'predict', audio }, [audio.buffer])
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null) } }, 3000)
  })
}

export interface TurnEvents {
  /** It's his turn to be answered. */
  onEndOfTurn: (why: string) => void
  /** Mic loudness, 0..1, ~20 times a second (for the orb). */
  onLevel?: (level: number) => void
  onDebug?: (msg: string) => void
}

export class TurnController {
  private rec: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private recStart = 0 // ms timestamp the current recording began
  private mime = ''
  private turnStartAt = -1 // ms timestamp the current turn began
  private timer: ReturnType<typeof setTimeout> | null = null
  private recycle: ReturnType<typeof setInterval> | null = null
  private gen = 0
  private speaking = false
  private modelOk = false
  private captureOk = true

  constructor(private ev: TurnEvents) {}

  async start(stream: MediaStream) {
    this.stream = stream
    warmTurnModel().then((ok) => { this.modelOk = ok; this.ev.onDebug?.(ok ? 'smart-turn ready' : 'smart-turn unavailable, using a silence timer') })
    this.mime = pickMime()
    this.restartRecorder()
    // Between turns the recording only needs the last few seconds; start a fresh
    // one every 20 s while nobody is mid-turn so decoding stays cheap.
    this.recycle = setInterval(() => { if (this.turnStartAt < 0 && !this.speaking) this.restartRecorder() }, 20_000)
  }

  private restartRecorder() {
    if (!this.stream || typeof MediaRecorder === 'undefined') { this.captureOk = false; return }
    try { if (this.rec && this.rec.state !== 'inactive') { this.rec.ondataavailable = null; this.rec.stop() } } catch {}
    this.chunks = []
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined)
    rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data) }
    rec.start(250)
    this.rec = rec
    this.recStart = Date.now()
  }

  /** Flush the recorder and decode the current turn (at most its last 8 s). */
  private async turnAudio(): Promise<Float32Array | null> {
    const rec = this.rec
    if (!rec || rec.state === 'inactive') return null
    await new Promise<void>((resolve) => {
      const done = () => { rec.removeEventListener('dataavailable', done); resolve() }
      rec.addEventListener('dataavailable', done)
      try { rec.requestData() } catch { resolve() }
      setTimeout(resolve, 400)
    })
    const pcm = await decode16k(new Blob(this.chunks, { type: rec.mimeType || this.mime }))
    if (!pcm) { this.ev.onDebug?.('capture: could not decode the recording'); return null }
    const fromMs = this.turnStartAt < 0 ? 0 : Math.max(0, this.turnStartAt - this.recStart - 500)
    const from = Math.min(pcm.length, Math.round((fromMs / 1000) * SAMPLE_RATE))
    const tail = pcm.subarray(Math.max(from, pcm.length - 8 * SAMPLE_RATE))
    return tail.slice()
  }

  /** The server heard speech begin. */
  speechStarted() {
    this.speaking = true
    this.gen++
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    // A turn starts at its first speech, with a little run-up for the onset.
    if (this.turnStartAt < 0) this.turnStartAt = Date.now()
  }

  /** The server heard a pause. Decide whether it's the end of the turn. */
  async speechStopped() {
    this.speaking = false
    const gen = ++this.gen
    if (!this.modelOk || !this.captureOk) { this.wait(FALLBACK_WAIT_MS, gen, 'silence'); return }
    const audio = await this.turnAudio()
    if (gen !== this.gen || this.speaking) return
    if (!audio) { this.wait(FALLBACK_WAIT_MS, gen, 'silence (no audio)'); return }
    const r = await predict(audio)
    if (gen !== this.gen || this.speaking) return // he started talking again meanwhile
    if (!r) { this.wait(FALLBACK_WAIT_MS, gen, 'silence'); return }
    this.ev.onDebug?.(`smart-turn p=${r.p.toFixed(2)} in ${r.ms}ms`)
    if (r.p >= THRESHOLD) this.wait(COMPLETE_GRACE_MS, gen, `complete (${r.p.toFixed(2)})`)
    else this.wait(INCOMPLETE_WAIT_MS, gen, `incomplete (${r.p.toFixed(2)}), then quiet`)
  }

  private wait(ms: number, gen: number, why: string) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { if (gen === this.gen && !this.speaking) this.fire(why) }, ms)
  }

  private fire(why: string) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.turnStartAt = -1
    this.ev.onEndOfTurn(why)
    // The next turn records into a fresh file.
    this.restartRecorder()
  }

  /** He tapped to say "I'm done" — answer now. */
  finishNow() {
    this.gen++
    this.fire('tapped')
  }

  /** A reply started; the next speech is a new turn. */
  resetTurn() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.turnStartAt = -1
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    if (this.recycle) clearInterval(this.recycle)
    this.gen++
    try { if (this.rec && this.rec.state !== 'inactive') { this.rec.ondataavailable = null; this.rec.stop() } } catch {}
    this.rec = null
    this.chunks = []
  }
}
