// chat/route.mjs — Auto / Instant / Thinking: Totem picks the model.
//
// The chat used to make you choose an account and a model before every new
// conversation. Most messages want one of two things — an answer now, or a
// careful answer — and which one is usually obvious from the message itself.
//
//   instant  — the fastest model signed in (see INSTANT_ORDER).
//   thinking — a reasoning model (Codex, Claude) at the slider's effort.
//   auto     — `wantsThinking` reads the message and picks one of the two.
//   manual   — the account and model the thread names, as before.
//
// Pure: the bridge passes in the enabled accounts and their health.

export const PRESETS = ['auto', 'instant', 'thinking', 'manual']
// The Thinking effort slider: five stops, named for the effort they send, the
// way ChatGPT's "Thinking effort" control reads.
export const LEVELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Extra high', 5: 'Max' }
const LEVEL_EFFORT = { 1: 'low', 2: 'medium', 3: 'high', 4: 'xhigh', 5: 'max' }

// What each driver's fast lane is, fastest first. Measured on this box
// 2026-10-02 for a one-line question, whole round trip: Claude Sonnet at low
// effort ~4.9s, Cursor Composer Fast 6-8s, Codex at low effort 6-7s. Re-measure
// before reordering; a CLI update moves these numbers.
const INSTANT = {
  cursor: { cursorModel: 'composer-2.5[fast=true]', effort: null },
  claude: { model: 'claude-haiku-4-5-20251001', effort: null },
  codex: { model: 'gpt-6-luna', effort: 'low' },
  opencode: { model: null, effort: null },
}
const INSTANT_ORDER = ['claude', 'cursor', 'codex', 'opencode']
const REASONING = new Set(['codex', 'claude'])

// Words that mean "work this out" rather than "tell me".
const THINK_WORDS = /\b(plan|planning|compare|analy[sz]e|analysis|strategy|strategi[sz]e|why|explain|draft|write (me )?an?|rewrite|research|investigate|debug|figure out|step[- ]by[- ]step|pros and cons|trade-?offs?|recommend|should i|decide|budget|itinerary|outline|review|evaluate|brainstorm|summari[sz]e (this|these|the))\b/i

export function normalizeLevel(level) {
  const n = Math.round(Number(level))
  return n >= 1 && n <= 5 ? n : 2
}

/** Does this message deserve thinking? Returns {think, level, reason}. */
export function wantsThinking({ text = '', attachments = 0, mode = 'chat' } = {}) {
  const t = String(text || '').trim()
  if (mode === 'task' || mode === 'computer') return { think: true, level: 3, reason: 'a task to carry out' }
  if (attachments > 0) return { think: true, level: 2, reason: 'files attached' }
  if (t.length > 1200) return { think: true, level: 3, reason: 'a long message' }
  if (t.length > 280) return { think: true, level: 2, reason: 'a detailed message' }
  const questions = (t.match(/\?/g) || []).length
  if (questions >= 3) return { think: true, level: 2, reason: 'several questions' }
  if (THINK_WORDS.test(t)) return { think: true, level: 2, reason: 'needs working out' }
  return { think: false, level: 0, reason: 'a quick question' }
}

// Auto's "power" dial: one overall score for how much to throw at a message —
// which model *and* how hard it thinks, not reasoning level alone. The first
// message of a chat picks a power from what it says (autoPower); after that the
// chat keeps it (stored as modelSettings.power) until the owner moves the dial.
export const POWERS = { 1: 'Quick', 2: 'Light', 3: 'Balanced', 4: 'Strong', 5: 'Max' }
const LADDER = {
  claude: {
    1: { model: 'claude-haiku-4-5-20251001', effort: null },
    2: { model: 'claude-sonnet-5-5', effort: 'low' },
    3: { model: 'claude-sonnet-5-5', effort: 'medium' },
    4: { model: 'claude-opus-5-5', effort: 'high' },
    5: { model: 'claude-opus-5-5', effort: 'max' },
  },
  codex: {
    1: { model: 'gpt-6-luna', effort: 'low' },
    2: { model: 'gpt-6-luna', effort: 'medium' },
    3: { model: 'gpt-6.1-sol', effort: 'medium' },
    4: { model: 'gpt-6.1-sol', effort: 'high' },
    5: { model: 'gpt-6.1-sol', effort: 'xhigh' },
  },
  cursor: {
    1: { cursorModel: 'composer-2.5[fast=true]' },
    2: { cursorModel: 'composer-2.5[fast=true]' },
    3: { cursorModel: 'composer-2.5[fast=false]' },
    4: { cursorModel: 'composer-2.5[fast=false]' },
    5: { cursorModel: 'composer-2.5[fast=false]' },
  },
}

export function normalizePower(power) {
  const n = Math.round(Number(power))
  return n >= 1 && n <= 5 ? n : 0
}

/** The power a message deserves on its own: {power, reason}. */
export function autoPower({ text = '', attachments = 0, mode = 'chat', voice = false } = {}) {
  if (voice && mode === 'chat') return { power: 1, reason: 'voice' }
  const d = wantsThinking({ text, attachments, mode })
  if (!d.think) return { power: String(text).trim().length < 120 ? 1 : 2, reason: d.reason }
  return { power: d.level >= 3 ? 4 : 3, reason: d.reason }
}

/** One account's model and effort at a power. */
export function powerLane(driver, power) {
  const lane = LADDER[driver]?.[normalizePower(power) || 2]
  return { model: lane?.model || null, cursorModel: lane?.cursorModel || null, effort: lane?.effort || null }
}

