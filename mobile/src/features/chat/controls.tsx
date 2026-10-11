// The composer's dials (web chat/ThinkingControl.tsx, AccessControl.tsx). The
// web opens each as a small popover; a phone gets the platform's own menu
// instead: every stop is a row with its hint underneath and a check on the
// current one. Same choices, same words. The model sheet (ModelPicker.tsx)
// lists the same two below its models.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import type { Access } from '../../lib/chat/types'
import { T } from '../../ui/Text'
import { tap } from '../../ui/haptics'
import { TI, vc } from './ui'
import { IconChevronDown, IconLock, IconLockOpen, IconPencilCheck, IconSparkles } from './icons'

const HINTS: Record<string, string> = {
  low: 'Quick, for simple questions',
  medium: 'Balanced speed and depth',
  high: 'Takes longer, for harder problems',
  xhigh: 'Works it through carefully',
  max: 'Deepest reasoning; can take minutes',
}
export const hintFor = (effort: string) => HINTS[effort] || ''

function Menu({ title, actions, onPick, children, label, fixed }: { title?: string; actions: MenuAction[]; onPick: (id: string) => void; children: React.ReactNode; label: string; fixed?: boolean }) {
  return (
    <MenuView
      style={fixed ? { flexShrink: 0 } : { flexShrink: 1, minWidth: 0 }}
      title={title}
      actions={actions}
      themeVariant="dark"
      onOpenMenu={tap}
      onPressAction={({ nativeEvent }) => { tap(); onPick(nativeEvent.event) }}
    >
      <View accessible accessibilityRole="button" accessibilityLabel={label} style={fixed ? undefined : { flexShrink: 1, minWidth: 0 }}>{children}</View>
    </MenuView>
  )
}

export interface Stop { value: string; label: string; hint?: string }

/** ChatGPT's "Thinking effort": one row per level, with what it costs. */
export function ThinkingControl({ stops, value, onChange, label = 'Thinking effort' }: { stops: Stop[]; value: string; onChange: (v: string) => void; label?: string }) {
  const current = stops.find((s) => s.value === value) || stops[0]
  return (
    <Menu
      title={label}
      label={`${label}: ${current?.label}`}
      actions={stops.map((s) => ({ id: s.value, title: s.label, subtitle: s.hint || undefined, state: s.value === current?.value ? ('on' as const) : undefined }))}
      onPick={onChange}
    >
      <View style={st.chip}>
        <T size={14} color={vc.soft}>Effort</T>
        <TI icon={IconChevronDown} size={14} color={vc.faint} />
      </View>
    </Menu>
  )
}

export type { Access }
// What the agent may do in this chat without asking. The bridge runs every CLI in
// print mode, which cannot stop to ask, so "asks" means the action is refused.
export const ACCESS_MODES: { id: Access; label: string; hint: string; icon: any; sf: string }[] = [
  { id: 'supervised', label: 'Supervised', hint: 'Read and use connectors. Commands and file changes are refused.', icon: IconLock, sf: 'lock' },
  { id: 'edits', label: 'Auto-accept edits', hint: 'File edits go through; commands are refused.', icon: IconPencilCheck, sf: 'pencil' },
  { id: 'auto', label: 'Auto', hint: 'Providers that can judge routine actions approve them; anything else is refused.', icon: IconSparkles, sf: 'sparkles' },
  { id: 'full', label: 'Full access', hint: 'Commands and edits without prompts.', icon: IconLockOpen, sf: 'lock.open' },
]

/** What the agent may do in this chat without asking. A phone shows only its glyph, as the web does. */
export function AccessControl({ value, onChange }: { value?: Access; onChange: (v: Access) => void }) {
  const current = ACCESS_MODES.find((m) => m.id === value) || ACCESS_MODES[3]
  return (
    <Menu
      fixed
      title="Access"
      label={`Access: ${current.label}`}
      actions={ACCESS_MODES.map((m) => ({ id: m.id, title: m.label, subtitle: m.hint, image: m.sf, state: m.id === current.id ? ('on' as const) : undefined }))}
      onPick={(id) => onChange(id as Access)}
    >
      <View style={[st.chip, { paddingHorizontal: 5, flexShrink: 0 }]}>
        <TI icon={current.icon} size={17} color={vc.soft} />
      </View>
    </Menu>
  )
}

const st = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 8, borderRadius: 999, flexShrink: 1, minWidth: 0 },
})
