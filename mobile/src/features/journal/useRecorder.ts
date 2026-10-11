// The microphone, as one hook: web/src/journal/useRecorder.ts on expo-audio.
//
// expo-audio's recorder writes AAC-in-M4A to a cache file; metering is switched on
// and polled every SAMPLE_MS for the live waveform. As on the web, **the level and
// the waveform samples are refs, not state**: the Waveform reads them in its own
// loop, and React only hears about start, pause, stop and whole seconds.
//
// What a phone needs that the web does with a wake lock: the screen is kept awake
// while recording (expo-keep-awake), and if the app is backgrounded anyway the
// take is paused, not lost, so Resume or Stop still has everything said so far.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import {
  RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder,
} from 'expo-audio'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { RECORDING_MIME, deleteLocalRecording } from './upload'

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopped' | 'denied'

/** One amplitude sample every this many ms. 20/s is smooth and cheap to store. */
export const SAMPLE_MS = 50
const KEEP_AWAKE_TAG = 'journal-recording'

export interface RecorderResult {
  uri: string
  mimeType: string
  durationSec: number
  /** When recording began. */
  startedAt: string
  /** The whole recording's amplitude envelope, one sample per SAMPLE_MS. */
  waveform: number[]
}

export interface Recorder {
  state: RecorderState
  /** Whole seconds recorded so far (pauses excluded). */
  elapsed: number
  /** Instantaneous 0..1 loudness. A ref: read it in a loop, not in render. */
  levelRef: MutableRefObject<number>
  /** Amplitude history, one sample per SAMPLE_MS. Also a ref, for the same reason. */
  samplesRef: MutableRefObject<number[]>
  result: RecorderResult | null
  error: string | null
  start: () => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => Promise<void>
  /** Forget the take (and delete its file). */
  reset: () => void
}

/**
 * AVAudioRecorder's metering is average power in dBFS (-160 … 0). Map the useful
 * speech range onto 0..1 and bend it so room noise stays near the rail while a
 * voice visibly moves the bars, the job the web's RMS curve does.
 */
export function levelFromDb(db: number | undefined): number {
  if (db == null || !Number.isFinite(db)) return 0
  const norm = Math.min(1, Math.max(0, (db + 55) / 55))
  return Math.pow(norm, 1.6)
}

export function useRecorder(): Recorder {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true })
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<RecorderResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const levelRef = useRef(0)
  const samplesRef = useRef<number[]>([])
  const meter = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAt = useRef('')
  const durationMs = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state

  const stopMeter = () => {
    if (meter.current) clearInterval(meter.current)
    meter.current = null
    levelRef.current = 0
  }

  const startMeter = useCallback(() => {
    stopMeter()
    meter.current = setInterval(() => {
      let status
      try { status = recorder.getStatus() } catch { return }
      durationMs.current = status.durationMillis || durationMs.current
      const level = levelFromDb(status.metering)
      levelRef.current = level
      samplesRef.current.push(level)
      const sec = Math.floor(durationMs.current / 1000)
      setElapsed((prev) => (prev === sec ? prev : sec))
    }, SAMPLE_MS)
  }, [recorder])

  // Hand the audio session back to playback and let the screen sleep again.
  const releaseSession = () => {
    stopMeter()
    deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {})
  }

  const start = useCallback(async () => {
    setError(null)
    setResult(null)
    setState('requesting')
    try {
      const permission = await requestRecordingPermissionsAsync()
      if (!permission.granted) {
        setError('Microphone access is off for Totem. Turn it on in Settings → Totem → Microphone, then try again.')
        setState('denied')
        return
      }
      // Keep recording with the screen locked or the app in the background: a
      // journal entry is often spoken on a walk with the phone in a pocket.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: true })
      await recorder.prepareToRecordAsync()
      samplesRef.current = []
      durationMs.current = 0
      startedAt.current = new Date().toISOString()
      setElapsed(0)
      recorder.record()
      setState('recording')
      startMeter()
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {})
    } catch (e: any) {
      releaseSession()
      setError(e?.message || 'Could not start recording.')
      setState('idle')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder, startMeter])

  const pause = useCallback(() => {
    if (stateRef.current !== 'recording') return
    try { recorder.pause() } catch { /* already stopped */ }
    stopMeter()
    setState('paused')
  }, [recorder])

  const resume = useCallback(() => {
    if (stateRef.current !== 'paused') return
    recorder.record()
    setState('recording')
    startMeter()
  }, [recorder, startMeter])

  const stop = useCallback(async () => {
    if (stateRef.current !== 'recording' && stateRef.current !== 'paused') return
    try { durationMs.current = recorder.getStatus().durationMillis || durationMs.current } catch { /* keep the last tick */ }
    stopMeter()
    try { await recorder.stop() } catch { /* the file may still be there */ }
    releaseSession()
    const uri = recorder.uri
    const durationSec = Math.round(durationMs.current / 1000)
    if (!uri || durationSec < 1) {
      deleteLocalRecording(uri)
      setError('Nothing was recorded — check the microphone and try again.')
      setState('idle')
      setElapsed(0)
      return
    }
    setResult({ uri, mimeType: RECORDING_MIME, durationSec, startedAt: startedAt.current, waveform: samplesRef.current.slice() })
    setState('stopped')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder])

  const reset = useCallback(() => {
    setResult((r) => { deleteLocalRecording(r?.uri); return null })
    setError(null)
    setElapsed(0)
    durationMs.current = 0
    samplesRef.current = []
    levelRef.current = 0
    setState('idle')
  }, [])

  // Leaving the app mid-take keeps recording (allowsBackgroundRecording). The clock
  // reads the recorder's own duration, so it is right again when the app comes back.
  // Unmount while recording: stop cleanly rather than leaking the microphone.
  useEffect(() => () => {
    if (stateRef.current === 'recording' || stateRef.current === 'paused') {
      recorder.stop().catch(() => {})
      // Only then: the session is shared with chat's voice mode.
      releaseSession()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { state, elapsed, levelRef, samplesRef, result, error, start, pause, resume, stop, reset }
}
