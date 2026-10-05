// search/sources.mjs — what search reads, one loader per kind.
//
// Each returns docs for search/index.mjs. They read the same stores the
// dashboard reads (direct reads, never an agent round-trip) and never write.
// Granularity is chosen so a hit points somewhere useful: a note is split at its
// headings (with the line it starts on), a chat into its messages, a task carries
// its notes, a list carries its items.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

export const KINDS = ['note', 'journal', 'chat', 'task', 'goal', 'list', 'project', 'totem']

async function walkMarkdown(dir, out = []) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) await walkMarkdown(full, out)
    else if (/\.md$/i.test(ent.name)) out.push(full)
  }
  return out
}

/**
 * Markdown cut at its headings. A section is the heading line and everything to
 * the next heading of any level; text before the first heading is its own
 * section under the file's name. `line` is 1-based.
 */
export function markdownSections(text) {
  const lines = String(text || '').split('\n')
  const out = []
  let cur = { heading: '', line: 1, lines: [] }
  let fenced = false
  const close = () => {
    const body = cur.lines.join('\n').trim()
    if (body || cur.heading) out.push({ heading: cur.heading, line: cur.line, body })
  }
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const m = !fenced && /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      close()
      cur = { heading: m[2].replace(/#+\s*$/, '').trim(), line: i + 1, lines: [] }
      return
    }
    cur.lines.push(line)
  })
  close()
  return out
}

const fileTitle = (rel) => rel.replace(/\.md$/i, '').split('/').pop().replace(/[-_]+/g, ' ')
const day = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null)
const isoDay = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null)

/** The notes repo ("memory"), one doc per heading section. */
export function noteSource({ root, include = () => true }) {
  return {
    kind: 'note',
    async load() {
      const docs = []
      for (const full of await walkMarkdown(root)) {
        const rel = relative(root, full).split('\\').join('/')
        if (!include(rel)) continue
        const [text, info] = await Promise.all([readFile(full, 'utf8'), stat(full)])
        const name = fileTitle(rel)
        for (const s of markdownSections(text)) {
          if (!s.body && !s.heading) continue
          docs.push({
            id: `${rel}#${s.line}`,
            title: s.heading && s.heading.toLowerCase() !== name.toLowerCase() ? `${name} › ${s.heading}` : name,
            body: s.body || s.heading,
            date: day(info.mtimeMs),
            target: { tab: 'brain', path: rel, line: s.line },
          })
        }
      }
      return docs
    },
  }
}

/** Voice journal entries: the transcript, under the entry's title. */
export function journalSource({ store }) {
  return {
    kind: 'journal',
    async load() {
      return (await store.list())
        .filter((e) => e?.id && (e.transcript || e.title))
        .map((e) => ({
          id: e.id,
          title: e.title || `Journal ${e.date || ''}`.trim(),
          body: typeof e.transcript === 'string' ? e.transcript : e.transcript?.text || '',
          date: e.date || isoDay(e.recordedAt) || isoDay(e.createdAt),
          target: { tab: 'productivity', app: 'journal', id: e.id },
        }))
    },
  }
}

/** Chat threads, one doc per message, so a hit opens the conversation it is in. */
export function chatSource({ threads }) {
  return {
    kind: 'chat',
    async load() {
      const docs = []
      for (const t of await threads.list()) {
        // An untitled chat goes by its first question, the way the chat list shows it.
        const first = (t.messages || []).find((m) => m.role === 'user')?.content?.replace(/\s+/g, ' ').trim() || ''
        const title = t.title || (first ? (first.length > 48 ? `${first.slice(0, 48)}…` : first) : 'Untitled chat')
        ;(t.messages || []).forEach((m, i) => {
          const body = String(m.content || '').trim()
          if (!body || (m.role !== 'user' && m.role !== 'assistant')) return
          docs.push({
            id: `${t.id}/${m.id || i}`,
            title: `${title} · ${m.role === 'user' ? 'you' : 'Totem'}`,
            body,
            date: day(m.createdAt) || day(t.updatedAt),
            target: { tab: 'chat', thread: t.id, message: m.id || null },
          })
        })
      }
      return docs
    },
  }
}

