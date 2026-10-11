/**
 * Central Heroicons wiring, ported from web/src/icons.tsx: same names, from
 * react-native-heroicons (the same glyphs drawn with react-native-svg).
 */
import React from 'react'
import type { ColorValue, StyleProp, ViewStyle } from 'react-native'
import { ExclamationTriangleIcon as ExclamationTriangleSolidIcon } from 'react-native-heroicons/solid'
import { colors } from '../theme'

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
} from 'react-native-heroicons/outline'

// Solid variants where a filled glyph reads better (send/stop, warnings, active star).
export {
  ArrowUpIcon as ArrowUpSolidIcon,
  CheckBadgeIcon as CheckBadgeSolidIcon,
  ExclamationTriangleIcon as ExclamationTriangleSolidIcon,
  StarIcon as StarSolidIcon,
  StopIcon as StopSolidIcon,
  TrophyIcon as TrophySolidIcon,
} from 'react-native-heroicons/solid'

/** Any icon component from either set: takes size, color and strokeWidth. */
export type IconType = React.ComponentType<any>

interface HiProps {
  icon: IconType
  size?: number
  color?: ColorValue
  strokeWidth?: number
  style?: StyleProp<ViewStyle>
}

/** Render a Heroicon at a fixed size. Colour defaults to the theme text colour (CSS currentColor). */
export function Hi({ icon: Icon, size = 16, color = colors.text, strokeWidth, style }: HiProps) {
  return <Icon size={size} width={size} height={size} color={color} {...(strokeWidth ? { strokeWidth } : {})} style={style} />
}

/** Compact inline warning glyph for error/empty states. */
export function WarnIcon({ size = 14 }: { size?: number }) {
  return <Hi icon={ExclamationTriangleSolidIcon} size={size} color={colors.amber} />
}
