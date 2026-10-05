// The microphone, as one hook.
//
// MediaRecorder does the capture — Safari writes AAC-in-MP4, Chrome writes
// Opus-in-WebM, and the bridge's ffmpeg reads either — and an AnalyserNode on the
// same stream feeds the waveform so the button visibly hears you. No timeslice is
// passed to `start()`: one Blob on stop is a file every decoder agrees on, whereas
// Safari's fragmented chunks are not always concatenable.
//
// **The level and the waveform samples are refs, not state.** They update sixty
// times a second, and pushing that through `useState` re-rendered the whole
// Journal view (every card, every countdown) on every frame. The canvas reads the
// refs inside its own animation loop instead; React only hears about things a
// person changed — start, pause, stop.
//
// Two things a phone needs that a desktop does not: a screen wake lock while
// recording (a locked iPhone suspends the tab and the recording with it), and a
// "you are still recording" guard on navigation away.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { pickMimeType } from './format'

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopped' | 'unsupported' | 'denied'

/** One amplitude sample every this many ms. 20/s is smooth and cheap to store. */
export const SAMPLE_MS = 50

export interface RecorderResult {
  blob: Blob
  mimeType: string
  durationSec: number
  /** When recording began. */
  startedAt: string
  /** The whole recording's amplitude envelope, one peak per SAMPLE_MS. */
  waveform: number[]
}

export interface Recorder {
  state: RecorderState
  /** Seconds recorded so far (pauses excluded). */
  elapsed: number
  /** Instantaneous 0..1 loudness. A ref: read it in an animation frame, not in render. */
  levelRef: MutableRefObject<number>
  /** Amplitude history, one peak per SAMPLE_MS. Also a ref, for the same reason. */
  samplesRef: MutableRefObject<number[]>
  result: RecorderResult | null
  error: string | null
  supported: boolean
  start: () => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  reset: () => void
}

const hasRecorder = () =>
  typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)

