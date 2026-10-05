// Text to speech for voice mode and "read aloud", on the browser's own voices.
//
// A reply is spoken sentence by sentence *while it streams*, so the first words
// start a second or two in rather than after the whole answer has arrived — the
// difference between talking to something and waiting on it. Chunking by
// sentence is also what keeps Chrome from silently cutting an utterance off
// after ~15 seconds.
//
// iOS only lets speechSynthesis speak after a user gesture has spoken once, so
// voice mode calls `unlock()` from the tap that opens it.

const VOICE_KEY = 'totem.voice.name'
const RATE_KEY = 'totem.voice.rate'

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window

/** Markdown and URLs read aloud are noise; reduce a reply to what a person would say. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Rank voices: the neural/enhanced ones the OS ships sound like a person; the
// compact defaults sound like 1998. Names are what each platform exposes.
function voiceScore(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase()
  let s = 0
  if (/^en(-|_)us/i.test(v.lang)) s += 30
  else if (/^en/i.test(v.lang)) s += 20
  if (/premium|enhanced|neural|natural/.test(n)) s += 40
  if (/siri/.test(n)) s += 35
  if (/(samantha|ava|zoe|evan|nathan|allison|susan|tom)/.test(n)) s += 15
  if (/google us english|microsoft (aria|jenny|guy)/.test(n)) s += 25
  if (v.localService) s += 5
  if (/compact|novelty|whisper|bad news|bells|boing|bubbles|cellos|jester|organ|trinoids|zarvox|albert|fred/.test(n)) s -= 60
  return s
}

export function listVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported()) return []
  return speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)).sort((a, b) => voiceScore(b) - voiceScore(a))
}

export function preferredVoice(): SpeechSynthesisVoice | null {
  const all = listVoices()
  const saved = localStorage.getItem(VOICE_KEY)
  return all.find((v) => v.name === saved) || all[0] || null
}

export const setPreferredVoice = (name: string) => localStorage.setItem(VOICE_KEY, name)
export const speechRate = () => Math.min(1.6, Math.max(0.7, Number(localStorage.getItem(RATE_KEY)) || 1.05))
export const setSpeechRate = (rate: number) => localStorage.setItem(RATE_KEY, String(rate))

// Voices load asynchronously in Chrome; ask early so the first reply has one.
if (speechSupported()) {
  speechSynthesis.getVoices()
  speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices())
}

export function unlockSpeech() {
  if (!speechSupported()) return
  const u = new SpeechSynthesisUtterance(' ')
  u.volume = 0
  speechSynthesis.speak(u)
}

/** Split off the complete sentences at the front of `text`. */
export function takeSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  const re = /[^.!?\n]+(?:[.!?]+(?=\s|$)|\n+)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const s = m[0].trim()
    if (s) sentences.push(s)
    last = re.lastIndex
  }
  return { sentences, rest: text.slice(last) }
}

export interface Speaker {
  /** Give the whole reply so far; new complete sentences are queued. */
  feed: (fullText: string) => void
  /** The reply is finished: speak whatever is left. */
  finish: (fullText: string) => void
  /** Speak one standalone text now (read aloud). */
  say: (text: string) => void
  stop: () => void
  speaking: () => boolean
}

export function createSpeaker({ onStart, onIdle }: { onStart?: () => void; onIdle?: () => void } = {}): Speaker {
  let spokenUpTo = 0
  let queue = 0
  let finished = false
  let cancelled = false

  function utter(text: string) {
    if (!speechSupported() || !text.trim()) return
    const u = new SpeechSynthesisUtterance(text)
    const voice = preferredVoice()
    if (voice) { u.voice = voice; u.lang = voice.lang }
    u.rate = speechRate()
    queue++
    if (queue === 1) onStart?.()
    const done = () => {
      queue = Math.max(0, queue - 1)
      if (queue === 0 && finished && !cancelled) onIdle?.()
    }
    u.onend = done
    u.onerror = done
    speechSynthesis.speak(u)
  }

  function feed(full: string) {
    if (cancelled) return
    const clean = speakable(full)
    if (clean.length <= spokenUpTo) return
    const { sentences, rest } = takeSentences(clean.slice(spokenUpTo))
    if (!sentences.length) return
    spokenUpTo = clean.length - rest.length
    // Batch short sentences so the voice doesn't pause between every clause.
    utter(sentences.join(' '))
  }

  function finish(full: string) {
    if (cancelled) return
    finished = true
    const clean = speakable(full)
    const rest = clean.slice(spokenUpTo).trim()
    spokenUpTo = clean.length
    if (rest) utter(rest)
    else if (queue === 0) onIdle?.()
  }

  return {
    feed,
    finish,
    say: (text) => { cancelled = false; finished = true; spokenUpTo = 0; utter(speakable(text)) },
    stop: () => { cancelled = true; queue = 0; if (speechSupported()) speechSynthesis.cancel() },
    speaking: () => queue > 0,
  }
}

/** One-shot "read this message aloud", cancelling anything already speaking. */
let readAloud: Speaker | null = null
export function readMessageAloud(text: string, onEnd?: () => void) {
  readAloud?.stop()
  if (speechSupported()) speechSynthesis.cancel()
  readAloud = createSpeaker({ onIdle: onEnd })
  readAloud.say(text)
  return () => { readAloud?.stop(); onEnd?.() }
}
