/**
 * The rail's glyphs, one per destination, from Lucide (T3 Code's icon set).
 *
 * Every place that leads to one of these pages (the rail, the phone drawer, the
 * Overview's app row, a page's own heading) takes its glyph from here, so a page
 * looks the same wherever it is offered. The iPhone app has the same table in
 * mobile/src/lib/navIcons.tsx; change both together.
 *
 * Imported deep, per icon, so the package tree-shakes (AGENTS.md › Gotchas).
 * Totems keep their own mark (components/TotemsIcon.tsx).
 */
import React from 'react'
import type { LucideIcon } from 'lucide-react'
import LayoutDashboard from 'lucide-react/icons/layout-dashboard'
import Search from 'lucide-react/icons/search'
import MessagesSquare from 'lucide-react/icons/messages-square'
import CalendarCheck from 'lucide-react/icons/calendar-check'
import Inbox from 'lucide-react/icons/inbox'
import CodeXml from 'lucide-react/icons/code-xml'
import Server from 'lucide-react/icons/server'
import MessageCircle from 'lucide-react/icons/message-circle'
import Monitor from 'lucide-react/icons/monitor'
import KeyRound from 'lucide-react/icons/key-round'
import Settings from 'lucide-react/icons/settings'

type NavIcon = React.ComponentType<React.SVGProps<SVGSVGElement>>

/** The rail draws at 21px, where Lucide's 2px stroke reads heavy; 1.75 matches the Tabler glyphs beside it. */
const NAV_STROKE = 1.75

// Lucide takes `strokeWidth`; Tabler's wrapper (TI in chat/ui.tsx) passes a numeric
// `stroke`, which on a Lucide SVG would be read as a colour. Take either.
function nav(Icon: LucideIcon, name: string): NavIcon {
  const Glyph = ({ stroke, strokeWidth, ...props }: React.SVGProps<SVGSVGElement>) => {
    // Typed as a string, but TI hands Tabler's numeric stroke width through it.
    const given: unknown = stroke
    return (
      <Icon
        {...props}
        {...(typeof given === 'string' ? { stroke: given } : {})}
        strokeWidth={typeof given === 'number' ? given : (strokeWidth ?? NAV_STROKE)}
      />
    )
  }
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
} satisfies Record<string, NavIcon>
