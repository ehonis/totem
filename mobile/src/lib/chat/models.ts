// Model choice per thread. Cursor's model ids take bracket parameters
// (`composer-2.5[fast=true,effort=high]`); Codex/Claude/OpenCode take a bare id,
// with reasoning effort sent alongside.
import type { ModelRow, ModelSettings, ProviderRow } from './types'

export const DEFAULT_MODEL_SETTINGS: ModelSettings = { modelId: 'composer-2.5', speed: 'fast', effort: 'default', context: 'default' }

/** Names for the retired presets, for older replies' stats. */
export const POWER_NAMES: Record<string, string> = { '1': 'Quick', '2': 'Light', '3': 'Balanced', '4': 'Strong', '5': 'Max' }
export const LEVEL_NAMES: Record<string, string> = { '1': 'Low', '2': 'Medium', '3': 'High', '4': 'Extra high', '5': 'Max' }

export const EFFORT_LABELS: Record<string, string> = {
  default: 'Model default', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
}

export function normalizeModelSettings(settings?: Partial<ModelSettings> | null): ModelSettings {
  const { preset: _p, level: _l, power: _w, ...rest } = (settings || {}) as Partial<ModelSettings> & { level?: string; power?: string }
  return { ...DEFAULT_MODEL_SETTINGS, ...rest }
}

/**
 * Settings saved while Auto, Instant or Thinking was chosen (retired 2026-10-07).
 * Their model fields were never the owner's pick, so callers treat them as unset.
 */
export function fromPreset(settings?: Partial<ModelSettings> | null): boolean {
  return !!settings?.preset && settings.preset !== 'manual'
}

/** "composer-2.5[fast=true,effort=high]" → structured settings. */
export function parseModelSpec(spec?: string | null): ModelSettings {
  if (!spec || typeof spec !== 'string') return { ...DEFAULT_MODEL_SETTINGS }
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(spec.trim())
  if (!m) return { ...DEFAULT_MODEL_SETTINGS }
  const out: ModelSettings = { ...DEFAULT_MODEL_SETTINGS, modelId: m[1].trim(), speed: 'default', effort: 'default', context: 'default' }
  for (const part of (m[2] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split('=')
    if (k === 'fast') out.speed = v === 'true' ? 'fast' : 'quality'
    else if (k === 'effort') out.effort = v
    else if (k === 'context') out.context = v
  }
  return out
}

export function buildCursorSpec(settings?: Partial<ModelSettings> | null): string {
  const s = normalizeModelSettings(settings)
  const params: string[] = []
  if (s.speed === 'fast') params.push('fast=true')
  if (s.speed === 'quality') params.push('fast=false')
  if (s.effort && s.effort !== 'default') params.push(`effort=${s.effort}`)
  if (s.context && s.context !== 'default') params.push(`context=${s.context}`)
  return params.length ? `${s.modelId}[${params.join(',')}]` : s.modelId
}

/** What goes on the wire for this provider: {model, effort}. */
export function wireModel(driver: string, settings: Partial<ModelSettings> | undefined): { model: string | null; effort: string | null } {
  const s = normalizeModelSettings(settings)
  if (driver === 'cursor') return { model: buildCursorSpec(s), effort: null }
  return { model: s.modelId || null, effort: s.effort && s.effort !== 'default' ? s.effort : null }
}

/** Picker order: hidden dropped, favourites first. */
export function visibleModels(models?: ModelRow[]): ModelRow[] {
  return (models || []).filter((m) => !m.hidden).slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0))
}

/** Starting settings for a chat on `provider`. */
export function defaultSettingsFor(provider: ProviderRow | undefined, defaultProvider: string, defaultModel: string | null): ModelSettings {
  if (!provider) return { ...DEFAULT_MODEL_SETTINGS }
  if (provider.driver === 'cursor') {
    return provider.id === defaultProvider && defaultModel ? normalizeModelSettings(parseModelSpec(defaultModel)) : { ...DEFAULT_MODEL_SETTINGS }
  }
  const modelId = provider.id === defaultProvider ? (defaultModel || '').split('[')[0].trim() : ''
  return { ...DEFAULT_MODEL_SETTINGS, modelId, speed: 'default', effort: 'default', context: 'default' }
}

/**
 * Settings for a model picked from the picker. The default's speed and context
 * belong to the default's model: Cursor takes bracket params only on Composer and
 * spells them into the id everywhere else (`gpt-5.3-codex-fast`), so `auto` or
 * `gpt-5.2` carrying `[fast=true]` is refused outright.
 */
export function settingsForPick(provider: ProviderRow | undefined, modelId: string | undefined, defaultProvider: string, defaultModel: string | null): ModelSettings {
  const base = defaultSettingsFor(provider, defaultProvider, defaultModel)
  if (!modelId || modelId === base.modelId) return { ...base, effort: 'default' }
  return { ...base, modelId, speed: 'default', effort: 'default', context: 'default' }
}

export function modelLabel(models: ModelRow[] | undefined, id: string): string {
  return (models || []).find((m) => m.id === id)?.name || id
}
