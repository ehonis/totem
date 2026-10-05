// totems/core.mjs — what makes a scheduled job a totem.
//
// A totem is a job (jobs/store.mjs) that keeps living between runs: it has a
// memory file it maintains itself, a chat thread the owner talks to it in, and
// it decides on each run whether anything is worth a notification. Every job is
// a totem; the ones that run a code runner or a skill (the WHOOP sync, the daily
// brief) keep doing exactly what they did, and gain the chat and the history.
// An "agent totem" — an inline prompt, which is what the builder makes — gets
// the full treatment: memory, the notify protocol, and its runs posted to its
// chat.
//
// Pure functions only, so the rules are testable without spawning an agent:
//
//   totemRunPrompt   — one scheduled run's prompt.
//   parseRunReply    — the report, plus a NOTIFY decision or QUIET.
//   totemChatBlock   — what a chat with a totem knows about it.
//   builderPrompt    — the builder's brief: draft a totem and recommend models.
//   parseBuilderReply— the builder's JSON, validated against the live catalog.
//   costTier         — a model's rough price class, for "cheapest that works".
//   totemsRule / parseProposals — how any chat proposes a change to a totem.

import { normalizeTrigger } from '../jobs/triggers.mjs'

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')

export const TASK_TYPES = ['watcher', 'researcher', 'analyst', 'writer', 'organiser', 'coach', 'coder', 'other']

// --- cost -------------------------------------------------------------------
// A rough price class from the model id, cheapest first. It does not need to be
// exact: it orders the builder's recommendations and catches an obviously
// expensive pick for a job that runs every 15 minutes.
//   1 — small/fast: Luna, Haiku, mini, nano, flash, Composer, free models
//   2 — standard: Sonnet, GPT-x, Gemini Pro, most others
//   3 — frontier: Opus, Sol, Max, Fable, o-series, "pro"/"ultra"
export function costTier(modelId = '', driver = '') {
  const id = String(modelId).toLowerCase()
  if (driver === 'opencode' && /free|:free|big-pickle|grok-code/.test(id)) return 1
  if (/(luna|haiku|mini|nano|flash|lite|small|composer|instant|spark)/.test(id)) return 1
  if (/(opus|sol\b|-sol|max\b|-max|fable|ultra|\bo\d|-pro\b|pro-|deep-?think|heavy)/.test(id)) return 3
  return 2
}

export const COST_LABEL = { 1: 'Low cost', 2: 'Medium cost', 3: 'High cost' }

// --- runs -------------------------------------------------------------------

const NOTIFY_RULES = `HOW TO END THIS RUN: finish your reply with exactly one of these as the last line:
NOTIFY: <title, under 60 characters> | <one or two sentences for the owner's phone>
QUIET
Use NOTIFY only when there is something the owner would want to be interrupted for right now (the thing you watch changed, a threshold was crossed, a deadline is close, you found what you were looking for). Use QUIET when nothing new happened, which is the normal case. Never notify twice about the same thing: your memory says what you already told him.`

/**
 * One run of an agent totem. `recentRuns` are the last few run records
 * (newest last); their previews are how the totem knows what it said lately.
 * A run its watch started carries `trigger: 'watch'` and the `event` it saw.
 */
export function totemRunPrompt({ totem, memory = '', memoryPath = '', recentRuns = [], browser = false, trigger = 'schedule', event = '' } = {}) {
  const wakes = totem.trigger ? `when something it watches changes (${totem.scheduleLabel})` : `on a schedule (${totem.scheduleLabel || 'on its schedule'})`
  const lines = [
    `You are "${totem.name}", one of the owner's totems: a standing agent that wakes ${wakes} to do one job for him, and remembers between runs.`,
    `YOUR JOB (written for you by the owner; follow it):\n${String(totem.prompt || totem.description || '').trim()}`,
  ]
  if (trigger === 'watch' && event) {
    lines.push(`WHAT WOKE YOU: your watch saw a change. This is why you are running now; act on it.\n${String(event).trim()}`)
  } else if (trigger === 'manual') {
    lines.push(totem.trigger
      ? 'WHAT WOKE YOU: the owner started this run by hand, not a change. Check the current state and do your job as if it had just changed.'
      : 'WHAT WOKE YOU: the owner started this run by hand.')
  }
  const mem = String(memory || '').trim()
  lines.push(
    `YOUR MEMORY (${memoryPath}):\n${mem || '(empty: this is your first run)'}\n` +
    'Keep that file current with your file tools before you finish: what you checked, the last values or state you saw (so the next run can tell what changed), what you already notified him about, and anything he told you in chat. Short dated bullets; rewrite rather than endlessly append.',
  )
  const history = recentRuns.filter((r) => r && r.status !== 'running').slice(-5)
  if (history.length) {
    lines.push(`YOUR LAST RUNS (oldest first):\n${history.map((r) => `- ${new Date(r.startedAt).toISOString()} ${r.status}${r.preview ? `: ${String(r.preview).replace(/\s+/g, ' ').slice(0, 240)}` : ''}${r.error ? ` (error: ${String(r.error).slice(0, 160)})` : ''}`).join('\n')}`)
  }
  lines.push(browser
    ? 'WEB: You may use the headless browser tools for pages that need JavaScript, as well as plain fetches and web search.'
    : 'WEB: Use web search and plain page fetches for anything online. There is no browser in this run.')
  lines.push('Work on your own: nobody is watching this run, so never ask a question. If you are blocked, say what is missing in the report and NOTIFY him once.')
  lines.push('Write a short report of what you did and found (a few lines, plain text), then the closing line.')
  lines.push(NOTIFY_RULES)
  return lines.join('\n\n')
}

