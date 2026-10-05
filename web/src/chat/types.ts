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
export type Part = TextPart | ImagePart | ToolPart | FilePart | TotemProposalPart

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
  /** Which lane Auto/Instant/Thinking chose for this reply. */
  route?: 'instant' | 'thinking'
  level?: number
  /** The Auto power it ran at, 1..5. */
  power?: number
  /** A totem's scheduled run, posted to its chat. */
  run?: { trigger: string; status: string; notified: boolean }
  /** A message the bridge never received (offline, dropped connection). Kept locally with Retry. */
  unsent?: boolean
  sendError?: string
}

export type Preset = 'auto' | 'instant' | 'thinking' | 'manual'

export interface ModelSettings {
  modelId: string
  speed: string
  effort: string
  context: string
  /** Auto / Instant / Thinking pick the model on the bridge; manual uses the fields above. */
  preset: Preset
  /** The Thinking slider, '1'..'4' (Light … Heavy). */
  level: string
  /** Auto's power dial, '1'..'5' (Quick … Max): model and effort together. Unset = Auto reads the message. */
  power?: string
}

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
  | { type: 'start'; threadId: string; userMessage: ChatMessage; assistantMessage: ChatMessage; provider: string; mode: ChatMode; power?: number; seq: number }
  | { type: 'delta'; text: string; seq: number }
  | { type: 'tool'; tool: any; seq: number }
  | { type: 'image'; uploadId: string; alt?: string; url?: string; seq: number }
  | ({ type: 'browser'; seq: number } & BrowserFrame)
  | { type: 'file'; file: FilePart; seq: number }
  | { type: 'activity'; text: string; seq: number }
  | { type: 'title'; title: string; icon?: string; seq: number }
  | { type: 'done'; message: ChatMessage; seq: number }
  | { type: 'error'; text: string; seq: number }
  | { type: 'end'; status: string; seq: number }
