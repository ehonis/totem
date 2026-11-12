// Checks that make an approval mean what the owner read.
//
// 1. Hidden characters. Unicode direction controls (the "Trojan Source" set) make
//    text display in a different order from the one it is sent or run in; tag
//    characters, zero-width characters, soft hyphens and stray variation
//    selectors are invisible text a model reads and a person does not. A proposal
//    carrying one is refused: what the owner approves has to be what he saw. The
//    exceptions are where they are ordinary writing: direction marks and ZWNJ in
//    right-to-left text, joiners and presentation selectors inside an emoji, and
//    the tags of the three recommended subdivision flags (England, Scotland,
//    Wales). Everything else in \p{Cf}, and the blanks that are not, is refused.
// 2. Fingerprints. A proposal's kind, destination and payload hashed together, so
//    the same proposal staged again is recognisable whatever its id or title.
// 3. Denials. The owner's "no" to a fingerprint is remembered for seven days; the
//    same proposal staged again inside that window is held, pointing at the
//    earlier denial, instead of asking him again.
//
// Borrowed ideas, not code: bidi refusal and the denial memory follow
// github.com/mattabate/life-distributable (MIT, (c) Matt Abate).

import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DENIAL_HOLD_MS = 7 * 24 * 60 * 60 * 1000
const MAX_DENIALS = 500

// Right-to-left scripts. Direction marks (and the zero-width non-joiner Persian
// spells with) are ordinary inside them, so they are allowed there and refused
// in text with no right-to-left letters, where they can only be steering.
const RTL_SCRIPT = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u
// Every invisible formatting character, whatever block it is in.
const FORMAT = /\p{Cf}/u
// Characters that draw as nothing but are not \p{Cf}: Hangul fillers, the
// combining grapheme joiner, and the line and paragraph separators.
const BLANK = new Set([0x115f, 0x1160, 0x3164, 0xffa0, 0x034f, 0x2028, 0x2029])
// The subdivision flags Unicode recommends (RGI): England, Scotland, Wales. Any
// other run of tags after 🏴 is just invisible text, however it is wrapped.
const RGI_FLAG_TAGS = new Set(['gbeng', 'gbsct', 'gbwls'])
const TAG_CANCEL = 0xe007f
const EMOJI = /\p{Emoji}/u
const is = (re, cp) => cp !== undefined && re.test(String.fromCodePoint(cp))

