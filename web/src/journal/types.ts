// Typed mirror of the bridge's journal entry (journal/service.mjs ▸ publicEntry).

export type JournalStatus = 'transcribing' | 'transcribed' | 'failed'
export type IngestState = 'queued' | 'running' | 'done' | 'skipped' | 'failed'

export interface JournalSegment {
  start: number
  end: number
  text: string
}

export interface IngestResult {
  parsed: boolean
  title: string | null
  summary: string | null
  memory: string[]
  proposals: string[]
  habits: string[]
  goals: string[]
  calendar: string[]
  todos: string[]
  mood: string | null
  /** The agent's whole reply, for the details drop-down. */
  reply?: string
}

export interface JournalEntry {
  id: string
  createdAt: string
  updatedAt: string
  recordedAt: string
  /** Local calendar day the entry was spoken on, in the bridge's timezone. */
  date: string
  durationSec: number | null
  source: 'voice' | 'text'
  title: string | null
  /**
   * Facts about the recording. `kept` is true while the bytes are still on disk;
   * `keepUntil` is when the sweep will take them (null when pinned or already gone).
   */
  audio: {
    mime: string
    bytes: number
    kept: boolean
    pinned: boolean
    keepUntil: string | null
    deletedAt: string | null
  } | null
  transcript: {
    text: string
    segments: JournalSegment[]
    language: string | null
    model: string | null
    ms: number
    completedAt: string
    editedAt?: string
  } | null
  status: JournalStatus
  error: string | null
  ingest: {
    state: IngestState
    /** When the digest may start (ISO). The "don't ingest" window ends here. */
    at: string
    startedAt: string | null
    completedAt: string | null
    error: string | null
    result: IngestResult | null
    /** Brain page the transcript was written to, relative to the brain root. */
    journalFile: string | null
  }
}

export interface JournalSettings {
  ingestDelayMinutes: number
  vocabulary: string
  /** Days a recording survives after transcription. 0 deletes it straight away. */
  keepAudioDays: number
  /** Empty means "whatever the Providers tab has as the default". */
  provider: string
  /** Empty means the provider's own default model. */
  model: string
  /** Only codex and claude take one. */
  effort: string
}

export interface AgentModel {
  id: string
  name: string
  reasoningLevels: string[]
  defaultReasoning: string | null
  recommended: boolean
}

export interface AgentProvider {
  provider: string
  name: string
  state: string
  fix: string | null
  isDefault: boolean
  takesReasoning: boolean
  models: AgentModel[]
  error: string | null
}

export interface JournalEngine {
  ready: boolean
  missing: string[]
  fix: string | null
  model: string | null
  threads: number
}

export interface JournalPayload {
  entries: JournalEntry[]
  engine: JournalEngine
  counts: { total: number; transcribing: number; waiting: number; failed: number }
  settings: JournalSettings
  timeZone: string
}
