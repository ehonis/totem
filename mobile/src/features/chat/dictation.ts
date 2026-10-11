// The composer's mic (web chat/recorder.ts + Composer's dictation): record a
// clip, send it to the bridge's whisper.cpp, and drop the words into the box.
// expo-audio records AAC in an .m4a, which the bridge names `clip.m4a`.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import {
  RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState,
} from 'expo-audio'
import { pushError } from '../../lib/toast'
import { transcribeFile } from './upload'

export type DictationState = null | { state: 'recording' | 'transcribing'; startedAt: number; level: number }

export function useDictation(onText: (text: string) => void) {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true })
  const status = useAudioRecorderState(recorder, 120)
  const [phase, setPhase] = useState<null | { state: 'recording' | 'transcribing'; startedAt: number }>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const start = useCallback(async () => {
    try {
      const perm = await requestRecordingPermissionsAsync()
      if (!perm.granted) { pushError('Microphone access is off. Turn it on in Settings → Totem.'); return false }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      await recorder.prepareToRecordAsync()
      recorder.record()
      setPhase({ state: 'recording', startedAt: Date.now() })
      return true
    } catch (e: any) {
      pushError(e?.message || 'Could not start the microphone')
      return false
    }
  }, [recorder])

  const release = () => { setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {}) }

  const finish = useCallback(async () => {
    if (!phase || phase.state !== 'recording') return
    setPhase((p) => (p ? { ...p, state: 'transcribing' } : p))
    try {
      await recorder.stop()
      release()
      const uri = recorder.uri
      if (!uri) throw new Error('Nothing was recorded')
      const text = await transcribeFile(uri, Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4')
      if (text) onTextRef.current(text)
    } catch (e: any) {
      pushError(e?.message || 'Transcription failed')
    } finally {
      setPhase(null)
    }
  }, [phase, recorder])

  const cancel = useCallback(() => {
    recorder.stop().catch(() => {})
    release()
    setPhase(null)
  }, [recorder])

  // Leaving the chat mid-recording lets go of the mic.
  useEffect(() => () => { if (recorder.isRecording) recorder.stop().catch(() => {}) }, [recorder])

  // Metering is dBFS (-160..0); the web's level is roughly 0..0.15 of speech.
  const level = status.metering != null ? Math.max(0, Math.min(1, (status.metering + 60) / 60)) * 0.15 : 0
  const state: DictationState = phase ? { ...phase, level } : null
  return { state, start, finish, cancel }
}
