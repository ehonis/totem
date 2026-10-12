// The chat's shapes, mirroring chat/store.mjs on the bridge. The bridge owns
// messages; the browser renders them and holds a cache.

export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'file' | 'text'
  url?: string
  preview?: string
}

export interface TextPart { type: 'text'; text: string }
/** What the chat's browser is showing (bridge `browser` events). `image` is a JPEG data URL. */
export interface BrowserFrame { tabId: string; url: string; title: string; image: string; at: number }

export interface ImagePart { type: 'image'; uploadId: string; alt?: string; url?: string }
export interface ToolPart {
  type: 'tool'
  id: string
  kind: string
  title: string
  detail?: string
  status: 'running' | 'done' | 'error'
  server?: string
  tool?: string
  input?: string
  output?: string
  startedAt?: number
  endedAt?: number
  /** Another agent this call started, and what it is doing (chat/subagents.mjs). */
  agent?: AgentInfo
}
/** One thing a sub-agent did: thought, said, or called a tool. */
export interface AgentStep {
  id: string
  kind: 'thinking' | 'text' | 'tool'
  text?: string
  title?: string
  detail?: string
  /** The tool's kind, for its icon. */
  tool?: string
  server?: string
  input?: string
  output?: string
  status?: 'running' | 'done' | 'error'
  at?: number
  endedAt?: number
}
export interface AgentInfo {
  /** The CLI doing the work: claude, codex, cursor, opencode, gemini. */
  provider: string
  /** `subagent`: the agent's own (Claude's Agent tool, Codex collab); `cli`: another CLI run from a shell. */
  via?: 'subagent' | 'cli'
  /** Claude's subagent_type (general-purpose, Explore…). */
  name?: string
  title?: string
  prompt?: string
  model?: string
  status: 'running' | 'done' | 'error' | 'stopped'
  /** The latest one-line progress the parent reported. */
  progress?: string
  /** What it handed back. */
  summary?: string
  tokens?: number
  toolUses?: number
  /** `live`: its own log is being read; `none`: only its final output is known. */
  log?: 'live' | 'none'
  startedAt?: number
  endedAt?: number
  /** Earlier steps not kept (the list is capped). */
  dropped?: number
  steps: AgentStep[]
}
export interface FilePart { type: 'file'; uploadId: string; name: string; mime: string; size?: number; path?: string; url?: string }
/** A change to a totem the agent proposed; applied only when the owner accepts. */
export interface TotemProposalPart {
  type: 'totem-proposal'
  id: string
  totemId: string
  totemName?: string
  summary: string
  memoryNote?: string
  instructions?: string
  status: 'pending' | 'accepted' | 'dismissed'
}
/** Something the owner sent while the reply was still running. `live`: taken into the running turn; `restart`: the agent was interrupted and resumed with it. */
export interface SteerPart { type: 'steer'; id: string; text: string; via: 'live' | 'restart'; createdAt: number }
export type Part = TextPart | ImagePart | ToolPart | FilePart | TotemProposalPart | SteerPart

export type ChatMode = 'chat' | 'task' | 'computer'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  attachments?: Attachment[]
  parts?: Part[]
  status?: 'streaming' | 'done' | 'error' | 'stopped'
  error?: string
  provider?: string
  model?: string
  durationMs?: number
  mode?: ChatMode
  voice?: boolean
  /** Older replies: the lane the retired Auto/Instant/Thinking presets chose. */
  route?: 'instant' | 'thinking'
  level?: number
  /** Older replies: the retired Auto power it ran at, 1..5. */
  power?: number
  /** The reasoning effort it ran at (Cursor's is inside `model`). */
  effort?: string
  /** What the CLI reported for this reply (chat/stats.mjs); absent = not reported. */
  stats?: TurnStatsData
  /** A totem's scheduled run, posted to its chat. */
  run?: { trigger: string; status: string; notified: boolean }
  /** A message the bridge never received (offline, dropped connection). Kept locally with Retry. */
  unsent?: boolean
  sendError?: string
}

export interface TurnStatsData {
  ttftMs?: number
  input?: number
  cached?: number
  output?: number
  reasoning?: number
  apiMs?: number
  costUsd?: number
  tps?: number
  tools?: number
}

export interface ModelSettings {
  modelId: string
  speed: string
  effort: string
  context: string
  /** Set only on settings saved under the retired Auto/Instant/Thinking presets (see `fromPreset`). */
  preset?: string
  /** What the agent may do without asking (chat/AccessControl.tsx). Unset = Full access. */
  access?: Access
}