/** Split a run's reply into the report and the notify decision. */
export function parseRunReply(text) {
  const raw = String(text || '').trim()
  const lines = raw.split('\n')
  let notify = null
  let quiet = false
  // The decision is the last non-empty line; tolerate Markdown around it.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^[\s*_`>-]+|[\s*_`]+$/g, '')
    if (!line) continue
    const m = /^NOTIFY:\s*(.+)$/i.exec(line)
    if (m) {
      const [title, ...rest] = m[1].split('|')
      notify = { title: title.trim().slice(0, 80) || 'Totem update', body: rest.join('|').trim().slice(0, 400) }
      lines.splice(i, 1)
    } else if (/^QUIET\.?$/i.test(line)) {
      quiet = true
      lines.splice(i, 1)
    }
    break
  }
  return { report: lines.join('\n').trim(), notify, quiet }
}

// --- chat with a totem ----------------------------------------------------------

export function totemChatBlock({ totem, memory = '', memoryPath = '', recentRuns = [] } = {}) {
  const runs = recentRuns.filter((r) => r && r.status !== 'running').slice(-5)
  return [
    `TOTEM: This chat is the owner talking to his totem "${totem.name}" (id ${totem.id}). You are that totem: answer as it, from what it knows.`,
    `Its job: ${String(totem.prompt || totem.description || '').trim() || '(no instructions yet)'}`,
    `Schedule: ${totem.scheduleLabel || 'not scheduled'}${totem.enabled ? '' : ' (paused)'}.`,
    `Its memory (${memoryPath}):\n${String(memory || '').trim() || '(empty)'}`,
    runs.length ? `Its last runs:\n${runs.map((r) => `- ${new Date(r.startedAt).toISOString()} ${r.status}${r.preview ? `: ${String(r.preview).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`).join('\n')}` : 'It has not run yet.',
    'When he tells you something to keep in mind (another item to watch, a preference, a correction), write it into that memory file with your file tools and say so in a sentence. To change the job itself or its schedule, propose it as described under TOTEMS below instead of only describing it.',
  ].join('\n\n') + '\n\n'
}

// --- proposals from any chat ---------------------------------------------------

const PROPOSAL_FENCE = /```totem-proposal\s*\n([\s\S]*?)```/g

/**
 * The rule every web chat carries when the owner has totems: how to offer a
 * change. The bridge turns the fenced block into a card with Accept.
 */
export function totemsRule(totems) {
  const list = (totems || []).filter((t) => t && t.id).slice(0, 40)
  if (!list.length) return ''
  const rows = list.map((t) => `- ${t.id}: ${t.name}${t.description ? ` (${String(t.description).slice(0, 100)})` : ''}`).join('\n')
  return `TOTEMS: The owner has standing agents ("totems") that run on schedules:\n${rows}\n` +
    'When something in this chat belongs in one of them (he says to add to it, or mentions something a totem plainly should track), offer the change: put a block like this at the very end of your reply, one block per totem, and also say in a sentence what you are proposing:\n' +
    '```totem-proposal\n{"totemId": "<id from the list>", "summary": "<one line he will see on the card>", "memoryNote": "<a line to add to its memory, optional>", "instructions": "<the full new instructions, only if the job itself changes>"}\n```\n' +
    'Only propose; never claim the totem was changed. Do not propose anything he did not mention or clearly imply.'
}

/** Pull proposal blocks out of a reply. Returns the cleaned text and the proposals. */
export function parseProposals(text, knownIds = null) {
  const proposals = []
  const cleaned = String(text || '').replace(PROPOSAL_FENCE, (_, body) => {
    try {
      const p = JSON.parse(body.trim())
      const totemId = str(p.totemId, 64)
      if (!totemId || (knownIds && !knownIds.has(totemId))) return ''
      const out = { totemId, summary: str(p.summary, 200).trim() || 'Update this totem' }
      const note = str(p.memoryNote, 1000).trim()
      const instructions = str(p.instructions, 8000).trim()
      if (note) out.memoryNote = note
      if (instructions) out.instructions = instructions
      if (out.memoryNote || out.instructions) proposals.push(out)
    } catch { /* a malformed block is dropped, not shown raw */ }
    return ''
  })
  return { text: cleaned.replace(/\n{3,}/g, '\n\n').trim(), proposals }
}

/** Append a dated note to a memory file's text. */
export function appendMemoryNote(memory, note, date = new Date()) {
  const day = date.toISOString().slice(0, 10)
  const base = String(memory || '').trimEnd()
  const heading = '## From chat'
  const line = `- ${day}: ${String(note).replace(/\s+/g, ' ').trim()}`
  if (base.includes(heading)) return `${base.replace(heading, `${heading}\n${line}`)}\n`
  return `${base}${base ? '\n\n' : ''}${heading}\n${line}\n`
}

// --- the builder -----------------------------------------------------------------

/**
 * `catalog` is [{provider, driver, name, models: [{id, name}]}] for every enabled
 * account. The builder must pick models from it, so a recommendation can always run.
 */
export function builderPrompt({ description, catalog = [], timezone = 'UTC' }) {
  const accounts = catalog.map((a) => {
    const models = (a.models || []).slice(0, 25).map((m) => `${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ''} [cost ${costTier(m.id, a.driver)}]`)
    return `- account "${a.provider}" (${a.name}, ${a.driver}): ${models.length ? models.join(', ') : '(its default model only; use model "")'}`
  }).join('\n')
  return `You design "totems": standing AI agents that wake on a schedule to do one job for the owner, keep their own memory between runs, and notify his phone only when something matters. He described the totem he wants below. Design it.

Choose:
- name: 2-4 words, Title Case.
- summary: one line under 90 characters saying what it does for him, in plain words ("Tells you when the jacket is back in stock").
- icon: one Tabler icon name (e.g. eye, chart-line, file-text, shopping-cart, bell, news, briefcase, heartbeat, search).
- taskType: one of ${TASK_TYPES.join(', ')}.
- instructions: the totem's standing brief in second person ("You watch…"), specific and complete: what to check, where, what counts as worth telling him, and what to keep in memory so the next run can tell what changed. 4-12 sentences.
- schedule: one of {"type":"interval","everyMinutes":N} (N ≥ 15), {"type":"daily","time":"HH:MM"}, {"type":"weekly","time":"HH:MM","days":[0-6, Sunday=0]}, {"type":"window","from":"HH:MM","to":"HH:MM","everyMinutes":N,"days":[...]}. Times are ${timezone}. Pick the least frequent schedule that still does the job: a stock watch every 30-60 minutes, a daily digest once a day.
- trigger: null, or a watch when the job is "when X changes, do Y" and X is a git branch or one web page. A watch is checked without AI every few minutes and wakes the totem only when the thing changes, which is far cheaper than polling with a model. {"type":"watch","everyMinutes":N,"source":{"kind":"git","repo":"<absolute checkout path or https/ssh remote URL>","ref":"<branch>"}} (a local checkout watches its origin remote; N ≥ 1), or {"type":"watch","everyMinutes":N,"source":{"kind":"url","url":"https://…","contains":"<text whose appearance or disappearance matters, optional>"}} (N ≥ 5). With a trigger, schedule is ignored. Use the paths and URLs he gave; never invent one (leave trigger null and ask in questions instead). If he wants Totem itself redeployed when its main branch changes, do not design an agent for it: the built-in "Deploy Totem" totem does that (an agent restarting Totem would cut off its own run); say so in questions.
- browser: true only if the job needs pages that load with JavaScript (store pages, dashboards); plain fetches and web search cover most things.
- notify: "agent" (the totem decides when to notify; right for watchers), "always" (every run sends its report; right for digests), or "errors".
- recommendations: 2-4 model choices from the accounts below, cheapest first, that can do THIS job well. The goal is the lowest cost that still gets it right: a simple check or a short digest needs a small fast model; deep analysis or long writing needs a stronger one. For each: {"provider": account id, "model": model id exactly as listed (or "" for the account default), "effort": "low"|"medium"|"high"|"", "why": one short sentence}.
- questions: anything genuinely ambiguous that he should answer (at most 2), else [].

Accounts and models:
${accounts || '(none listed: use provider "default" and model "")'}

Reply with only a JSON object with exactly those keys, no prose and no code fence.

His description:
${String(description || '').slice(0, 4000)}`
}

function extractJson(text) {
  const raw = String(text || '').trim()
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(raw)
  const body = fenced ? fenced[1] : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  return JSON.parse(body)
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function cleanSchedule(s) {
  if (!s || typeof s !== 'object') return { type: 'daily', time: '09:00' }
  const every = Math.max(15, Math.min(24 * 60, Math.round(Number(s.everyMinutes) || 60)))
  const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => d >= 0 && d <= 6))] : undefined
  if (s.type === 'interval') return { type: 'interval', everyMinutes: every }
  if (s.type === 'weekly' && HHMM.test(s.time)) return { type: 'weekly', time: s.time, days: days?.length ? days : [1] }
  if (s.type === 'window' && HHMM.test(s.from) && HHMM.test(s.to)) return { type: 'window', from: s.from, to: s.to, everyMinutes: every, ...(days?.length ? { days } : {}) }
  return { type: 'daily', time: HHMM.test(s.time) ? s.time : '09:00' }
}

/**
 * The builder's reply, made safe to create: unknown accounts and models are
 * dropped, the schedule is clamped (never more often than every 15 minutes), and
 * recommendations are re-sorted cheapest first. A reply with no usable
 * recommendation gets one from the cheapest model in the catalog.
 */
export function parseBuilderReply(text, { catalog = [], description = '' } = {}) {
  const j = extractJson(text)
  const accounts = new Map(catalog.map((a) => [a.provider, a]))
  const recs = []
  for (const r of Array.isArray(j.recommendations) ? j.recommendations : []) {
    const account = accounts.get(r?.provider)
    if (!account) continue
    const model = str(r.model, 120)
    const listed = !model || !(account.models || []).length || account.models.some((m) => m.id === model)
    if (!listed) continue
    const label = model ? ((account.models || []).find((m) => m.id === model)?.name || model) : `${account.name} default`
    if (recs.some((x) => x.provider === account.provider && x.model === model)) continue
    recs.push({
      provider: account.provider, model, effort: ['low', 'medium', 'high'].includes(r.effort) ? r.effort : '',
      label, account: account.name, driver: account.driver, cost: costTier(model, account.driver), why: str(r.why, 240),
    })
  }
  if (!recs.length) {
    const cheapest = catalog.flatMap((a) => (a.models || []).map((m) => ({ a, m }))).sort((x, y) => costTier(x.m.id, x.a.driver) - costTier(y.m.id, y.a.driver))[0]
    if (cheapest) recs.push({ provider: cheapest.a.provider, model: cheapest.m.id, effort: 'low', label: cheapest.m.name || cheapest.m.id, account: cheapest.a.name, driver: cheapest.a.driver, cost: costTier(cheapest.m.id, cheapest.a.driver), why: 'The lowest-cost model available.' })
  }
  // Stable: the builder's own order breaks ties within a price class.
  recs.sort((a, b) => a.cost - b.cost)
  const notify = ['agent', 'always', 'errors'].includes(j.notify) ? j.notify : 'agent'
  return {
    name: str(j.name, 80).trim() || 'New Totem',
    summary: str(j.summary, 120).trim(),
    icon: /^[a-z0-9-]{1,40}$/.test(j.icon) ? j.icon : 'sparkles',
    taskType: TASK_TYPES.includes(j.taskType) ? j.taskType : 'other',
    instructions: str(j.instructions, 8000).trim() || String(description).trim(),
    schedule: cleanSchedule(j.schedule),
    trigger: normalizeTrigger(j.trigger),
    browser: j.browser === true,
    notify,
    recommendations: recs.slice(0, 4),
    questions: (Array.isArray(j.questions) ? j.questions : []).map((q) => str(q, 300)).filter(Boolean).slice(0, 2),
  }
}
