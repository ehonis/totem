// Getting into voice mode and back out of it.
//
// Voice mode is its own full-screen route over the chat. When realtime voice
// can't run (no OpenAI key on the bridge, engine set to local, out of credit),
// the web drops to its local whisper loop; the phone drops to the composer's
// dictation instead: the voice screen closes and leaves a note here, and the
// chat picks it up when it is showing again.
import { router } from 'expo-router'

export function openVoice({ threadId, kind }: { threadId: string | null; kind: 'regular' | 'temporary' }) {
  router.push({ pathname: '/chat/voice', params: { ...(threadId ? { threadId } : {}), kind } })
}

let dictationWhy: string | null = null

/** Voice mode can't run: have the chat dictate instead, saying why. */
export function handToDictation(why: string) { dictationWhy = why }

/** The reason, once, if voice mode handed over; null otherwise. */
export function takeDictationHandoff(): string | null { const w = dictationWhy; dictationWhy = null; return w }
