// skills/store.mjs — every prompt Totem runs, as an editable file on disk.
//
// The rule this module exists to enforce: **nothing Totem does is locked in
// code.** The daily brief, the journal ingest, the Plaud action-item ingest —
// each used to be a 60-line template literal buried in bridge.mjs, unreachable
// from the UI and unreachable from a text editor. Changing what the Plaud ingest
// asked for meant editing the bridge and restarting the service.
//
// Now each of those is a file under data/skills/<id>/SKILL.md that you can edit
// in the app, in vim, or by asking Totem to edit it. The versions that ship live
// in skills/seeds/ and are *copied in on first boot* — they are a starting point,
// not an override. Nothing in the running system reads skills/seeds/ again except
// the explicit "Reset to default" action.
//
// Three properties make editing safe enough to be the default:
//
//   1. **Seeds are copied, never merged.** Once data/skills/<id> exists, the seed
//      is inert. An edit can't be silently reverted by a deploy.
//   2. **Deletes are remembered.** A ledger (.seeded.json) records every seed
//      ever installed, so deleting a shipped skill deletes it for good rather
//      than having it reappear at the next backfill. New seeds still arrive.
//   3. **Reset is always available.** `reset(id)` re-copies the seed, so there is
//      no edit you can't undo — which is what makes the whole thing editable
//      rather than merely writable.
//
// Reads go straight to disk on every call. There's no cache to invalidate,
// because a file someone edited in vim while the bridge was running must take
// effect on the next run, not the next restart.

import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { mkdir, readFile, writeFile, rename, readdir, rm, stat } from 'node:fs/promises'
import { parseSkillFile, serializeSkillFile, renderSkillBody, skillVariables } from './format.mjs'

const SKILL_FILE = 'SKILL.md'
const LEDGER_FILE = '.seeded.json'
const MAX_BODY = 40_000