/** Tasks that still exist (deleted ones are gone), with their notes and tags. */
export function taskSource({ db }) {
  return {
    kind: 'task',
    async load() {
      const notes = new Map()
      for (const n of db.prepare('SELECT todo_id, body FROM todo_notes ORDER BY created_at').all()) {
        notes.set(n.todo_id, [...(notes.get(n.todo_id) || []), n.body])
      }
      const tags = new Map()
      for (const t of db.prepare('SELECT tt.todo_id, t.name FROM todo_tags tt JOIN tags t ON t.id = tt.tag_id').all()) {
        tags.set(t.todo_id, [...(tags.get(t.todo_id) || []), t.name])
      }
      return db.prepare(`SELECT id, title, description, area, venture_tag, status, due_date, completed_at, archived_at, updated_at
        FROM todos WHERE deleted_at IS NULL`).all().map((t) => {
        const state = t.completed_at ? 'done' : t.archived_at ? 'archived' : t.status
        const meta = [t.area, t.venture_tag, state, t.due_date ? `due ${t.due_date}` : '', ...(tags.get(t.id) || []).map((x) => `#${x}`)].filter(Boolean).join(' · ')
        return {
          id: t.id,
          title: t.title,
          body: [meta, t.description, ...(notes.get(t.id) || [])].filter(Boolean).join('\n\n'),
          date: t.due_date || isoDay(t.updated_at),
          target: { tab: 'productivity', app: 'todos', id: t.id },
        }
      })
    },
  }
}

/** Goals and their steps. */
export function goalSource({ db }) {
  return {
    kind: 'goal',
    async load() {
      return db.prepare(`SELECT id, title, notes, period_type, period_start, completed_at, abandoned_at
        FROM goals WHERE deleted_at IS NULL`).all().map((g) => ({
        id: g.id,
        title: g.title || 'Goal',
        body: [[g.period_type, g.period_start, g.completed_at ? 'achieved' : g.abandoned_at ? 'abandoned' : ''].filter(Boolean).join(' · '), g.notes].filter(Boolean).join('\n\n'),
        date: isoDay(g.period_start),
        target: { tab: 'productivity', app: 'goals', id: g.id },
      }))
    },
  }
}

/** Lists with their items, one doc per list. */
export function listSource({ db }) {
  return {
    kind: 'list',
    async load() {
      const items = new Map()
      for (const it of db.prepare('SELECT list_id, text, checked FROM list_items ORDER BY position').all()) {
        items.set(it.list_id, [...(items.get(it.list_id) || []), `- [${it.checked ? 'x' : ' '}] ${it.text}`])
      }
      return db.prepare('SELECT id, title, updated_at FROM lists').all().map((l) => ({
        id: l.id,
        title: l.title,
        body: (items.get(l.id) || []).join('\n'),
        date: isoDay(l.updated_at),
        target: { tab: 'productivity', app: 'lists', id: l.id },
      }))
    },
  }
}

/** Chat projects: the owner's instructions and the memory the agent keeps there. */
export function projectSource({ projects }) {
  return {
    kind: 'project',
    async load() {
      const docs = []
      for (const p of await projects.list()) {
        const memory = await projects.readMemory(p.id).catch(() => '')
        const target = { tab: 'chat', project: p.id }
        if (p.instructions?.trim()) docs.push({ id: `${p.id}/instructions`, title: `${p.name} › instructions`, body: p.instructions, date: day(p.updatedAt), target })
        if (String(memory || '').trim()) docs.push({ id: `${p.id}/memory`, title: `${p.name} › memory`, body: memory, date: day(p.updatedAt), target })
      }
      return docs
    },
  }
}

/** Totems: what each one is told to do, and the memory it keeps between runs. */
export function totemSource({ jobs, memoryPath }) {
  return {
    kind: 'totem',
    async load() {
      const docs = []
      for (const j of await jobs.list()) {
        const target = { tab: 'totems', totem: j.id }
        const name = j.name || j.title || j.id
        const instructions = j.prompt || j.instructions || ''
        if (String(instructions).trim()) docs.push({ id: `${j.id}/instructions`, title: `${name} › instructions`, body: String(instructions), date: null, target })
        const memory = await readFile(memoryPath(j.id), 'utf8').catch(() => '')
        if (memory.trim()) docs.push({ id: `${j.id}/memory`, title: `${name} › memory`, body: memory, date: null, target })
      }
      return docs
    },
  }
}
