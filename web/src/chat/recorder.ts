// Microphone capture for dictation and voice mode.
//
// One Blob per utterance, recorded with no `timeslice` — Safari's fragmented MP4
// chunks are not reliably concatenable (see the journal gotcha in AGENTS.md), and
// a single blob on stop is a file every decoder agrees on.
//
// Voice mode needs to know when the owner has stopped talking. That is a level
// meter on an AnalyserNode: the first half-second measures the room, speech is
// anything well above that floor, and a pause of `silenceMs` after speech ends
// the turn. Crude next to a neural VAD, and entirely good enough for "I talk,
// then I stop".

export const micSupported = () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

/** Why the microphone can't be used here, or null when it can. */
export function micUnavailableReason(): string | null {
  if (!window.isSecureContext) return 'The microphone needs HTTPS. Open Totem at its https:// address.'
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser has no microphone access.'
  if (typeof MediaRecorder === 'undefined') return 'This browser cannot record audio.'
  return null
}

function pickMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
  return options.find((t) => MediaRecorder.isTypeSupported?.(t)) || ''
}

// One microphone for the whole app session. Browsers — Safari above all — ask
// again for permission once a page has stopped every capture track, so closing
// voice mode used to mean another prompt the next time it opened. Instead the
// stream is muted (track.enabled = false) when nobody needs it and only truly
// released after MIC_KEEP_MS of disuse.
const MIC_KEEP_MS = 10 * 60_000
let shared: MediaStream | null = null
let users = 0
let releaseTimer: ReturnType<typeof setTimeout> | null = null

const live = (s: MediaStream | null) => !!s && s.getAudioTracks().some((t) => t.readyState === 'live')

export async function openMic(): Promise<MediaStream> {
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null }
  if (!live(shared)) {
    shared = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
  }
  shared!.getAudioTracks().forEach((t) => { t.enabled = true })
  users++
  return shared!
}

export function closeMic(stream: MediaStream | null) {
  if (!stream) return
  if (stream !== shared) { stream.getTracks().forEach((t) => t.stop()); return }
  users = Math.max(0, users - 1)
  if (users > 0) return
  stream.getAudioTracks().forEach((t) => { t.enabled = false })
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(() => {
    if (users === 0) { shared?.getTracks().forEach((t) => t.stop()); shared = null }
  }, MIC_KEEP_MS)
}

/** Record until stop() — the composer's dictation button. */
export function recordUntilStopped(stream: MediaStream, onLevel?: (level: number) => void) {
  const mime = pickMime()
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  const meter = onLevel ? levelMeter(stream, onLevel) : null
  const stopped = new Promise<Blob>((resolve) => {
    rec.onstop = () => {
      meter?.close()
      resolve(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }))
    }
  })
  rec.start()
  return { stop: () => { if (rec.state !== 'inactive') rec.stop(); return stopped }, cancel: () => { rec.ondataavailable = null; if (rec.state !== 'inactive') rec.stop(); meter?.close() } }
}

function levelMeter(stream: MediaStream, onLevel: (level: number) => void) {
  const Ctx = window.AudioContext || (window as any).webkitAudioContext
  const ctx: AudioContext = new Ctx()
  const src = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  src.connect(analyser)
  const buf = new Float32Array(analyser.fftSize)
  let raf = 0
  let open = true
  const tick = () => {
    if (!open) return
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    onLevel(Math.sqrt(sum / buf.length))
    raf = requestAnimationFrame(tick)
  }
  tick()
  return { close: () => { open = false; cancelAnimationFrame(raf); src.disconnect(); ctx.close().catch(() => {}) }, ctx }
}

export interface Utterance {
  /** Resolves with the recorded speech, or null if nothing was said before maxWaitMs. */
  result: Promise<Blob | null>
  /** End the turn now (the user tapped "send"). */
  finish: () => void
  cancel: () => void
}

/**
 * Listen for one utterance: wait for speech, record it, stop after a pause.
 * `onLevel` gets a 0..1 loudness for the orb; `onSpeech` fires once speech starts.
 */
export function listenForUtterance(stream: MediaStream, {
  onLevel, onSpeech, silenceMs = 1200, maxWaitMs = 30_000, maxMs = 120_000,
}: { onLevel?: (l: number) => void; onSpeech?: () => void; silenceMs?: number; maxWaitMs?: number; maxMs?: number } = {}): Utterance {
  const mime = pickMime()
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  let heard = false
  let cancelled = false
  let floor = 0
  let samples = 0
  let loudSince = 0
  let quietSince = 0
  const t0 = performance.now()
  let resolve!: (b: Blob | null) => void
  const result = new Promise<Blob | null>((r) => { resolve = r })

  const end = () => { if (rec.state !== 'inactive') rec.stop() }
  rec.onstop = () => {
    meter.close()
    if (cancelled || !heard) return resolve(null)
    resolve(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }))
  }

  const meter = levelMeter(stream, (level) => {
    const t = performance.now()
    // Calibrate on the first ~500ms: the room's own hum is the floor.
    if (t - t0 < 500) { floor = (floor * samples + level) / ++samples; onLevel?.(0); return }
    const threshold = Math.max(0.012, floor * 3)
    onLevel?.(Math.min(1, level / (threshold * 4)))
    if (level > threshold) {
      quietSince = 0
      if (!loudSince) loudSince = t
      if (!heard && t - loudSince > 120) { heard = true; onSpeech?.() }
    } else {
      loudSince = 0
      if (heard && !quietSince) quietSince = t
    }
    if (heard && quietSince && t - quietSince > silenceMs) end()
    else if (!heard && t - t0 > maxWaitMs) end()
    else if (t - t0 > maxMs) end()
  })
  rec.start()
  return {
    result,
    finish: () => { heard = heard || chunks.length > 0 || performance.now() - t0 > 800; end() },
    cancel: () => { cancelled = true; end() },
  }
}