/** A skill id: lowercase, dash-separated, safe as a directory name. */
export function slugify(value, fallback = '') {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || fallback
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Normalize a chat command to a single leading `/` or `$`, or null. */
function normalizeCommand(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const prefix = raw[0] === '$' ? '$' : '/'
  const slug = slugify(raw.replace(/^[/$]+/, ''))
  return slug ? `${prefix}${slug}` : null
}

export function createSkillStore({ dir, seedDir, log = () => {} }) {
  let queue = Promise.resolve()

  // Serialize writes. Two browser tabs saving different skills is fine, but two
  // saves of the *same* skill racing on a read-modify-write is not.
  function withLock(fn) {
    const run = queue.then(() => fn())
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const skillDir = (id) => join(dir, id)
  const skillPath = (id) => join(dir, id, SKILL_FILE)

  async function writeAtomic(path, text) {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, text)
    await rename(tmp, path)
  }

  // --- seed ledger ------------------------------------------------------------
  // { [id]: { installedAt } } for every seed ever copied in. Its only job is to
  // stop a deleted built-in from being resurrected by the next backfill.

  async function readLedger() {
    try { return JSON.parse(await readFile(join(dir, LEDGER_FILE), 'utf8')) }
    catch { return {} }
  }

  async function writeLedger(ledger) {
    await writeAtomic(join(dir, LEDGER_FILE), JSON.stringify(ledger, null, 2))
  }

  async function readSeed(id) {
    try { return await readFile(join(seedDir, id, SKILL_FILE), 'utf8') }
    catch { return null }
  }

  async function listSeedIds() {
    try {
      const entries = await readdir(seedDir, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    } catch { return [] }
  }

  /**
   * Copy in any seed that has never been installed here.
   *
   * Runs on every boot, not just the first. That's how a skill added to the repo
   * later shows up without anyone clearing data/ — the same backfill rule the job
   * store already uses. A seed whose id is in the ledger is skipped whether or not
   * the file still exists, so "I deleted the daily brief" stays deleted.
   */
  async function seed() {
    return withLock(async () => {
      await mkdir(dir, { recursive: true })
      const ledger = await readLedger()
      const installed = []
      for (const id of await listSeedIds()) {
        if (ledger[id]) continue
        const text = await readSeed(id)
        if (text == null) continue
        await writeAtomic(skillPath(id), text)
        ledger[id] = { installedAt: new Date().toISOString() }
        installed.push(id)
      }
      if (installed.length) {
        await writeLedger(ledger)
        log(`skills: installed ${installed.length} default skill(s) — ${installed.join(', ')}`)
      }
      return installed
    })
  }

  // --- reads ------------------------------------------------------------------

  function hydrate(id, text, { seedText = null, mtime = null } = {}) {
    const { meta, body } = parseSkillFile(text)
    return {
      id,
      name: meta.name || id,
      description: meta.description || '',
      iconName: meta.icon || meta.iconName || 'sparkles',
      command: normalizeCommand(meta.command),
      // 'fill' puts the text in the composer for you to finish; 'send' runs it.
      mode: meta.mode === 'fill' ? 'fill' : 'send',
      requires: Array.isArray(meta.requires) ? meta.requires : [],
      enabled: meta.enabled !== false,
      body,
      variables: skillVariables(body),
      // Provenance only — it grants no privilege. A seeded skill is exactly as
      // editable and deletable as one you wrote.
      kind: seedText == null ? 'user' : 'seeded',
      // Whether it still matches what shipped, which is what decides if the UI
      // offers "Reset to default".
      modified: seedText != null && text.trim() !== seedText.trim(),
      path: skillPath(id),
      updatedAt: mtime ? new Date(mtime).toISOString() : null,
    }
  }

  async function readOne(id) {
    let text
    let mtime = null
    try {
      const path = skillPath(id)
      text = await readFile(path, 'utf8')
      mtime = (await stat(path)).mtimeMs
    } catch { return null }
    return hydrate(id, text, { seedText: await readSeed(id), mtime })
  }

  async function list() {
    await mkdir(dir, { recursive: true })
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) }
    catch { return [] }
    const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    const skills = (await Promise.all(ids.map((id) => readOne(id)))).filter(Boolean)
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  const get = (id) => (id ? readOne(String(id)) : Promise.resolve(null))

  /** Every skill exposing a chat command, keyed by that command. */
  async function commandMap() {
    const map = new Map()
    for (const s of await list()) {
      if (s.enabled && s.command) map.set(s.command.toLowerCase(), s)
    }
    return map
  }

  // --- writes -----------------------------------------------------------------

  function metaOf(skill) {
    return {
      name: skill.name,
      description: skill.description,
      icon: skill.iconName,
      command: skill.command || '',
      mode: skill.mode === 'fill' ? 'fill' : '',
      requires: skill.requires,
      // Only written when false — an absent `enabled` means on, which keeps the
      // common case out of the file.
      ...(skill.enabled ? {} : { enabled: false }),
    }
  }

  async function create(input = {}) {
    return withLock(async () => {
      await mkdir(dir, { recursive: true })
      const name = cleanText(input.name, 80) || 'Untitled skill'
      const base = slugify(input.id || name, 'skill')
      // Never clobber an existing skill by name collision.
      let id = base
      for (let n = 2; await readOne(id); n += 1) id = `${base}-${n}`
      const skill = {
        name,
        description: cleanText(input.description, 300),
        iconName: slugify(input.iconName, 'sparkles'),
        command: normalizeCommand(input.command ?? `/${id}`),
        mode: input.mode === 'fill' ? 'fill' : 'send',
        requires: Array.isArray(input.requires) ? input.requires.map((r) => slugify(r)).filter(Boolean) : [],
        enabled: input.enabled !== false,
      }
      await writeAtomic(skillPath(id), serializeSkillFile(metaOf(skill), String(input.body ?? '').slice(0, MAX_BODY)))
      log(`skill created: ${id} (${name})`)
      return readOne(id)
    })
  }

  /**
   * Patch a skill. Every field is editable for every skill — that's the point of
   * the module. Renaming does not move the directory: the id is a stable handle
   * that jobs and saved chat commands reference, and re-slugging it on every
   * rename would break them silently.
   */
  async function update(id, patch = {}) {
    return withLock(async () => {
      const current = await readOne(id)
      if (!current) return null
      const next = { ...current }
      if (patch.name !== undefined) next.name = cleanText(patch.name, 80) || current.name
      if (patch.description !== undefined) next.description = cleanText(patch.description, 300)
      if (patch.iconName !== undefined) next.iconName = slugify(patch.iconName, 'sparkles')
      if (patch.command !== undefined) next.command = normalizeCommand(patch.command)
      if (patch.mode !== undefined) next.mode = patch.mode === 'fill' ? 'fill' : 'send'
      if (patch.requires !== undefined) {
        next.requires = Array.isArray(patch.requires) ? patch.requires.map((r) => slugify(r)).filter(Boolean) : []
      }
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
      const body = patch.body !== undefined ? String(patch.body).slice(0, MAX_BODY) : current.body
      await writeAtomic(skillPath(id), serializeSkillFile(metaOf(next), body))
      return readOne(id)
    })
  }

  async function remove(id) {
    return withLock(async () => {
      const current = await readOne(id)
      if (!current) return { ok: false, error: 'no such skill' }
      await rm(skillDir(id), { recursive: true, force: true })
      // The ledger entry stays, so a seeded skill you deleted does not come back
      // on the next boot. `reset(id)` is the way to get it back deliberately.
      log(`skill deleted: ${id}`)
      return { ok: true, id, wasSeeded: current.kind === 'seeded' }
    })
  }

  /** Restore a seeded skill to the version that ships. The undo for any edit. */
  async function reset(id) {
    return withLock(async () => {
      const text = await readSeed(id)
      if (text == null) return { ok: false, error: 'this skill has no shipped default to reset to' }
      await writeAtomic(skillPath(id), text)
      const ledger = await readLedger()
      if (!ledger[id]) { ledger[id] = { installedAt: new Date().toISOString() }; await writeLedger(ledger) }
      log(`skill reset to default: ${id}`)
      return { ok: true, skill: await readOne(id) }
    })
  }

  // --- rendering ---------------------------------------------------------------

  /**
   * The prompt this skill produces right now, with `vars` filled in.
   *
   * `missing` lists placeholders the body asks for that the caller didn't supply.
   * It is not an error — a prompt with a typo'd variable still runs, just without
   * that value — but the bridge logs it and the editor shows it, so a broken edit
   * surfaces as a warning rather than as an agent quietly doing the wrong thing.
   */
  async function render(id, vars = {}) {
    const skill = await readOne(id)
    if (!skill) return null
    const { text, missing } = renderSkillBody(skill.body, vars)
    return { skill, text, missing }
  }

  return { seed, list, get, commandMap, create, update, remove, reset, render, slugify }
}
