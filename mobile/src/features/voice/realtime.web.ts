// The web preview's stand-in for realtime.ts. react-native-webrtc and
// InCallManager have no web build, and the preview only exists to check
// layouts, so there is no call here: `?demo=<phase>` on the voice route plays
// that phase with sample lines (for screenshots); otherwise it hands over to
// dictation the way a bridge without realtime voice does. iOS never loads this.
import type { RealtimeHandlers, RtPhase } from './types'

export type { RtPhase } from './types'

const PHASES: RtPhase[] = ['connecting', 'listening', 'hearing', 'thinking', 'working', 'speaking', 'paused', 'error']

export class RealtimeVoice {
  private phase: RtPhase = 'connecting'
  constructor(_threadId: string, _kind: 'regular' | 'temporary', private h: RealtimeHandlers) {}

  async start() {
    const demo = new URLSearchParams(globalThis.location?.search || '').get('demo') as RtPhase | null
    if (!demo || !PHASES.includes(demo)) {
      this.h.onFatal?.('Realtime voice runs in the phone app; the web preview has no WebRTC.')
      return
    }
    this.h.onPhase('connecting')
    await new Promise((r) => setTimeout(r, 300))
    if (demo !== 'connecting' && demo !== 'listening') this.h.onUserText('What’s on my calendar this afternoon, and can you move the dentist to Friday?')
    if (demo === 'working') this.h.onTool('Moving an event')
    if (demo === 'speaking') this.h.onAssistantText('You’ve got a design review at 2 and the gym at 5:30. I moved the dentist to Friday at 10, same place.')
    this.h.onPhase(demo === 'error' ? 'listening' : demo)
    if (demo === 'error') this.h.onError('The voice connection dropped.')
    this.phase = demo
  }

  tap() { if (this.phase === 'speaking') { this.phase = 'listening'; this.h.onPhase('listening') } }
  setMuted(muted: boolean) { this.phase = muted ? 'paused' : 'listening'; this.h.onPhase(this.phase) }
  async stop() { this.h.onPhase('closed') }
}