export type Access = 'supervised' | 'edits' | 'auto' | 'full'

export interface ChatThread {
  id: string
  kind: 'regular' | 'temporary'
  title?: string
  /** A chat/thread-icons.mjs name the title model picked. */
  icon?: string
  provider?: string
  modelSettings?: Partial<ModelSettings>
  pinned?: boolean
  /** The project this chat belongs to; none = Home. */
  projectId?: string
  /** This is a totem's own chat (its job id). Kept out of Recents. */
  totemId?: string
  /** Totems brought into this chat (job ids): a group chat its agent hosts. */
  members?: string[]
  /** A project chat that reads none of the project's instructions, memory or files. */
  projectContextOff?: boolean
  /** Finished, and not yet answered or marked read. */
  needsReply?: boolean
  /** He marked it unread to come back to: opening it no longer reads it. Only set with needsReply. */
  keepUnread?: boolean
  /** The owner settled it ('settled') or took it back off the shelf ('active', which also keeps auto-settle off it). See settle.ts. */
  settledOverride?: 'settled' | 'active'
  settledAt?: number
  /** When it last came back off the Settled shelf; counts as activity. */
  unsettledAt?: number
  /** Hidden in Snoozed until then. A past time that's still set means it woke and hasn't been opened since. */
  snoozedUntil?: number
  snoozedAt?: number
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  expiresAt?: number
}

/** A file a project shares with every chat in it (an upload id). */
export interface ProjectFile {
  id: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'file' | 'text'
  /** Uploaded on the Files tab, attached in one of its chats, or made by the agent. */
  source: 'upload' | 'chat' | 'agent'
  addedAt: number
  threadId?: string
  url?: string
}

/** A chat project (chat/projects.mjs): shared default model, instructions, memory and files. */
export interface Project {
  id: string
  name: string
  icon?: string
  instructions: string
  provider?: string
  modelSettings?: Partial<ModelSettings>
  /** A folder: the top-level project it sits in. */
  parentId?: string
  fileCount: number
  chatCount: number
  createdAt: number
  updatedAt: number
  /** Only on a project fetched on its own. */
  files?: ProjectFile[]
  memory?: string
}

export interface ProviderRow {
  id: string
  driver: string
  name: string
  accentColor?: string
  supportsModelPicker?: boolean
  supportsStreaming?: boolean
  default?: boolean
}

export interface ModelRow {
  id: string
  name: string
  recommended?: boolean
  hidden?: boolean
  favorite?: boolean
  efforts?: string[]
  defaultEffort?: string | null
  /** One line on what the model is for and what it costs (Claude seeds). */
  note?: string
}

export interface ProviderCaps {
  driver: string
  state?: string
  fix?: string | null
  images: 'native' | 'file'
  resume: boolean
  computerUse: { available: boolean; reason?: string | null; platform?: string; checkedAt?: string | null; tools?: string[] }
}

export interface ChatCapabilities {
  providers: Record<string, ProviderCaps>
  transcription: { ready: boolean; model: string | null }
  maxUploadBytes: number
  platform: string
}

/** A file in the composer, before and after it reaches the bridge. */
export interface DraftAttachment {
  key: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'file' | 'text'
  previewUrl?: string
  textPreview?: string
  status: 'uploading' | 'ready' | 'error'
  error?: string
  uploaded?: Attachment
}

export type StreamEvent =
  | { type: 'start'; threadId: string; userMessage: ChatMessage; assistantMessage: ChatMessage; provider: string; mode: ChatMode; seq: number }
  | { type: 'delta'; text: string; seq: number }
  | { type: 'tool'; tool: any; seq: number }
  | { type: 'agent'; toolId: string; agent?: Partial<AgentInfo>; step?: AgentStep; seq: number }
  | { type: 'image'; uploadId: string; alt?: string; url?: string; seq: number }
  | ({ type: 'browser'; seq: number } & BrowserFrame)
  | { type: 'file'; file: FilePart; seq: number }
  | { type: 'steer'; steer: Omit<SteerPart, 'type'>; seq: number }
  | { type: 'activity'; text: string; seq: number }
  | { type: 'title'; title: string; icon?: string; seq: number }
  | { type: 'done'; message: ChatMessage; seq: number }
  | { type: 'error'; text: string; seq: number }
  | { type: 'end'; status: string; seq: number }
