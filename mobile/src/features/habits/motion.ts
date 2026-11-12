// Reduce Motion for the Habits and Goals pages (#180): the system switch, or the
// app's own (Settings → Appearance), either one. Reanimated only reads the system's.
import { useReducedMotion } from 'react-native-reanimated'
import { useSettings } from '../../lib/settings'

export function useCalm(): boolean {
  const system = useReducedMotion()
  const app = useSettings().reduceMotion
  return system || app
}