const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`

// The emoji a joiner binds to on its left, past any presentation selector or skin tone.
function baseBefore(cps, i) {
  let k = i - 1
  while (k >= 0 && (cps[k] === 0xfe0f || (cps[k] >= 0x1f3fb && cps[k] <= 0x1f3ff))) k--
  return cps[k]
}

/** Why one code point is hidden in this position, or null when it is not. */
function hiddenAt(cps, i, rtl) {
  const cp = cps[i]
  if (cp >= 0x202a && cp <= 0x202e) return 'a bidirectional embedding or override'
  if (cp >= 0x2066 && cp <= 0x2069) return 'a bidirectional isolate'
  if (cp === 0x061c || cp === 0x200e || cp === 0x200f) return rtl ? null : 'a direction mark in text with no right-to-left script'
  if (cp === 0x200c) return rtl ? null : 'a zero-width non-joiner'
  if (cp === 0x200b) return 'a zero-width space'
  // Inside an emoji sequence (👨‍👩‍👧, 🏳️‍🌈) a joiner is how the emoji is spelled.
  if (cp === 0x200d) return is(PICTOGRAPHIC, baseBefore(cps, i)) && is(PICTOGRAPHIC, cps[i + 1]) ? null : 'a zero-width joiner outside an emoji'
  if (cp >= 0x2060 && cp <= 0x2064) return 'an invisible joiner or operator'
  if (cp === 0xfeff) return 'a zero-width no-break space'
  if (cp === 0x00ad) return 'a soft hyphen'
  // Text or emoji presentation (❤️, 1️⃣) right after a character that has one.
  if (cp === 0xfe0e || cp === 0xfe0f) return i > 0 && is(EMOJI, cps[i - 1]) ? null : 'a variation selector'
  if ((cp >= 0xfe00 && cp <= 0xfe0d) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 'a variation selector'
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'an invisible tag character'
  if (cp >= 0xfff9 && cp <= 0xfffb) return 'an interlinear annotation character'
  if (cp >= 0x1d173 && cp <= 0x1d17a) return 'an invisible musical formatting character'
  if (cp === 0x180e) return 'a Mongolian vowel separator'
  if (BLANK.has(cp)) return 'a character that draws as nothing'
  if (is(FORMAT, cp)) return 'an invisible formatting character'
  return null
}

/** The end index of a recommended subdivision flag starting at i (🏴 + gbeng/gbsct/gbwls + cancel), or -1. */
function flagEnd(cps, i) {
  if (cps[i] !== 0x1f3f4) return -1
  let tags = ''
  let j = i + 1
  while (j < cps.length && j <= i + 6 && cps[j] >= 0xe0061 && cps[j] <= 0xe007a) tags += String.fromCodePoint(cps[j++] - 0xe0000)
  return cps[j] === TAG_CANCEL && RGI_FLAG_TAGS.has(tags) ? j : -1
}

/** The first hidden character in `text`, as { codePoint, name }, or null. */
export function findHiddenControl(text) {
  const value = String(text ?? '')
  const cps = [...value].map((ch) => ch.codePointAt(0))
  // The marks themselves do not count as right-to-left text (U+061C is in the Arabic block).
  const rtl = RTL_SCRIPT.test(value.replace(/[\u061c\u200c\u200e\u200f]/g, ''))
  for (let i = 0; i < cps.length; i++) {
    // A recommended subdivision flag is the one place tags belong.
    const end = flagEnd(cps, i)
    if (end !== -1) { i = end; continue }
    const name = hiddenAt(cps, i, rtl)
    if (name) return { codePoint: hex(cps[i]), name }
  }
  return null
}

/**
 * Why this payload must be refused, as a sentence for the card and the agent,
 * or null. `parts` is every string the proposal would send, run or show.
 */
export function hiddenControlReason(parts) {
  for (const part of [parts].flat(Infinity)) {
    const found = findHiddenControl(part)
    if (found) {
      return `It contains ${found.name} (${found.codePoint}), an invisible character that can make text read differently from what is sent or run. Stage it again without it.`
    }
  }
  return null
}

// Whitespace is not a difference: one more space in a body is the same email.
const canon = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** sha256 over kind, destination and payload. Stable across ids, titles, whitespace and restaging. */
export function proposalFingerprint({ kind, destination = '', payload = [] }) {
  const h = createHash('sha256')
  for (const part of [canon(kind).toLowerCase(), canon([destination].flat(Infinity).join(' ')).toLowerCase(), ...[payload].flat(Infinity).map(canon)]) {
    h.update(part)
    h.update('\u0000')
  }
  return h.digest('hex')
}

/**
 * The owner's recent denials, by fingerprint, and the held proposals he chose to
 * see anyway. One small JSON file; every write goes through one queue.
 */
export function createDenialLedger({ file, now = () => Date.now(), holdMs = DENIAL_HOLD_MS }) {
  if (!file) throw new Error('createDenialLedger needs a file')
  let queue = Promise.resolve()
  let cache = null

  function withLock(fn) {
    const next = queue.then(fn)
    queue = next.then(() => {}, () => {})
    return next
  }

  async function readAll() {
    if (cache) return cache
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      cache = {
        denials: Array.isArray(parsed?.denials) ? parsed.denials : [],
        released: Array.isArray(parsed?.released) ? parsed.released : [],
      }
    } catch {
      cache = { denials: [], released: [] }
    }
    return cache
  }

  async function writeAll(state) {
    const cutoff = now() - holdMs
    const next = {
      denials: state.denials.filter((d) => Date.parse(d.deniedAt) > cutoff).slice(-MAX_DENIALS),
      released: state.released.slice(-MAX_DENIALS),
    }
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n')
    await rename(tmp, file)
    cache = next
  }

  /** Remember a denial. */
  function record({ fingerprint, id, kind, title }) {
    if (!fingerprint) return Promise.resolve()
    return withLock(async () => {
      const state = await readAll()
      await writeAll({ ...state, denials: [...state.denials, { fingerprint, id, kind, title: String(title || '').slice(0, 200), deniedAt: new Date(now()).toISOString() }] })
    })
  }

  /**
   * The denial holding this proposal, or null: the latest denial of the same
   * fingerprint inside the window, made of a different proposal, unless the owner
   * released this one.
   */
  async function holdFor({ fingerprint, id }) {
    if (!fingerprint) return null
    const state = await readAll()
    if (state.released.includes(id)) return null
    const cutoff = now() - holdMs
    const match = state.denials
      .filter((d) => d.fingerprint === fingerprint && d.id !== id && Date.parse(d.deniedAt) > cutoff)
      .at(-1)
    return match ? { id: match.id, deniedAt: match.deniedAt, title: match.title } : null
  }

  /** The owner wants to decide a held proposal after all. */
  function release(id) {
    return withLock(async () => {
      const state = await readAll()
      if (!state.released.includes(id)) await writeAll({ ...state, released: [...state.released, id] })
    })
  }

  return { file, record, holdFor, release }
}
