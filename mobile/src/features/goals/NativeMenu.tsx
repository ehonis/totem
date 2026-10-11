// A "…" menu as the platform's own: UIMenu on iOS (anchored to the button, SF
// Symbol glyphs, inline sections for the web menu's separators); an action sheet
// elsewhere, which is also what the react-native-web preview falls back to.
import React from 'react'
import { Platform } from 'react-native'
import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { Press } from '../../ui/kit'
import { showMenu } from '../../ui/menu'
import { tap } from '../../ui/haptics'

export interface MenuItemDef {
  id: string
  title: string
  /** SF Symbol name. */
  image?: string
  destructive?: boolean
  onPress: () => void
}

/** Sections are drawn with a divider between them, like `.goal-menu-separator`. */
export function NativeMenu({ sections, title, children, label, disabled }: {
  sections: MenuItemDef[][]
  title?: string
  children: React.ReactNode
  label: string
  disabled?: boolean
}) {
  const items = sections.flat()
  if (disabled) return <Press disabled accessibilityLabel={label}>{children}</Press>
  if (Platform.OS !== 'ios') {
    return (
      <Press disabled={disabled} accessibilityLabel={label} hitSlop={8}
        onPress={() => showMenu(items.map((i) => ({ label: i.title, destructive: i.destructive, onPress: i.onPress })), { title })}>
        {children}
      </Press>
    )
  }
  const actions: MenuAction[] = sections.filter((s) => s.length).map((section, n) => ({
    id: `section-${n}`,
    title: '',
    displayInline: true,
    subactions: section.map((i) => ({
      id: i.id,
      title: i.title,
      image: i.image,
      attributes: i.destructive ? { destructive: true } : undefined,
    })),
  }))
  return (
    <MenuView
      title={title}
      actions={actions}
      themeVariant="dark"
      onOpenMenu={tap}
      // Run once the menu has finished dismissing: a sheet or an alert presented
      // while UIMenu is still animating away can be dropped by UIKit.
      onPressAction={({ nativeEvent }) => {
        const item = items.find((i) => i.id === nativeEvent.event)
        if (item) setTimeout(item.onPress, 250)
      }}
    >
      {children}
    </MenuView>
  )
}
