// Studio's shared bits: the icon registry every Studio surface draws from, and
// the live chat-command catalog.
//
// This file used to *be* the skill store — a hardcoded SYSTEM_SKILLS array the UI
// could only toggle, plus a localStorage bag of user skills the bridge never read.
// That meant the skills that shipped couldn't be edited and the ones you wrote
// couldn't run. Both now live on the bridge as Markdown files (see skills/store.mjs
// and /api/skills), so what's left here is presentation plus a small cache so the
// chat composer can offer commands without refetching on every keystroke.
import {
  BeakerIcon,
  BoltIcon,
  BookOpenIcon,
  BookmarkIcon,
  BookmarkSquareIcon,
  BriefcaseIcon,
  BugAntIcon,
  BuildingOffice2Icon,
  CalendarDaysIcon,
  CalendarIcon,
  CameraIcon,
  ChartBarSquareIcon,
  ChatBubbleLeftIcon,
  CheckCircleIcon,
  CircleStackIcon,
  ClipboardIcon,
  ClockIcon,
  CloudIcon,
  Cog8ToothIcon,
  CommandLineIcon,
  CubeIcon,
  DocumentCheckIcon,
  DocumentIcon,
  EnvelopeIcon,
  FireIcon,
  FlagIcon,
  FolderIcon,
  GiftIcon,
  GlobeAmericasIcon,
  HandThumbUpIcon,
  HeartIcon,
  HomeIcon,
  InboxStackIcon,
  MagnifyingGlassIcon,
  MapIcon,
  MapPinIcon,
  MoonIcon,
  MusicalNoteIcon,
  NewspaperIcon,
  PaintBrushIcon,
  PaperAirplaneIcon,
  PencilIcon,
  PencilSquareIcon,
  PlayIcon,
  RocketLaunchIcon,
  ServerStackIcon,
  ShoppingCartIcon,
  SparklesIcon,
  Squares2X2Icon,
  SquaresPlusIcon,
  StarIcon,
  SunIcon,
  TableCellsIcon,
  TicketIcon,
  TrophyIcon,
  UserGroupIcon,
  VideoCameraIcon,
  ViewColumnsIcon,
  WrenchIcon,
  PuzzlePieceIcon,
} from './icons'

// The one localStorage key still worth reading: jobs authored in the very old
// Workflows tab, which were saved here and scheduled by nothing. JobsView offers
// to import them as real server-side jobs, then clears the key. Everything else
// that used to live in this browser (user skills, system-skill toggles, system
// workflow overrides) is now on the bridge, where the scheduler can actually see it.
const WORKFLOWS_KEY = 'totem_workflows'

function readLegacy(key: string, fallback: any) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

export const listWorkflows = () => readLegacy(WORKFLOWS_KEY, [])
export const saveWorkflows = (workflows: any) => localStorage.setItem(WORKFLOWS_KEY, JSON.stringify(workflows))

export const STUDIO_ICONS: Record<string, any> = {
  sparkles: SparklesIcon,
  bolt: BoltIcon,
  sun: SunIcon,
  moon: MoonIcon,
  puzzle: PuzzlePieceIcon,
  check: CheckCircleIcon,
  calendar: CalendarDaysIcon,
  calendar2: CalendarIcon,
  columns: ViewColumnsIcon,
  brain: CircleStackIcon,
  search: MagnifyingGlassIcon,
  note: PencilSquareIcon,
  pencil: PencilIcon,
  command: CommandLineIcon,
  clock: ClockIcon,
  chat: ChatBubbleLeftIcon,
  star: StarIcon,
  bookmark: BookmarkIcon,
  bookmark2: BookmarkSquareIcon,
  heart: HeartIcon,
  flag: FlagIcon,
  gift: GiftIcon,
  building: BuildingOffice2Icon,
  grid: SquaresPlusIcon,
  table: TableCellsIcon,
  briefcase: BriefcaseIcon,
  database: ServerStackIcon,
  inbox: InboxStackIcon,
  cube: CubeIcon,
  folder: FolderIcon,
  envelope: EnvelopeIcon,
  document: DocumentIcon,
  documentCheck: DocumentCheckIcon,
  book: BookOpenIcon,
  users: UserGroupIcon,
  send: PaperAirplaneIcon,
  wrench: WrenchIcon,
  clipboard: ClipboardIcon,
  fire: FireIcon,
  globe: GlobeAmericasIcon,
  globe2: GlobeAmericasIcon,
  beaker: BeakerIcon,
  cloud: CloudIcon,
  cart: ShoppingCartIcon,
  home: HomeIcon,
  settings: Cog8ToothIcon,
  map: MapIcon,
  music: MusicalNoteIcon,
  brush: PaintBrushIcon,
  video: VideoCameraIcon,
  chart: ChartBarSquareIcon,
  news: NewspaperIcon,
  thumb: HandThumbUpIcon,
  camera: CameraIcon,
  ticket: TicketIcon,
  bug: BugAntIcon,
  trophy: TrophyIcon,
  rocket: RocketLaunchIcon,
  pin: MapPinIcon,
  play: PlayIcon,
}

export const STUDIO_ICON_OPTIONS = Object.keys(STUDIO_ICONS)

export function iconFor(name: string, fallback = 'sparkles') {
  return STUDIO_ICONS[name] || STUDIO_ICONS[fallback] || SparklesIcon
}

export function commandSlug(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

// ---- chat command catalog --------------------------------------------------
//
// The composer's "/" and "$" menu. Commands are whatever the skills on the bridge
// declare, so a skill you rename, add, or give a new command to shows up in chat
// immediately — the old hardcoded list is exactly why `$plaud-meetings` and the
// Skills tab could disagree about what existed.
//
// A tiny external store rather than props: three separate <Composer> call sites
// need it, and it's one fetch shared between them.

export interface ChatCommand {
  cmd: string
  icon: any
  title: string
  desc: string
  /** 'send' runs it; 'fill' drops the text in the box for you to finish. */
  mode: 'send' | 'fill'
  text: string
  /**
   * Styling only. Everything is a skill now, but `$` has long meant "the heavy
   * scheduled kind" and `/` "the quick one", so the menu keeps colouring them
   * differently rather than flattening a distinction people already read.
   */
  kind: 'skill' | 'workflow'
}

let commandCache: ChatCommand[] = []
let commandsLoaded = false
const commandListeners = new Set<() => void>()

function emitCommands() {
  for (const fn of commandListeners) fn()
}

function toCommand(skill: any): ChatCommand | null {
  if (!skill.command || skill.enabled === false) return null
  return {
    cmd: skill.command,
    icon: iconFor(skill.iconName, 'sparkles'),
    title: skill.name,
    desc: skill.description || 'Run this skill.',
    mode: skill.mode === 'fill' ? 'fill' : 'send',
    // A fill-mode skill is a prefix you finish typing ("Search my memory for: "),
    // so it needs the trailing space the file format trims off.
    text: skill.mode === 'fill' ? `${skill.body.trimEnd()} ` : skill.command,
    kind: skill.command.startsWith('$') ? 'workflow' : 'skill',
  }
}

/** Replace the cached catalog from an /api/skills payload. */
export function setChatCommands(skills: any[]) {
  commandCache = (skills || []).map(toCommand).filter(Boolean) as ChatCommand[]
  commandsLoaded = true
  emitCommands()
}

export const getChatCommands = () => commandCache
export const chatCommandsLoaded = () => commandsLoaded

export function subscribeChatCommands(fn: () => void) {
  commandListeners.add(fn)
  return () => { commandListeners.delete(fn) }
}
