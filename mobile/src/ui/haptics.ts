// One place for haptics, so their weight stays consistent: a light tick for taps
// and selection, a success buzz for things that finished (a task done, a habit
// logged), a warning for destructive confirms.
import * as Haptics from 'expo-haptics'

export const tap = () => { Haptics.selectionAsync().catch(() => {}) }
export const impact = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}) }
export const success = () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}) }
/** The faint tap under streaming text: the lightest impact iOS has. */
export const typeTick = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => {}) }
export const warn = () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}) }
