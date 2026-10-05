/**
 * Central Heroicons wiring for the Totem dashboard.
 *
 * Heroicons ship as individual React SVG components (@heroicons/react). We wrap
 * them in `Hi` so sizing works with our custom CSS (no Tailwind in this app).
 * Import icons from here rather than scattering @heroicons paths across views.
 */
import React from 'react'
import { ExclamationTriangleIcon as ExclamationTriangleSolidIcon } from '@heroicons/react/24/solid'

// 24px outline set - default for nav, buttons, and inline UI chrome.
export {
  AdjustmentsHorizontalIcon,
  ArchiveBoxIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowRightOnRectangleIcon,
  ArrowTopRightOnSquareIcon,
  ArrowsRightLeftIcon,
  ArrowUturnLeftIcon,
  BoltIcon,
  ArrowPathIcon,
  ArrowUpIcon,
  CodeBracketIcon,
  ExclamationCircleIcon,
  LockClosedIcon,
  Bars3Icon,
  BarsArrowDownIcon,
  BanknotesIcon,
  BeakerIcon,
  BellAlertIcon,
  BookOpenIcon,
  BookmarkIcon,
  BookmarkSquareIcon,
  BriefcaseIcon,
  BugAntIcon,
  BuildingOffice2Icon,
  CalendarDaysIcon,
  CalendarIcon,
  CameraIcon,
  ChartBarIcon,
  ChartBarSquareIcon,
  CheckIcon,
  ChatBubbleLeftEllipsisIcon,
  ChatBubbleLeftIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleStackIcon,
  ClockIcon,
  ClipboardIcon,
  CloudIcon,
  FireIcon,
  MapPinIcon,
  MicrophoneIcon,
  PauseIcon,
  Cog6ToothIcon,
  Cog8ToothIcon,
  CommandLineIcon,
  CubeIcon,
  DevicePhoneMobileIcon,
  DocumentCheckIcon,
  DocumentIcon,
  DocumentTextIcon,
  EllipsisHorizontalIcon,
  EnvelopeIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  FlagIcon,
  FolderIcon,
  GiftIcon,
  GlobeAltIcon,
  GlobeAmericasIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  HeartIcon,
  HomeIcon,
  InboxArrowDownIcon,
  InboxStackIcon,
  InformationCircleIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  MapIcon,
  MinusIcon,
  MoonIcon,
  MusicalNoteIcon,
  NewspaperIcon,
  NoSymbolIcon,
  PaintBrushIcon,
  PaperAirplaneIcon,
  PencilIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  PuzzlePieceIcon,
  RadioIcon,
  AcademicCapIcon,
  RocketLaunchIcon,
  ServerStackIcon,
  ShoppingCartIcon,
  SparklesIcon,
  Squares2X2Icon,
  SquaresPlusIcon,
  StarIcon,
  StopIcon,
  SunIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
  TableCellsIcon,
  TicketIcon,
  TrashIcon,
  TrophyIcon,
  UserGroupIcon,
  VideoCameraIcon,
  ViewColumnsIcon,
  WrenchIcon,
  WrenchScrewdriverIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'

// Solid variants where a filled glyph reads better (send/stop, warnings, active star).
export {
  ArrowUpIcon as ArrowUpSolidIcon,
  CheckBadgeIcon as CheckBadgeSolidIcon,
  ExclamationTriangleIcon as ExclamationTriangleSolidIcon,
  StarIcon as StarSolidIcon,
  StopIcon as StopSolidIcon,
  TrophyIcon as TrophySolidIcon,
} from '@heroicons/react/24/solid'

interface HiProps {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  size?: number
  className?: string
  style?: React.CSSProperties
  [k: string]: any
}

/** Render a Heroicon at a fixed pixel size; forwards extra props to the SVG. */
export function Hi({ icon: Icon, size = 16, className = '', style, ...props }: HiProps) {
  return (
    <Icon
      className={`hi ${className}`.trim()}
      style={{ width: size, height: size, flex: 'none', ...style }}
      aria-hidden={props['aria-label'] ? undefined : true}
      {...props}
    />
  )
}

interface WarnIconProps {
  size?: number
  className?: string
}

/** Compact inline warning glyph for error/empty states. */
export function WarnIcon({ size = 14, className = '' }: WarnIconProps) {
  return <Hi icon={ExclamationTriangleSolidIcon} size={size} className={`warn-ico ${className}`} />
}
