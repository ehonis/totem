// chat/route.mjs — which model a chat turn runs on.
//
// The owner picks the account and model in the composer's model picker; there
// is no automatic routing. (Auto, Instant and Thinking were retired on
// 2026-10-07: guessing the model from the message never made sense.)

import { projectModelDefault } from './projects.mjs'

/**
 * The hand-picked model (and effort) a manual turn should run, given the
 * account it was picked on (`requested`) and the account the turn actually
 * lands on (`provider`). A temporary chat is held to the default account, so a
 * model picked on another account would mean nothing there: drop it and let
 * that account's default answer. A request that names no account keeps its
 * model, as it always has.
 */
export function manualModelFor({ requested, provider, model, effort }) {
  const sameAccount = !requested || requested === provider
  return sameAccount ? { model: model ?? null, effort: effort ?? null } : { model: null, effort: null }
}

/** "composer-2.5[fast=true,effort=high]" as model settings; parseModelSpec in web/src/chat/models.ts is its twin. */
export function settingsFromSpec(spec) {
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(String(spec || '').trim())
  if (!m) return null
  const out = { modelId: m[1].trim(), speed: 'default', effort: 'default', context: 'default' }
  for (const part of (m[2] || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.split('=')
    if (k === 'fast') out.speed = v === 'true' ? 'fast' : 'quality'
    else if (k === 'effort' || k === 'context') out[k] = v
  }
  return out
}

/**
 * The account and model a chat the bridge makes itself (threads__create) is
 * stored with: the folder's default, else its project's, else Settings → Providers,
 * always with the model named. A default that names no model gets the one a run
 * on that account would use (`resolveModel(provider, effort)`, resolveChatModel
 * in bridge.mjs), so the composer shows what runs and a later change in
 * Settings → Providers does not move the chat.
 */
export async function newChatChoice({ projects, projectId, config, driverOf, resolveModel }) {
  const home = projectModelDefault(projects, projectId, { usable: (p) => config.enabledProviders.includes(p) })
    || { provider: config.defaultProvider, modelSettings: null }
  const ms = home.modelSettings || {}
  if (ms.modelId) return home
  const r = await resolveModel(home.provider, ms.effort && ms.effort !== 'default' ? ms.effort : null)
  const named = driverOf(home.provider) === 'cursor' ? settingsFromSpec(r?.cursorModel) : r?.model ? { modelId: r.model } : null
  // The resolved model id; what the default set itself (effort, speed, context) stays.
  return named ? { provider: home.provider, modelSettings: { ...named, ...ms, modelId: named.modelId } } : home
}

/**
 * A chat's stored choice ({ provider, modelSettings }) as startChatTurn's
 * fields. The bridge's twin of wireModel in web/src/chat/models.ts, defaults
 * included: Cursor takes its speed and context as bracket parameters on the id
 * (fast unless set otherwise), the other CLIs a bare id and an effort.
 */
export function turnModelFields({ provider, modelSettings: ms } = {}, driver = '') {
  if (!provider) return {}
  if (!ms?.modelId) return { provider, ...(ms ? { modelSettings: ms } : {}) }
  const effort = ms.effort && ms.effort !== 'default' ? ms.effort : null
  if (driver === 'cursor') {
    const speed = ms.speed || 'fast'
    const params = []
    if (speed === 'fast') params.push('fast=true')
    if (speed === 'quality') params.push('fast=false')
    if (effort) params.push(`effort=${effort}`)
    if (ms.context && ms.context !== 'default') params.push(`context=${ms.context}`)
    return { provider, model: params.length ? `${ms.modelId}[${params.join(',')}]` : ms.modelId, modelSettings: ms }
  }
  return { provider, model: ms.modelId, ...(effort ? { effort } : {}), modelSettings: ms }
}
