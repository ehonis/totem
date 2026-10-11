// What the voice screen and the call (realtime.ts, or its web stand-in) agree on.
// Same names as the web's chat/realtime.ts.

export type RtPhase = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'working' | 'speaking' | 'paused' | 'error' | 'closed'

export interface ToolRecord { name: string; ok: boolean; output: string; card?: any }

export interface RealtimeHandlers {
  onPhase: (p: RtPhase) => void
  onUserText: (text: string) => void
  onAssistantText: (text: string) => void
  onTool: (label: string | null) => void
  onError: (message: string) => void
  /** Realtime can't work at all (e.g. no API credit); fall back to dictation. */
  onFatal?: (message: string) => void
  /** A finished exchange was saved; `thread` is the bridge's copy. */
  onSaved: (thread: any, cost: number) => void
  onDebug?: (msg: string) => void
}

/** GET /api/voice/status */
export interface VoiceStatus {
  realtime: { configured: boolean; model: string; voice: string; models: { id: string; name: string }[] }
  local: { ready: boolean }
  settings: { engine: 'auto' | 'realtime' | 'local' }
  spend: { today: number; month: number }
}

/** A start failure that no other engine can fix (no microphone permission). */
export class MicError extends Error {
  constructor(message: string) { super(message); this.name = 'MicError' }
}
