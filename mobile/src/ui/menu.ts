// The "…" menus and confirms, as the platform's own sheets: iOS action sheet,
// Alert elsewhere. Use these instead of drawing popovers, so a menu looks and
// dismisses the way every other app's does.
import { ActionSheetIOS, Alert, Platform } from 'react-native'
import { tap, warn } from './haptics'

export interface MenuItem {
  label: string
  onPress: () => void
  destructive?: boolean
}

/** Show a list of actions. A Cancel row is added. */
export function showMenu(items: MenuItem[], { title, message }: { title?: string; message?: string } = {}) {
  tap()
  if (Platform.OS === 'ios') {
    const options = [...items.map((i) => i.label), 'Cancel']
    const destructiveButtonIndex = items.map((i, n) => (i.destructive ? n : -1)).filter((n) => n >= 0)
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: items.length, destructiveButtonIndex, title, message, userInterfaceStyle: 'dark' },
      (n) => { if (n < items.length) items[n].onPress() },
    )
    return
  }
  Alert.alert(title || '', message, [
    ...items.map((i) => ({ text: i.label, onPress: i.onPress, style: i.destructive ? ('destructive' as const) : ('default' as const) })),
    { text: 'Cancel', style: 'cancel' as const },
  ])
}

/** "Delete this?" with a red confirm. Resolves true when confirmed. */
export function confirm(title: string, { message, confirmLabel = 'Delete', destructive = true }: { message?: string; confirmLabel?: string; destructive?: boolean } = {}): Promise<boolean> {
  if (destructive) warn()
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false), userInterfaceStyle: 'dark' })
  })
}

/** A one-line text prompt (rename, new list). iOS only natively; elsewhere resolves null. */
export function prompt(title: string, { message, defaultValue = '', placeholder }: { message?: string; defaultValue?: string; placeholder?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    if (Platform.OS !== 'ios') { resolve(null); return }
    Alert.prompt(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      { text: 'Save', onPress: (v?: string) => resolve((v ?? '').trim() || null) },
    ], 'plain-text', defaultValue, undefined, { userInterfaceStyle: 'dark' } as any)
    void placeholder
  })
}

/** The subset of @react-native-menu/menu's MenuAction this reads. */
interface TreeAction {
  id?: string
  title: string
  displayInline?: boolean
  subactions?: TreeAction[]
  attributes?: { disabled?: boolean; destructive?: boolean; hidden?: boolean }
}

/**
 * A MenuView's actions as action sheets, for a long-press where a MenuView
 * wrapper can't be used (inside the drawer it swallows the row's tap). Inline
 * groups are flattened; an item with a submenu opens a second sheet.
 */
export function showActionTree(actions: TreeAction[], run: (id: string) => void, title?: string) {
  const flat = actions.flatMap((a) => (a.displayInline && a.subactions ? a.subactions : [a]))
    .filter((a) => !a.attributes?.disabled && !a.attributes?.hidden && (a.id || a.subactions))
  showMenu(flat.map((a) => ({
    label: a.subactions ? `${a.title} …` : a.title,
    destructive: a.attributes?.destructive,
    onPress: () => (a.subactions ? setTimeout(() => showActionTree(a.subactions!, run, a.title), 350) : run(a.id!)),
  })), { title })
}
