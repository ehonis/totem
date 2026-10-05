// chat/voice.mjs — ChatGPT-grade voice: OpenAI's Realtime API, wired to Totem.
//
// The local voice mode (whisper.cpp + the browser's speech synthesis + an agent
// CLI per turn) costs nothing and works offline, but it is turn-based: talk,
// wait for the pause detector, wait for transcription, wait for a CLI to start,
// listen. ChatGPT's voice feels different because the model hears and speaks
// audio itself, streams both ways and lets you cut in. That is the Realtime API.
//
// The browser holds the WebRTC call (mic in, voice out) with a short-lived key
// minted here, so the API key never leaves the box. What makes it Totem rather
// than a chatbot is the tools: the session is given every `totem_*` MCP tool as
// a function (tasks, calendar, habits, goals, lists, Strava, memory search…),
// plus `ask_totem_agent`, which hands a request to the full agent CLI with its
// shell, GitHub, Plaud and everything else in the gateway. The model calls a
// function; the browser relays it to POST /api/voice/tool; the bridge runs it
// in-process — the same handler the inbound MCP server uses — and the answer
// goes back to the model, which speaks it.
//
// Cost (July 2026 list prices, gpt-realtime-2.1-mini): $10 / 1M audio-in tokens,
// $20 / 1M audio-out, $0.60 / $2.40 text. Roughly 600 tokens per minute heard and
// 1,200 per minute spoken, so a few cents per conversation. Every response's
// `usage` is recorded and summed per day so the Voice settings can show it.

import { appendFile, readFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const PRICES = {
  // $ per 1M tokens: [audio in, cached audio in, audio out, text in, cached text in, text out]
  'gpt-realtime-2.1-mini': [10, 0.3, 20, 0.6, 0.06, 2.4],
  'gpt-realtime-mini': [10, 0.3, 20, 0.6, 0.06, 2.4],
  'gpt-realtime-2.1': [32, 0.4, 64, 4, 0.4, 16],
  'gpt-realtime': [32, 0.4, 64, 4, 0.4, 16],
}

export function estimateCost(model, usage = {}) {
  const p = PRICES[model] || PRICES['gpt-realtime-2.1-mini']
  const inDetails = usage.input_token_details || {}
  const outDetails = usage.output_token_details || {}
  const cached = inDetails.cached_tokens_details || {}
  const audioIn = Number(inDetails.audio_tokens) || 0
  const textIn = Number(inDetails.text_tokens) || 0
  const cachedAudio = Number(cached.audio_tokens) || 0
  const cachedText = Number(cached.text_tokens) || 0
  const audioOut = Number(outDetails.audio_tokens) || 0
  const textOut = Number(outDetails.text_tokens) || 0
  return (
    (Math.max(0, audioIn - cachedAudio) * p[0] + cachedAudio * p[1] + audioOut * p[2] +
     Math.max(0, textIn - cachedText) * p[3] + cachedText * p[4] + textOut * p[5]) / 1e6
  )
}

const VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']

/** A tool description short enough that 40 of them don't dominate every turn. */
function shortDescription(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= 420) return t
  const cut = t.slice(0, 420)
  return `${cut.slice(0, Math.max(cut.lastIndexOf('. '), 200) + 1)}`
}

const VOICE_SKIP = /^totem_(get_repos|get_usage|get_status|list_models|pick_provider|queue_prompt|propose_command|request_approval|check_approval|resolve_inbox|read_logs|get_output|list_connections|call_connection|link_goal|unlink_goal|delete_goal_metric|link_list_todo|unlink_list_todo|strava_get_athlete|strava_get_routes|strava_get_segments|strava_get_clubs|strava_update_athlete)$|approval|lease/

// The Realtime API wants every function's parameters to be a plain object
// schema: no oneOf/anyOf/allOf/enum/const/not at the top level. One tool that
// breaks the rule makes it reject the whole session.update — instructions and all
// — so MCP schemas are flattened here: the branches' properties are merged and
// only what every branch requires stays required.
const TOP_LEVEL_FORBIDDEN = ['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not']
export function toRealtimeParameters(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} }
  const out = { ...schema, type: 'object', properties: { ...(schema.properties || {}) } }
  const branches = [...(schema.oneOf || []), ...(schema.anyOf || []), ...(schema.allOf || [])].filter((b) => b && typeof b === 'object')
  let required = Array.isArray(schema.required) ? [...schema.required] : []
  if (branches.length) {
    const reqSets = []
    for (const b of branches) {
      Object.assign(out.properties, b.properties || {})
      reqSets.push(new Set(Array.isArray(b.required) ? b.required : []))
    }
    const always = (schema.allOf?.length ? [...reqSets].flatMap((r) => [...r]) : [...(reqSets[0] || [])].filter((k) => reqSets.every((r) => r.has(k))))
    required = [...new Set([...required, ...always])]
  }
  for (const k of TOP_LEVEL_FORBIDDEN) delete out[k]
  if (required.length) out.required = required.filter((k) => k in out.properties)
  else delete out.required
  return out
}