export function useRecorder(): Recorder {
  const supported = hasRecorder()
  const [state, setState] = useState<RecorderState>(supported ? 'idle' : 'unsupported')
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<RecorderResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const levelRef = useRef(0)
  const samplesRef = useRef<number[]>([])

  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const audioCtx = useRef<AudioContext | null>(null)
  const analyser = useRef<AnalyserNode | null>(null)
  const raf = useRef<number>(0)
  const ticker = useRef<number>(0)
  const startedAt = useRef<string>('')
  // Elapsed is accumulated across pauses: `accumulated` holds finished runs and
  // `runStart` the wall clock of the current one.
  const accumulated = useRef(0)
  const runStart = useRef<number | null>(null)
  const wakeLock = useRef<any>(null)
  // Peak since the last committed sample, so a 50ms bucket shows its loudest
  // moment rather than whichever frame happened to land on the boundary.
  const bucketPeak = useRef(0)
  const bucketAt = useRef(0)

  const currentElapsed = () => accumulated.current + (runStart.current ? (Date.now() - runStart.current) / 1000 : 0)

  const stopMeter = () => {
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = 0
    levelRef.current = 0
  }

  const meter = useCallback(() => {
    const node = analyser.current
    if (!node) return
    const buf = new Uint8Array(node.fftSize)
    const step = () => {
      node.getByteTimeDomainData(buf)
      let sum = 0
      let peak = 0
      for (let i = 0; i < buf.length; i += 1) {
        const v = (buf[i] - 128) / 128
        sum += v * v
        const a = Math.abs(v)
        if (a > peak) peak = a
      }
      // RMS → a curve that makes speech visibly move without pinning at the top.
      const rms = Math.sqrt(sum / buf.length)
      const shaped = Math.min(1, Math.pow(rms * 3.2, 0.8))
      levelRef.current = shaped
      if (peak > bucketPeak.current) bucketPeak.current = Math.min(1, Math.pow(peak * 1.6, 0.85))
      const now = Date.now()
      if (now - bucketAt.current >= SAMPLE_MS) {
        bucketAt.current = now
        samplesRef.current.push(bucketPeak.current)
        bucketPeak.current = 0
      }
      raf.current = requestAnimationFrame(step)
    }
    bucketAt.current = Date.now()
    raf.current = requestAnimationFrame(step)
  }, [])

  const releaseHardware = () => {
    stopMeter()
    if (ticker.current) window.clearInterval(ticker.current)
    ticker.current = 0
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    analyser.current = null
    void audioCtx.current?.close().catch(() => {})
    audioCtx.current = null
    void wakeLock.current?.release?.().catch(() => {})
    wakeLock.current = null
  }

  const start = useCallback(async () => {
    if (!supported) return
    setError(null)
    setResult(null)
    setState('requesting')
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      stream.current = media
      const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t))
      const rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined)
      chunks.current = []
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.current.push(e.data) }
      rec.onerror = () => { setError('The recorder stopped unexpectedly.'); setState('idle'); releaseHardware() }
      rec.onstop = () => {
        const type = rec.mimeType || mimeType || 'audio/webm'
        const blob = new Blob(chunks.current, { type })
        const durationSec = Math.round(currentElapsed())
        const waveform = samplesRef.current.slice()
        runStart.current = null
        releaseHardware()
        if (!blob.size || durationSec < 1) {
          setError('Nothing was recorded — check the microphone and try again.')
          setState('idle')
          setElapsed(0)
          return
        }
        setResult({ blob, mimeType: type, durationSec, startedAt: startedAt.current, waveform })
        setState('stopped')
      }
      recorder.current = rec

      // Meter. Some Safari builds want the context resumed from a user gesture,
      // which `start()` is being called from.
      try {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext
        const ctx: AudioContext = new Ctx()
        await ctx.resume().catch(() => {})
        const src = ctx.createMediaStreamSource(media)
        const node = ctx.createAnalyser()
        node.fftSize = 1024
        src.connect(node)
        audioCtx.current = ctx
        analyser.current = node
      } catch { /* the waveform is feedback, not the recording */ }

      try { wakeLock.current = await (navigator as any).wakeLock?.request?.('screen') } catch { /* optional */ }

      accumulated.current = 0
      runStart.current = Date.now()
      startedAt.current = new Date().toISOString()
      samplesRef.current = []
      bucketPeak.current = 0
      setElapsed(0)
      rec.start()
      setState('recording')
      meter()
      ticker.current = window.setInterval(() => setElapsed(currentElapsed()), 250)
    } catch (e: any) {
      releaseHardware()
      const name = e?.name || ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError('Microphone access was denied. Allow it for this site (on iPhone: Settings → Safari → Microphone, or the aA menu) and try again.')
        setState('denied')
      } else if (name === 'NotFoundError') {
        setError('No microphone was found.')
        setState('idle')
      } else {
        setError(e?.message || 'Could not start recording.')
        setState('idle')
      }
    }
  }, [supported, meter])

  const pause = useCallback(() => {
    const rec = recorder.current
    if (!rec || rec.state !== 'recording') return
    rec.pause()
    accumulated.current = currentElapsed()
    runStart.current = null
    stopMeter()
    setState('paused')
  }, [])

  const resume = useCallback(() => {
    const rec = recorder.current
    if (!rec || rec.state !== 'paused') return
    rec.resume()
    runStart.current = Date.now()
    setState('recording')
    meter()
  }, [meter])

  const stop = useCallback(() => {
    const rec = recorder.current
    if (!rec || rec.state === 'inactive') return
    if (rec.state !== 'paused') {
      accumulated.current = currentElapsed()
      runStart.current = null
    }
    rec.stop()
  }, [])

  const reset = useCallback(() => {
    setResult(null)
    setError(null)
    setElapsed(0)
    accumulated.current = 0
    runStart.current = null
    samplesRef.current = []
    levelRef.current = 0
    setState(supported ? 'idle' : 'unsupported')
  }, [supported])

  // Leaving the page mid-recording loses it; say so.
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [state])

  // Unmount while recording: stop cleanly rather than leaking the microphone.
  useEffect(() => () => {
    try { if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop() } catch { /* already gone */ }
    releaseHardware()
  }, [])

  return { state, elapsed, levelRef, samplesRef, result, error, supported, start, pause, resume, stop, reset }
}
