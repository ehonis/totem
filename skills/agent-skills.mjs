// skills/agent-skills.mjs — the owner's agent skills (Claude Code, Codex, Cursor,
// OpenCode, the shared ~/.agents folder), found on disk so chat can cite them.
//
// These are not Totem skills. Totem never edits, seeds or schedules them; it
// reads each SKILL.md so the composer can offer `/name` anywhere in a message,
// and so a message that cites one carries the skill's instructions to whichever
// agent CLI answers it. Codex and Cursor do not load Claude's skills, and none of
// them expand `/name` written mid-sentence, so the bridge inlines the text itself.
//
// The layout every one of these tools uses: <root>/<name>/SKILL.md, with
// frontmatter `name` and `description`. Claude's skills synced from claude.ai sit
// two levels deeper (skills/synced/<bucket>/<name>/SKILL.md), so the scan goes a
// few levels down and stops at the first SKILL.md on each branch.

import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import { slugify } from './store.mjs'

const MAX_DEPTH = 3
const MAX_SKILLS = 400
const MAX_BODY = 24_000
const CACHE_MS = 30_000

/**
 * Where to look, in priority order: a name found twice keeps the first. Env
 * `AGENT_SKILL_DIRS` (colon-separated) adds roots ahead of the defaults.
 */
export function defaultSkillRoots({ env = process.env, home = homedir(), cwd = '' } = {}) {
  const roots = []
  for (const dir of String(env.AGENT_SKILL_DIRS || '').split(':').map((s) => s.trim()).filter(Boolean)) {
    roots.push({ dir, source: 'Custom' })
  }
  roots.push({ dir: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills'), source: 'Claude Code' })
  roots.push({ dir: join(env.CODEX_HOME || join(home, '.codex'), 'skills'), source: 'Codex' })
  roots.push({ dir: join(home, '.agents', 'skills'), source: 'Agents' })
  roots.push({ dir: join(home, '.cursor', 'skills'), source: 'Cursor' })
  roots.push({ dir: join(home, '.config', 'opencode', 'skills'), source: 'OpenCode' })
  roots.push({ dir: join(home, '.config', 'opencode', 'skill'), source: 'OpenCode' })
  if (cwd) {
    roots.push({ dir: join(cwd, '.claude', 'skills'), source: 'Project' })
    roots.push({ dir: join(cwd, '.agents', 'skills'), source: 'Project' })
  }
  return roots
}

/**
 * `name` and `description` from a SKILL.md head. Agent skills use real YAML, so
 * unlike Totem's own format a description may be a folded (`>`) or literal (`|`)
 * block; anything fancier falls back to the folder name and no description.
 */
export function parseAgentSkill(text) {
  const raw = String(text ?? '').replace(/^﻿/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(raw)
  if (!m) return { meta: {}, body: raw.trim() }
  const meta = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    let value = kv[2].trim()
    if (/^[>|][+-]?$/.test(value)) {
      const block = []
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim())
      value = value[0] === '>' ? block.join(' ').replace(/\s+/g, ' ') : block.join('\n')
    } else if (value.length >= 2 && /^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1)
      if (kv[2].trim()[0] === '"') value = value.replace(/\\"/g, '"')
    }
    meta[kv[1]] = value.trim()
  }
  return { meta, body: (m[2] ?? '').trim() }
}

async function isDir(path) {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

async function findSkillFiles(dir, depth, out) {
  if (out.length >= MAX_SKILLS) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  if (entries.some((e) => e.name === 'SKILL.md' && !e.isDirectory())) { out.push(join(dir, 'SKILL.md')); return }
  if (depth >= MAX_DEPTH) return
  for (const e of entries) {
    // Dot folders are trash, staging and tool internals (.trash, .staging, .system).
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const child = join(dir, e.name)
    if (e.isDirectory() || (e.isSymbolicLink() && await isDir(child))) await findSkillFiles(child, depth + 1, out)
  }
}

/**
 * A catalog of agent skills: `list()` for the composer's menu, `get(slug)` for
 * the full text when a message cites one. Cached briefly; a skill added in a
 * terminal shows up within half a minute without a restart.
 */
export function createAgentSkillCatalog({ roots = defaultSkillRoots(), log = () => {} } = {}) {
  let cache = null
  let cachedAt = 0

  async function scan() {
    const seen = new Map()
    for (const { dir, source } of roots) {
      const files = []
      await findSkillFiles(dir, 0, files)
      for (const file of files) {
        try {
          const { meta, body } = parseAgentSkill(await readFile(file, 'utf8'))
          const folder = basename(dirname(file))
          const slug = slugify(meta.name || folder)
          if (!slug || seen.has(slug)) continue
          seen.set(slug, {
            id: `agent:${slug}`,
            slug,
            command: `/${slug}`,
            name: meta.name || folder,
            description: (meta.description || '').replace(/\s+/g, ' ').slice(0, 400),
            source,
            path: file,
            body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n[…cut here; read the rest from ${file}]` : body,
          })
        } catch (e) {
          log(`agent skill ${file} unreadable: ${e?.message || e}`)
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.slug.localeCompare(b.slug))
  }

  async function all() {
    if (!cache || Date.now() - cachedAt > CACHE_MS) {
      cache = await scan()
      cachedAt = Date.now()
    }
    return cache
  }

  return {
    /** Without bodies: what the composer needs. */
    async list() {
      return (await all()).map(({ body, ...rest }) => rest)
    },
    async get(slug) {
      return (await all()).find((s) => s.slug === slug) || null
    },
    invalidate() { cache = null },
  }
}

// A `/name` or `$name` token: at the start or after whitespace or an opening
// bracket, and not followed by more of a path ("/home/x" is not a mention).
const MENTION_RE = /(^|[\s(\[{"'])([/$])([a-z0-9][a-z0-9-]*)(?=$|[\s.,;:!?)\]}"'])/gi

/** Every `/name` / `$name` token in a message, in order, deduplicated by name. */
export function findMentions(text) {
  const out = []
  const seen = new Set()
  for (const m of String(text || '').matchAll(MENTION_RE)) {
    const name = m[3].toLowerCase()
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ prefix: m[2], name })
  }
  return out
}

/**
 * The prompt block for the skills a message cites. Each entry is
 * `{ name, source, path?, body }`. Empty string when there are none.
 */
export function skillMentionBlock(skills, { owner = 'The owner' } = {}) {
  if (!skills.length) return ''
  const parts = skills.map((s) => {
    const attrs = [`name="${s.name}"`, s.source && `source="${s.source}"`, s.path && `path="${s.path}"`].filter(Boolean).join(' ')
    return `<skill ${attrs}>\n${s.body}\n</skill>`
  })
  return `${owner} cited ${skills.length === 1 ? 'a skill' : 'these skills'} in this message (written /name). ` +
    `Follow ${skills.length === 1 ? 'its' : 'their'} instructions, applied to what the message asks; the message's own words ` +
    'say what to use it on and take precedence where they differ. Files a skill mentions by relative path are in the folder of its path.\n\n' +
    `${parts.join('\n\n')}\n\n`
}