export function realtimeTools(descriptors) {
  const tools = []
  for (const d of descriptors) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(d.name)) continue
    // Spoken life admin only. The developer and remote-client tools (repos,
    // usage, logs, providers, approvals, command proposals) and the rarely-said
    // ones stay out: every schema is re-sent each turn, and 64 of them make the
    // model slower to pick. ask_totem_agent reaches everything that is left out.
    if (VOICE_SKIP.test(d.name)) continue
    tools.push({
      type: 'function',
      name: d.name,
      description: shortDescription(d.description),
      parameters: toRealtimeParameters(d.inputSchema),
    })
  }
  tools.push({
    type: 'function',
    name: 'ask_totem_agent',
    description:
      'Hand a request to Totem\'s full agent, which has a shell on the owner\'s machine, GitHub, Plaud recordings, email, '
      + 'files, the web and every connected app. Slower (often 10-60 seconds). Use it for anything the other tools cannot do: '
      + 'research, reading or writing files, GitHub issues, running commands, multi-step jobs. Pass the request in full, '
      + 'in the owner\'s words plus any detail from the conversation it needs.',
    parameters: {
      type: 'object',
      properties: { request: { type: 'string', description: 'What to do, self-contained.' } },
      required: ['request'],
      additionalProperties: false,
    },
  })
  return tools
}

// Who the voice is talking to: OWNER_NAME, as in the agent persona (bridge.mjs).
const OWNER = String(process.env.OWNER_NAME || '').trim()

export const VOICE_INSTRUCTIONS = (
  `You are Totem, ${OWNER ? `${OWNER}'s` : "the owner's"} personal assistant, talking with ${OWNER || 'them'} out loud. `
  + 'Sound like a sharp, warm friend, not a call '
  + 'centre: short spoken sentences, contractions, no lists or Markdown, never read out URLs or ids. Usually one to three '
  + 'sentences; go longer only when asked. You can hear them interrupt; if they do, stop and listen.\n\n'
  + 'You can act, not just talk. Use the totem_* functions for their tasks, calendar, habits, goals, lists, notes, memory '
  + 'and Strava. For anything they cannot do — GitHub, Plaud recordings, files, the web, running something on their machine, '
  + 'or a multi-step job — call ask_totem_agent with the full request. Before any function that may take more than a '
  + 'moment, say a few natural words first ("one sec, checking your calendar"), then call it. Never invent their data; if a '
  + 'tool fails, say so plainly. Confirm before anything irreversible (deleting, sending, buying). Dates: use the table '
  + 'below, and pass ISO dates (YYYY-MM-DD) to functions.'
)

export function createVoiceService({ apiKey, model, voice, usageFile, log = () => {}, fetchImpl = fetch }) {
  const configured = () => Boolean(apiKey())

  async function mint() {
    const r = await fetchImpl('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey()}`, 'content-type': 'application/json' },
      // Minimal on purpose: the documented shape. Everything else (instructions,
      // tools, transcription, turn detection) goes in a session.update over the
      // data channel, where a field the API dislikes produces an error event
      // instead of a call that never connects.
      body: JSON.stringify({ session: { type: 'realtime', model: model(), audio: { output: { voice: voice() } } } }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) {
      const msg = body?.error?.message || `OpenAI answered ${r.status}`
      throw Object.assign(new Error(`Couldn't start a voice session: ${msg}`), { status: 502 })
    }
    return { value: body.value || body.client_secret?.value, expiresAt: body.expires_at || body.client_secret?.expires_at || null }
  }

  async function recordUsage({ threadId, usage, model: m }) {
    if (!usage || !usageFile) return 0
    const cost = estimateCost(m || model(), usage)
    await mkdir(dirname(usageFile), { recursive: true }).catch(() => {})
    await appendFile(usageFile, `${JSON.stringify({ ts: Date.now(), threadId: threadId || null, model: m || model(), cost, usage })}\n`).catch((e) => log('voice usage write failed', e?.message || e))
    return cost
  }

  async function spend() {
    let raw = ''
    try { raw = await readFile(usageFile, 'utf8') } catch { return { today: 0, month: 0 } }
    const now = new Date()
    const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    let today = 0, month = 0
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line)
        if (e.ts >= startMonth) month += Number(e.cost) || 0
        if (e.ts >= startDay) today += Number(e.cost) || 0
      } catch {}
    }
    return { today, month }
  }

  return { configured, mint, recordUsage, spend, voices: VOICES }
}