const usable = (a) => a && a.state !== 'missing' && a.state !== 'logged-out' && a.state !== 'error'

/**
 * Choose provider/model/effort for one turn.
 *
 * `accounts`: enabled accounts in the Providers-tab order, each
 * `{ id, driver, state, isDefault }`. Returns
 * `{ route, provider, model, cursorModel, effort, level, reason }`, or null for
 * `manual` (the caller keeps the thread's own choice).
 */
/**
 * `prefs` are the Chat settings page's choices — `{ instant: {provider, model,
 * effort}, thinking: {provider, model} }`. An empty provider means "pick for
 * me" (the rules below); a chosen account that is signed out falls back to them.
 */
export function pickRoute({ preset = 'auto', level, text, attachments = 0, mode = 'chat', voice = false, accounts = [], prefs = {}, lockTo = null, power }) {
  if (!PRESETS.includes(preset) || preset === 'manual') return null
  const live = accounts.filter(usable)
  let pool = live.length ? live : accounts
  // A chat that has started stays on its account: Auto/Instant/Thinking then
  // choose between that account's own fast and careful models, never another's.
  const locked = lockTo ? accounts.find((a) => a.id === lockTo) : null
  if (locked) pool = [locked]
  if (!pool.length) return null

  // Auto runs on the power dial: a chosen power (the chat's, or the composer's)
  // or, for a chat's first message, one read from the message.
  if (preset === 'auto') {
    const auto = autoPower({ text, attachments, mode, voice })
    const pw = normalizePower(power) || auto.power
    const reason = normalizePower(power) ? POWERS[pw] : auto.reason
    const lanePref = pw <= 2 ? 'instant' : 'thinking'
    const want = prefs?.[lanePref]?.provider
    // Low power takes the fastest signed-in account; higher power the default
    // reasoner. A locked chat has only its own account in the pool.
    const order = pw <= 2 ? INSTANT_ORDER : ['codex', 'claude', 'cursor', 'opencode']
    const acct = (want && pool.find((a) => a.id === want))
      || (pw >= 3 && pool.find((a) => a.isDefault && REASONING.has(a.driver)))
      || order.map((d) => pool.find((a) => a.driver === d)).find(Boolean)
      || pool[0]
    const lane = powerLane(acct.driver, pw)
    return {
      route: pw <= 2 ? 'instant' : 'thinking', provider: acct.id, model: lane.model, cursorModel: lane.cursorModel,
      effort: lane.effort, level: pw >= 3 ? Math.min(5, pw - 1) : 0, power: pw, powerAuto: !normalizePower(power), reason,
    }
  }

  let route = preset
  let lvl = normalizeLevel(level)
  let reason = preset === 'instant' ? 'Instant' : 'Thinking'
  if (preset === 'auto') {
    // A spoken turn is a conversation: it gets the fast lane unless it is a job.
    const decision = voice && mode === 'chat' ? { think: false, level: 0, reason: 'voice' } : wantsThinking({ text, attachments, mode })
    route = decision.think ? 'thinking' : 'instant'
    lvl = decision.think ? decision.level : lvl
    reason = decision.reason
  }

  const chosen = (lane) => {
    const want = prefs?.[lane]
    if (!want?.provider) return null
    return pool.find((a) => a.id === want.provider) || null
  }

  if (route === 'thinking') {
    const pick = chosen('thinking')
    if (pick) {
      const model = prefs.thinking.model || null
      return { route, provider: pick.id, model: pick.driver === 'cursor' ? null : model, cursorModel: pick.driver === 'cursor' ? (model || 'composer-2.5[fast=false]') : null, effort: pick.driver === 'cursor' ? null : LEVEL_EFFORT[lvl], level: lvl, reason }
    }
    // The default account if it reasons, otherwise the first one that does.
    const thinker = pool.find((a) => a.isDefault && REASONING.has(a.driver)) || pool.find((a) => REASONING.has(a.driver))
    if (thinker) {
      return { route, provider: thinker.id, model: null, cursorModel: null, effort: LEVEL_EFFORT[lvl], level: lvl, reason }
    }
    // Nothing that takes a reasoning level is signed in: Cursor at full quality.
    const cursor = pool.find((a) => a.driver === 'cursor')
    if (cursor) return { route, provider: cursor.id, model: null, cursorModel: 'composer-2.5[fast=false]', effort: null, level: lvl, reason }
    return { route, provider: pool[0].id, model: null, cursorModel: null, effort: null, level: lvl, reason }
  }

  const fast = chosen('instant')
  if (fast) {
    const model = prefs.instant.model || null
    return { route: 'instant', provider: fast.id, model: fast.driver === 'cursor' ? null : model, cursorModel: fast.driver === 'cursor' ? (model || 'composer-2.5[fast=true]') : null, effort: fast.driver === 'cursor' ? null : (prefs.instant.effort || null), level: 0, reason }
  }
  for (const driver of INSTANT_ORDER) {
    const a = pool.find((x) => x.driver === driver)
    if (!a) continue
    const lane = INSTANT[driver]
    return { route: 'instant', provider: a.id, model: lane.model || null, cursorModel: lane.cursorModel || null, effort: lane.effort, level: 0, reason }
  }
  return { route: 'instant', provider: pool[0].id, model: null, cursorModel: null, effort: null, level: 0, reason }
}
