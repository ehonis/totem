// skills/format.mjs — the on-disk skill file format, and the template rendering
// that turns one into a prompt.
//
// A skill is a Markdown file with a small frontmatter block:
//
//   ---
//   name: Plaud action items ingest
//   description: Mine work and side-project meetings into inbox proposals.
//   icon: inbox
//   command: $plaud-meetings
//   requires: [plaud]
//   ---
//
//   GOAL: scan recent Plaud meetings and stage {{inboxFile}} proposals…
//
// Markdown-with-frontmatter rather than JSON is a deliberate choice: these bodies
// are 60-line prompts, and a prompt stored as an escaped JSON string is unreadable
// in a diff and near-impossible to edit outside the app. This shape is greppable,
// git-able, and editable in any text editor — including by Totem itself.
//
// The parser is intentionally tiny and does NOT depend on a YAML library. It
// handles exactly the scalar/list/boolean forms the frontmatter above uses; a key
// it can't understand is kept as a raw string rather than throwing, because a
// hand-edited skill file must never be able to crash the bridge on boot.

// Keys that carry a list of strings. Everything else is a scalar.
const LIST_KEYS = new Set(['requires', 'tags'])
const BOOL_KEYS = new Set(['enabled', 'hidden'])

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/

function stripQuotes(value) {
  const v = String(value).trim()
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

function parseList(value) {
  const v = String(value).trim()
  // Inline flow form: [a, b]. The block form (leading "- ") is handled by the
  // caller, which has the following lines.
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => stripQuotes(s)).filter(Boolean)
  }
  return v ? [stripQuotes(v)] : []
}

/**
 * Split a skill file into `{ meta, body }`.
 *
 * A file with no frontmatter is not an error — it's a body-only skill, which is
 * what you get if someone drops a bare prompt into the directory. The caller
 * fills in a name from the id in that case.
 */
export function parseSkillFile(text) {
  const raw = String(text ?? '')
  const match = raw.match(FRONTMATTER_RE)
  if (!match) return { meta: {}, body: raw.trim() }

  const meta = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    if (!key) continue
    let value = line.slice(sep + 1).trim()

    // Block list form:
    //   requires:
    //     - plaud
    if (!value && lines[i + 1]?.trim().startsWith('- ')) {
      const items = []
      while (lines[i + 1]?.trim().startsWith('- ')) {
        i += 1
        items.push(stripQuotes(lines[i].trim().slice(2)))
      }
      meta[key] = items.filter(Boolean)
      continue
    }

    if (LIST_KEYS.has(key)) meta[key] = parseList(value)
    else if (BOOL_KEYS.has(key)) meta[key] = /^(true|yes|on)$/i.test(value)
    else meta[key] = stripQuotes(value)
  }
  return { meta, body: (match[2] ?? '').trim() }
}

// Frontmatter values that would break the line-per-key parser on the way back in.
const NEEDS_QUOTING_RE = /^[\s>|&*!%@`'"[{]|:\s|\s$|^$/

function serializeValue(value) {
  const v = String(value ?? '')
  return NEEDS_QUOTING_RE.test(v) || v.includes('\n') ? JSON.stringify(v) : v
}

/** Render `{ meta, body }` back to file text. The inverse of `parseSkillFile`. */
export function serializeSkillFile(meta = {}, body = '') {
  const lines = []
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (!value.length) continue
      lines.push(`${key}: [${value.map((v) => serializeValue(v)).join(', ')}]`)
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value ? 'true' : 'false'}`)
    } else {
      lines.push(`${key}: ${serializeValue(value)}`)
    }
  }
  return `---\n${lines.join('\n')}\n---\n\n${String(body ?? '').trim()}\n`
}

// --- template rendering -------------------------------------------------------
//
// The extracted prompts were template literals, so they interpolate live values:
// the current time, a watermark, which meetings were already processed. Those
// become `{{name}}` placeholders the bridge fills at run time. Keeping them as
// named holes rather than string concatenation is what makes the prompt editable
// without the editor having to understand JavaScript.

const PLACEHOLDER_RE = /\{\{\s*([#^/]?)([a-zA-Z0-9_.-]+)\s*\}\}/g

/**
 * Fill `{{name}}` placeholders from `vars`.
 *
 * Also supports one conditional form, which the ingest prompts genuinely need
 * ("mention the watermark only if there is one, otherwise say last 24 hours"):
 *
 *   {{#since}}strictly after {{since}}{{/since}}{{^since}}in the last day{{/since}}
 *
 * `{{#x}}` keeps its block when x is a non-empty value; `{{^x}}` keeps its block
 * when x is empty or absent. That's the whole language — deliberately not a
 * general template engine, because every feature added here is one more way a
 * hand-edited prompt can break.
 *
 * An unknown placeholder renders as empty string and is reported in `missing`, so
 * a typo'd variable shows up in the UI as a warning instead of shipping the
 * literal text `{{inboxFle}}` to an agent.
 */
export function renderSkillBody(body, vars = {}) {
  const missing = new Set()
  const has = (name) => Object.prototype.hasOwnProperty.call(vars, name)
  const truthy = (name) => {
    const v = vars[name]
    return !(v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && !v.length))
  }

  // Conditional sections first, so a dropped block's inner placeholders never
  // get counted as missing.
  let text = String(body ?? '')
  let guard = 0
  for (;;) {
    const before = text
    text = text.replace(
      /\{\{([#^])\s*([a-zA-Z0-9_.-]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g,
      (_m, marker, name, inner) => ((marker === '#' ? truthy(name) : !truthy(name)) ? inner : ''),
    )
    // Nested sections need another pass; the guard stops a pathological file from
    // spinning here.
    if (text === before || (guard += 1) > 10) break
  }

  const out = text.replace(PLACEHOLDER_RE, (match, marker, name) => {
    if (marker) return '' // an unmatched {{#x}} / {{^x}} / {{/x}} — drop it, keep going
    if (!has(name)) { missing.add(name); return '' }
    const v = vars[name]
    if (v === undefined || v === null || v === false) return ''
    return Array.isArray(v) ? v.join('\n') : String(v)
  })

  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), missing: [...missing] }
}

/** Every `{{name}}` a body references, conditionals included. Used by the editor. */
export function skillVariables(body) {
  const names = new Set()
  for (const [, , name] of String(body ?? '').matchAll(PLACEHOLDER_RE)) names.add(name)
  return [...names]
}
