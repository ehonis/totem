// What the composer's picker offers beside the model: reasoning effort, speed and
// the chat's access (T3 Code's traits). Kept apart from ModelPicker so the rules
// are tested without rendering it.
import { IconLock, IconLockOpen, IconPencilCheck, IconSparkles } from './icons'
import { EFFORT_LABELS } from './models'
import type { Access, ModelRow, ModelSettings } from './types'

const HINTS: Record<string, string> = {
  minimal: 'Barely thinks; fastest replies',
  low: 'Quick, for simple questions',
  medium: 'Balanced speed and depth',
  high: 'Takes longer, for harder problems',
  xhigh: 'Works it through carefully',
  max: 'Deepest reasoning; can take minutes',
}
export const hintFor = (effort: string) => HINTS[effort] || ''

// Claude asks the owner in the chat (chat/approvals.ts); every other CLI runs in
// print mode and cannot stop to ask, so there the action is refused
// (providers/claude-tools.mjs › ACCESS_MODES). Connector tools are governed
// separately, by Settings → Connections.
export const ACCESS_MODES: { id: Access; label: string; hint: string; icon: any }[] = [
  { id: 'supervised', label: 'Supervised', hint: 'Read and use connectors. Commands and file changes ask you first (Claude) or are refused.', icon: IconLock },
  { id: 'edits', label: 'Auto-accept edits', hint: 'File edits go through; commands ask you first (Claude) or are refused.', icon: IconPencilCheck },
  { id: 'auto', label: 'Auto', hint: 'Providers that can judge routine actions approve them; anything else asks you (Claude) or is refused.', icon: IconSparkles },
  { id: 'full', label: 'Full access', hint: 'Commands and edits without prompts.', icon: IconLockOpen },
]
export const accessMode = (access?: Access) => ACCESS_MODES.find((m) => m.id === access) || ACCESS_MODES[3]

export interface EffortLevel { value: string; label: string; hint: string; isDefault: boolean }

/** The model's reasoning levels, the one in use and its default; null when it has none. */
export function effortFor(model: ModelRow | undefined, settings: Pick<ModelSettings, 'effort'>): { levels: EffortLevel[]; value: string } | null {
  const efforts = model?.efforts || []
  if (!efforts.length) return null
  const fallback = model?.defaultEffort && efforts.includes(model.defaultEffort) ? model.defaultEffort : efforts[0]
  const value = settings.effort && settings.effort !== 'default' && efforts.includes(settings.effort) ? settings.effort : fallback
  return {
    value,
    levels: efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] || e, hint: hintFor(e), isDefault: e === fallback })),
  }
}

/**
 * Standard or Fast, for the models where Totem can ask for it: Cursor's Composer,
 * which takes `[fast=true|false]` (models.ts › buildCursorSpec). Cursor spells
 * speed into every other model's id, and Codex and Claude Code runs are not sent
 * a speed at all, so for those the toggle is not shown. A bare Composer id (no
 * `fast=`) runs at standard speed: Cursor lists the fast one as its own id
 * (`composer-2.5-fast`), which needs no toggle.
 */
export function speedFor(driver: string | undefined, settings: Pick<ModelSettings, 'modelId' | 'speed'>): 'standard' | 'fast' | null {
  if (driver !== 'cursor' || !/^composer-/.test(settings.modelId || '') || /-fast$/.test(settings.modelId)) return null
  return settings.speed === 'fast' ? 'fast' : 'standard'
}
export const speedSetting = (speed: 'standard' | 'fast') => (speed === 'fast' ? 'fast' : 'quality')
