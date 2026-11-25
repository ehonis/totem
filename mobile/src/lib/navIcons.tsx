/**
 * The web rail's glyphs (web/src/navIcons.tsx), one per destination, from Lucide
 * (T3 Code's icon set): the drawer, the Overview's app row and anything else that
 * leads to one of these pages take their glyph from here. Change both tables
 * together; navIcons.test.mjs checks they name the same icons.
 *
 * Imported deep, per icon, so the package tree-shakes (AGENTS.md › Gotchas).
 * Totems keep their own mark (assets/images/totems-icon.png).
 */
import React from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react-native'
import LayoutDashboard from 'lucide-react-native/icons/layout-dashboard'
import Search from 'lucide-react-native/icons/search'
import MessagesSquare from 'lucide-react-native/icons/messages-square'
import CalendarCheck from 'lucide-react-native/icons/calendar-check'
import Inbox from 'lucide-react-native/icons/inbox'
import CodeXml from 'lucide-react-native/icons/code-xml'
import Server from 'lucide-react-native/icons/server'
import MessageCircle from 'lucide-react-native/icons/message-circle'
import Monitor from 'lucide-react-native/icons/monitor'
import KeyRound from 'lucide-react-native/icons/key-round'
import Settings from 'lucide-react-native/icons/settings'

/** Lucide's 2px stroke reads heavy at 20px; 1.75 matches the Tabler glyphs beside it, as on the web. */
const NAV_STROKE = 1.75

function nav(Icon: LucideIcon, name: string): React.ComponentType<LucideProps> {
  const Glyph = ({ strokeWidth, ...props }: LucideProps) => <Icon {...props} strokeWidth={strokeWidth ?? NAV_STROKE} />
  Glyph.displayName = `Nav${name}`
  return Glyph
}

export const NAV_ICONS = {
  overview: nav(LayoutDashboard, 'Overview'),
  search: nav(Search, 'Search'),
  chat: nav(MessagesSquare, 'Chat'),
  productivity: nav(CalendarCheck, 'Productivity'),
  inbox: nav(Inbox, 'Inbox'),
  dev: nav(CodeXml, 'Dev'),
  fleet: nav(Server, 'Fleet'),
  messages: nav(MessageCircle, 'Messages'),
  screen: nav(Monitor, 'Screen'),
  cliproxy: nav(KeyRound, 'CLIProxy'),
  settings: nav(Settings, 'Settings'),
}
