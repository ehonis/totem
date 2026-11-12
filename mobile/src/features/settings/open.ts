// Opening a pane, apart from SettingsScreen so a pane can link to another
// without importing the list that imports it.
import { router } from 'expo-router'

/** Push a pane, optionally scrolled to one of its rows. */
export function openPane(id: string, row?: string | null) {
  router.push({ pathname: '/settings/[pane]', params: row ? { pane: id, row } : { pane: id } })
}
