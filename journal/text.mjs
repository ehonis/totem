// journal/text.mjs — pure helpers for turning a transcript into a page and an
// agent's reply into a record. No I/O, so every branch is unit-testable.

/** 'YYYY-MM-DD' of an instant in a timezone. */
export function localDate(ts, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ts))
  const get = (t) => parts.find((p) => p.type === t)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** 'HH:MM EDT' of an instant in a timezone. */
export function localTime(ts, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' })
    .format(new Date(ts))
    .replace(/^24:/, '00:')
}

/** 'Tuesday, September 16, 2026' for a 'YYYY-MM-DD'. */
export function longDate(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

/** The 'YYYY-MM-DD' before a 'YYYY-MM-DD'. */
export function previousDate(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) - 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * Break a transcript into paragraphs.
 *
 * whisper hands back ~30-second segments; a journal read as one wall of text is
 * unreadable and an agent skims it the same way a person does. A pause longer than
 * `gapSec` between segments is a paragraph break, and so is running past ~700
 * characters — whichever comes first. Without segments (a typed entry, an edited
 * transcript) the text is split on sentence ends into similar-sized runs.
 */
export function paragraphs({ text, segments = [] }, { gapSec = 1.6, maxChars = 700 } = {}) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  if (segments?.length > 1) {
    const out = []
    let current = ''
    let lastEnd = null
    for (const seg of segments) {
      const t = clean(seg.text)
      if (!t) continue
      const gap = lastEnd == null ? 0 : Number(seg.start) - lastEnd
      const endsSentence = /[.!?]["')]?$/.test(current)
      if (current && ((gap > gapSec && endsSentence) || current.length + t.length > maxChars && endsSentence)) {
        out.push(current)
        current = t
      } else {
        current = current ? `${current} ${t}` : t
      }
      lastEnd = Number(seg.end)
    }
    if (current) out.push(current)
    return out
  }
  const whole = clean(text)
  if (!whole) return []
  // A sentence ends at punctuation followed by whitespace (or the end), so
  // "whisper.cpp" and "3.5" are not split in half.
  const sentences = whole.split(/(?<=[.!?]["')]?)\s+/)
  const out = []
  let current = ''
  for (const raw of sentences) {
    const s = raw.trim()
    if (!s) continue
    if (current && current.length + s.length > maxChars) { out.push(current); current = s }
    else current = current ? `${current} ${s}` : s
  }
  if (current) out.push(current)
  return out
}

/** Duration as "4 min" / "45 s" / "1 h 12 min". */
export function describeDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

/**
 * The block appended to the brain's journal page for one entry:
 * a timestamped heading, then the transcript in paragraphs.
 */
export function journalBlock({ recordedAt, timeZone, source, durationSec, text, segments, title }) {
  const head = [
    `## ${localTime(recordedAt, timeZone)}`,
    source === 'text' ? 'typed' : 'voice',
    durationSec ? describeDuration(durationSec) : null,
    title ? `— ${title}` : null,
  ].filter(Boolean).join(' · ')
  return `${head}\n\n${paragraphs({ text, segments }).join('\n\n')}\n`
}

/**
 * Did the agent actually answer?
 *
 * The backends do not throw when a run is killed or comes back empty — cursor in
 * particular answers a SIGKILLed run with a sentence of prose. Left alone that
 * reads as a perfectly good digest: the entry went green, the card said
 * "Digested", and nothing whatsoever had been filed. This is the guard, and it is
 * deliberately a *whitelist of known non-answers* rather than "did it contain
 * JOURNAL_RESULT" — a digest that did the work and forgot the marker is still a
 * digest, and is recorded as one with `parsed: false`.
 *
 * Returns a reason to fail with, or null when the reply is a real answer.
 */
export function ingestFailure(reply) {
  const text = String(reply ?? '').trim()
  if (!text) return 'the agent returned nothing at all'
  if (/^agent timed out after (\d+) seconds?/i.test(text) || /\btimed out after \d+s? without answering/i.test(text)) {
    const seconds = text.match(/(\d+)\s*s(?:econds?)?\b/)?.[1]
    return `the digest ran out of time${seconds ? ` after ${seconds}s` : ''} — the entry is long, so give it a bigger budget (JOURNAL_INGEST_TIMEOUT_MS) and retry`
  }
  if (/^agent finished without a final response/i.test(text)) return 'the agent finished without saying anything, so nothing was filed'
  if (/^stopped the running request/i.test(text)) return 'the run was stopped before it finished'
  if (text === '(no output)') return 'the agent produced no output'
  return null
}

const RESULT_MARK = /JOURNAL_RESULT\s*:/g

const asStrings = (v, max = 40, len = 200) =>
  (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, len))

/**
 * Pull the structured summary out of the ingest agent's reply.
 *
 * The skill is told to end with `JOURNAL_RESULT: {...json...}`. The rest of the
 * reply is prose and may itself contain braces, so the JSON is found by balanced
 * brace matching from the last marker rather than by a regex. A reply with no
 * marker still produces a record — `parsed:false`, summary from the prose — because
 * the ingest *did* run and the entry must say so; it just can't count what changed.
 */
export function parseIngestResult(reply) {
  const text = String(reply ?? '')
  let lastIdx = -1
  for (const m of text.matchAll(RESULT_MARK)) lastIdx = m.index + m[0].length
  const fallback = {
    parsed: false,
    title: null,
    summary: text.replace(/\s+/g, ' ').trim().slice(0, 400) || null,
    memory: [], proposals: [], habits: [], goals: [], calendar: [], todos: [],
    mood: null,
  }
  if (lastIdx === -1) return fallback
  const start = text.indexOf('{', lastIdx)
  if (start === -1) return fallback
  let depth = 0
  let end = -1
  let inString = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i += 1
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break } }
  }
  if (end === -1) return fallback
  let doc
  try { doc = JSON.parse(text.slice(start, end + 1)) } catch { return fallback }
  return {
    parsed: true,
    title: doc.title ? String(doc.title).replace(/\s+/g, ' ').trim().slice(0, 120) : null,
    summary: doc.summary ? String(doc.summary).replace(/\s+/g, ' ').trim().slice(0, 600) : fallback.summary,
    memory: asStrings(doc.memory),
    proposals: asStrings(doc.proposals, 60, 40).map((p) => p.toUpperCase()).filter((p) => /^P\d+$/.test(p)),
    habits: asStrings(doc.habits),
    goals: asStrings(doc.goals),
    calendar: asStrings(doc.calendar),
    todos: asStrings(doc.todos),
    mood: doc.mood ? String(doc.mood).trim().slice(0, 60) : null,
  }
}

/** "3 memory updates · 2 proposals in the inbox · 1 habit logged" for a push body. */
export function describeIngestResult(result) {
  if (!result) return 'Digested.'
  const parts = []
  const n = (arr, one, many) => arr?.length ? `${arr.length} ${arr.length === 1 ? one : many}` : null
  parts.push(n(result.memory, 'memory update', 'memory updates'))
  parts.push(n(result.proposals, 'proposal in the inbox', 'proposals in the inbox'))
  parts.push(n(result.habits, 'habit logged', 'habits logged'))
  const line = parts.filter(Boolean).join(' · ')
  if (line) return line
  return result.summary ? result.summary.slice(0, 160) : 'Digested — nothing new to file.'
}
