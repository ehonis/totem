import { randomUUID } from 'node:crypto';

import { withTodoTransaction } from './db.mjs';
import { TodoDomainError } from './errors.mjs';
import { nextOccurrence } from './recurrence.mjs';

const AREAS = new Set(['Personal', 'Ventures']);
// Venture tags are configured per install (todo_preferences key `ventureTags`,
// seeded by migration 008), not a fixed list. See listVentureTags().
const VENTURE_TAGS_KEY = 'ventureTags';
const MAX_VENTURE_TAG_LENGTH = 40;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const STATUSES = new Set(['todo', 'doing', 'done']);
const COMPLETION_OWNERS = new Set(['github', 'sheet']);
const COMPLETION_METADATA_KEY = '__totemCompletion';
const SOURCE_SNAPSHOT_METADATA_KEY = '__totemSourceSnapshot';
const UPDATE_FIELDS = new Set([
  'title',
  'description',
  'area',
  'ventureTag',
  'priority',
  'dueDate',
  'recurrence',
  'snoozedUntil',
  'position',
  'tags',
]);
const PREFERENCE_FIELDS = new Set(['autoArchiveDays', 'autoArchiveAt', 'recyclePurgeDays']);
const DEFAULT_PREFERENCES = Object.freeze({
  autoArchiveDays: null,
  // Local wall-clock "HH:MM", on by default. A daily sweep at a time of day is how a
  // day's work actually ends — "older than N days" never lines up with an evening —
  // and an empty Done column at six is the point of the thing, not a surprise.
  autoArchiveAt: '18:00',
  recyclePurgeDays: null,
});

function domainError(code, message, options) {
  return new TodoDomainError(code, message, options);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw domainError('INVALID_TODO_FIELD', `${field} must be a non-empty string.`, {
      details: { field },
    });
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw domainError('INVALID_TODO_FIELD', `${field} must be a string or null.`, {
      details: { field },
    });
  }
  return value.trim() || null;
}

function description(value = '') {
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw domainError('INVALID_TODO_FIELD', 'description must be a string.', {
      details: { field: 'description' },
    });
  }
  return value;
}

function timestamp(value, field, { nullable = true } = {}) {
  if (value == null || value === '') {
    if (nullable) return null;
    throw domainError('INVALID_TIMESTAMP', `${field} must be a valid timestamp.`, {
      details: { field },
    });
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw domainError('INVALID_TIMESTAMP', `${field} must be a valid timestamp.`, {
      details: { field },
    });
  }
  return date.toISOString();
}

function date(value, field) {
  const normalized = optionalString(value, field);
  if (normalized == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw domainError('INVALID_DATE', `${field} must be a YYYY-MM-DD date.`, {
      details: { field },
    });
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw domainError('INVALID_DATE', `${field} must be a real calendar date.`, {
      details: { field },
    });
  }
  return normalized;
}

function status(value) {
  if (!STATUSES.has(value)) {
    throw domainError('INVALID_STATUS', 'status must be todo, doing, or done.', {
      details: { status: value },
    });
  }
  return value;
}

/** How a finished task ended: it happened, or it never will. */
function completionOutcome(value) {
  if (value === 'completed' || value === 'not_doing') return value;
  throw domainError('INVALID_OUTCOME', 'outcome must be completed or not_doing.', {
    details: { outcome: value },
  });
}

function priority(value) {
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw domainError('INVALID_PRIORITY', 'priority must be an integer from 1 to 4.', {
      details: { priority: value },
    });
  }
  return value;
}

function position(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw domainError('INVALID_POSITION', 'position must be a finite number.', {
      details: { position: value },
    });
  }
  return value;
}

/**
 * `allowed` is the configured tag names, or null to check only the shape (imports,
 * whose connector validated the tag already). A tag the task already carries stays
 * valid after it is removed from the list, so an old task can still be edited.
 */
function classification(area, ventureTag, allowed = null, current = null) {
  if (!AREAS.has(area)) {
    throw domainError('INVALID_AREA', 'area must be Personal or Ventures.', {
      details: { area },
    });
  }
  if (area === 'Ventures') {
    if (ventureTag == null) {
      throw domainError('VENTURE_TAG_REQUIRED', 'Ventures tasks require one venture classification.');
    }
    if (ventureTag.length > MAX_VENTURE_TAG_LENGTH) {
      throw domainError('INVALID_VENTURE_TAG', `ventureTag must be at most ${MAX_VENTURE_TAG_LENGTH} characters.`, {
        details: { ventureTag },
      });
    }
    if (allowed) {
      const match = allowed.find(name => name.toLowerCase() === ventureTag.toLowerCase());
      if (match) return { area, ventureTag: match };
      if (ventureTag !== current) {
        throw domainError(
          'INVALID_VENTURE_TAG',
          allowed.length
            ? `ventureTag must be one of: ${allowed.join(', ')}.`
            : 'No venture tags are configured. Add one in the task settings first.',
          { details: { ventureTag, allowed } },
        );
      }
    }
  } else if (ventureTag != null) {
    throw domainError('VENTURE_TAG_NOT_ALLOWED', 'Personal tasks cannot have a venture classification.');
  }
  return { area, ventureTag };
}

function fieldValue(input, defaults, field, fallback) {
  if (Object.hasOwn(input, field) && input[field] !== undefined) return input[field];
  if (Object.hasOwn(defaults, field)) return defaults[field];
  return fallback;
}

function normalizedTodo(input, defaults = {}, allowedVentureTags = null) {
  const area = fieldValue(input, defaults, 'area', 'Personal');
  const ventureTag = classification(
    area,
    optionalString(fieldValue(input, defaults, 'ventureTag', null), 'ventureTag'),
    allowedVentureTags,
    defaults.ventureTag ?? null,
  ).ventureTag;
  const dueDate = date(fieldValue(input, defaults, 'dueDate', null), 'dueDate');
  const recurrence = optionalString(fieldValue(input, defaults, 'recurrence', null), 'recurrence');
  if (recurrence && !dueDate) {
    throw domainError('RECURRENCE_REQUIRES_DUE_DATE', 'A recurring todo requires a due date.');
  }
  if (recurrence) {
    try {
      nextOccurrence({ dueDate, recurrence });
    } catch (error) {
      throw domainError('INVALID_RECURRENCE', error.message, { details: { recurrence } });
    }
  }
  return {
    title: requiredString(fieldValue(input, defaults, 'title'), 'title'),
    description: description(fieldValue(input, defaults, 'description', '')),
    area,
    ventureTag,
    status: status(fieldValue(input, defaults, 'status', 'todo')),
    priority: priority(fieldValue(input, defaults, 'priority', 1)),
    dueDate,
    recurrence,
    snoozedUntil: timestamp(fieldValue(input, defaults, 'snoozedUntil', null), 'snoozedUntil'),
    position: position(fieldValue(input, defaults, 'position', 0)),
  };
}

function normalizedTags(value, field = 'tags') {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw domainError('INVALID_TODO_FIELD', `${field} must be an array of tag names.`, {
      details: { field },
    });
  }
  const names = value.map(item => requiredString(item, field));
  return [...new Map(names.map(name => [name.toLocaleLowerCase(), name])).values()];
}

function jsonForStorage(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}

function jsonFromStorage(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// Back-compat: link snapshots stored before the 2026-10-02 rename use these keys.
// Read-only fallback; every write uses the keys above. Can go once no
// `source_snapshot` in data/todos.db contains `__vesperCompletion`.
const LEGACY_COMPLETION_METADATA_KEY = '__vesperCompletion';
const LEGACY_SOURCE_SNAPSHOT_METADATA_KEY = '__vesperSourceSnapshot';

function observationMetadata(value) {
  const parsed = jsonFromStorage(value);
  if (
    parsed &&
    !Array.isArray(parsed) &&
    typeof parsed === 'object' &&
    typeof parsed[LEGACY_COMPLETION_METADATA_KEY] === 'boolean' &&
    Object.hasOwn(parsed, LEGACY_SOURCE_SNAPSHOT_METADATA_KEY)
  ) {
    return {
      completed: parsed[LEGACY_COMPLETION_METADATA_KEY],
      sourceSnapshot: parsed[LEGACY_SOURCE_SNAPSHOT_METADATA_KEY],
    };
  }
  if (
    parsed &&
    !Array.isArray(parsed) &&
    typeof parsed === 'object' &&
    typeof parsed[COMPLETION_METADATA_KEY] === 'boolean' &&
    Object.hasOwn(parsed, SOURCE_SNAPSHOT_METADATA_KEY)
  ) {
    return {
      completed: parsed[COMPLETION_METADATA_KEY],
      sourceSnapshot: parsed[SOURCE_SNAPSHOT_METADATA_KEY],
    };
  }
  return { completed: false, sourceSnapshot: parsed };
}

function observationSnapshotForStorage(sourceSnapshot, completed) {
  return JSON.stringify({
    [COMPLETION_METADATA_KEY]: completed,
    [SOURCE_SNAPSHOT_METADATA_KEY]: sourceSnapshot,
  });
}

function sourceWasCompleted(link) {
  return observationMetadata(link.source_snapshot).completed;
}

function maxTimestamp(values) {
  const present = values.filter(Boolean).sort();
  return present.at(-1) ?? null;
}

export function createTodoService({
  db,
  now = () => new Date().toISOString(),
  makeId = randomUUID,
  actionLog,
} = {}) {
  if (!db) throw new Error('createTodoService requires db');
  if (typeof now !== 'function') throw new Error('createTodoService requires now to be a function');
  if (typeof makeId !== 'function') throw new Error('createTodoService requires makeId to be a function');
  if (!actionLog || typeof actionLog.record !== 'function') {
    throw new Error('createTodoService requires an actionLog with record()');
  }

  const getTodoRow = db.prepare('SELECT * FROM todos WHERE id = ?');

  function currentTimestamp() {
    return timestamp(now(), 'now', { nullable: false });
  }

  function notFound(id) {
    return domainError('TODO_NOT_FOUND', `Todo ${id} was not found.`, {
      status: 404,
      details: { id },
    });
  }

  function requireRow(id) {
    const row = getTodoRow.get(id);
    if (!row) throw notFound(id);
    return row;
  }

  function externalLinksFor(id) {
    return db.prepare(`
      SELECT * FROM external_links WHERE todo_id = ? ORDER BY connector, id
    `).all(id).map(link => ({
      id: link.id,
      connector: link.connector,
      externalId: link.external_id,
      externalUrl: link.external_url,
      sourceStatus: link.source_status,
      sourceSnapshot: observationMetadata(link.source_snapshot).sourceSnapshot,
      lastSyncSnapshot: jsonFromStorage(link.last_sync_snapshot),
      initialStatusSeeded: Boolean(link.initial_status_seeded),
      lastObservedAt: link.last_observed_at,
      lastSyncedAt: link.last_synced_at,
      missingAt: link.missing_at,
      createdAt: link.created_at,
      updatedAt: link.updated_at,
    }));
  }

  function syncStateFor(id, links) {
    const outbox = db.prepare(`
      SELECT status, COUNT(*) AS count, MAX(last_error) AS last_error
      FROM sync_outbox
      WHERE todo_id = ? AND status <> 'completed'
      GROUP BY status
    `).all(id);
    const counts = Object.fromEntries(outbox.map(row => [row.status, Number(row.count)]));
    const pending = (counts.pending ?? 0) + (counts.leased ?? 0) + (counts.retry ?? 0);
    const conflicts = counts.conflict ?? 0;
    const exhausted = counts.exhausted ?? 0;
    const missing = links.some(link => link.missingAt != null);
    const connectors = [...new Set(links.map(link => link.connector))];
    const connectorRows = connectors.length === 0 ? [] : db.prepare(`
      SELECT connector, last_success_at, last_error
      FROM connector_state
      WHERE connector IN (${connectors.map(() => '?').join(', ')})
    `).all(...connectors);
    const lastError = connectorRows.find(row => row.last_error)?.last_error
      ?? outbox.find(row => row.status === 'exhausted')?.last_error
      ?? null;
    const lastSuccessAt = maxTimestamp([
      ...links.map(link => link.lastSyncedAt),
      ...connectorRows.map(row => row.last_success_at),
    ]);
    let syncStatus = 'idle';
    if (conflicts > 0) syncStatus = 'conflict';
    else if (missing) syncStatus = 'missing';
    else if (pending > 0) syncStatus = 'pending';
    else if (exhausted > 0) syncStatus = 'error';
    else if (lastError) syncStatus = 'error';
    else if (lastSuccessAt) syncStatus = 'synced';
    return { status: syncStatus, pending, conflicts, exhausted, missing, lastSuccessAt, lastError };
  }

  function dtoFromRow(row) {
    const links = externalLinksFor(row.id);
    const tags = db.prepare(`
      SELECT tags.id, tags.name
      FROM tags JOIN todo_tags ON todo_tags.tag_id = tags.id
      WHERE todo_tags.todo_id = ? ORDER BY tags.name, tags.id
    `).all(row.id);
    const notes = db.prepare(`
      SELECT id, body, created_at FROM todo_notes
      WHERE todo_id = ? ORDER BY created_at, id
    `).all(row.id).map(note => ({
      id: note.id,
      body: note.body,
      createdAt: note.created_at,
    }));
    const relations = db.prepare(`
      SELECT todos.id, todos.title, todos.status, todos.area, todos.venture_tag
      FROM todo_relations
      JOIN todos ON todos.id = CASE
        WHEN todo_relations.left_todo_id = ? THEN todo_relations.right_todo_id
        ELSE todo_relations.left_todo_id
      END
      WHERE todo_relations.left_todo_id = ? OR todo_relations.right_todo_id = ?
      ORDER BY todos.id
    `).all(row.id, row.id, row.id).map(relation => ({
      id: relation.id,
      title: relation.title,
      status: relation.status,
      area: relation.area,
      ventureTag: relation.venture_tag,
    }));
    // Reverse side of the Lists relationship. It is intentionally only a pointer:
    // list items and task completion remain independent state machines.
    const lists = db.prepare(`
      SELECT lists.id, lists.title
      FROM list_todos JOIN lists ON lists.id = list_todos.list_id
      WHERE list_todos.todo_id = ? ORDER BY lists.position, lists.id
    `).all(row.id).map((list) => ({ id: list.id, title: list.title }));
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      area: row.area,
      ventureTag: row.venture_tag,
      status: row.status,
      priority: row.priority,
      dueDate: row.due_date,
      recurrence: row.recurrence,
      snoozedUntil: row.snoozed_until,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      // Only a finished task has an outcome, and a row finished before outcomes
      // existed was finished the only way there was.
      outcome: row.status === 'done' ? (row.outcome ?? 'completed') : null,
      archivedAt: row.archived_at,
      deletedAt: row.deleted_at,
      tags,
      notes,
      relations,
      lists,
      externalLinks: links,
      syncState: syncStateFor(row.id, links),
    };
  }

  function get(id) {
    const row = getTodoRow.get(requiredString(id, 'id'));
    return row ? dtoFromRow(row) : null;
  }

  function requireTodo(id) {
    return dtoFromRow(requireRow(requiredString(id, 'id')));
  }

  function list(query = {}) {
    const where = [];
    const parameters = [];
    const deletedOnly = query.deleted === true || query.includeDeleted === true;
    if (deletedOnly) {
      where.push('todos.deleted_at IS NOT NULL');
    } else {
      where.push('todos.deleted_at IS NULL');
    }
    if (query.archived === true) {
      where.push('todos.archived_at IS NOT NULL');
    } else if (query.archived === false || (!query.includeArchived && !deletedOnly)) {
      where.push('todos.archived_at IS NULL');
    }
    for (const [field, column] of [
      ['area', 'area'],
      ['ventureTag', 'venture_tag'],
      ['status', 'status'],
      ['outcome', 'outcome'],
      ['priority', 'priority'],
    ]) {
      if (query[field] !== undefined && query[field] !== null && query[field] !== '') {
        where.push(`todos.${column} = ?`);
        parameters.push(query[field]);
      }
    }
    if (query.source) {
      where.push('EXISTS (SELECT 1 FROM external_links el WHERE el.todo_id = todos.id AND el.connector = ?)');
      parameters.push(query.source);
    }
    if (query.due !== undefined && query.due !== null && query.due !== '') {
      where.push('todos.due_date = ?');
      parameters.push(date(query.due, 'due'));
    }
    if (typeof query.snoozed === 'boolean') {
      const at = currentTimestamp();
      where.push(query.snoozed
        ? 'todos.snoozed_until > ?'
        : '(todos.snoozed_until IS NULL OR todos.snoozed_until <= ?)');
      parameters.push(at);
    }
    const search = optionalString(query.search ?? query.text, 'search');
    if (search) {
      where.push(`(
        lower(todos.title) LIKE lower(?) OR
        lower(todos.description) LIKE lower(?) OR
        EXISTS (
          SELECT 1 FROM todo_notes n
          WHERE n.todo_id = todos.id AND lower(n.body) LIKE lower(?)
        ) OR
        EXISTS (
          SELECT 1 FROM tags t JOIN todo_tags tt ON tt.tag_id = t.id
          WHERE tt.todo_id = todos.id AND lower(t.name) LIKE lower(?)
        ) OR
        EXISTS (
          SELECT 1 FROM external_links el
          WHERE el.todo_id = todos.id AND (
            lower(el.external_id) LIKE lower(?) OR
            lower(el.connector || '#' || el.external_id) LIKE lower(?) OR
            lower(COALESCE(el.external_url, '')) LIKE lower(?) OR
            lower(COALESCE(el.source_snapshot, '')) LIKE lower(?)
          )
        )
      )`);
      const pattern = `%${search}%`;
      const githubReference = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(search);
      const githubUrlPattern = githubReference
        ? `%github.com/${githubReference[1]}/issues/${githubReference[2]}%`
        : pattern;
      parameters.push(pattern, pattern, pattern, pattern, pattern, pattern, githubUrlPattern, pattern);
    }
    const orderBy = {
      manual: `CASE todos.status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END,
        todos.position, todos.id`,
      priority: `todos.priority DESC, todos.position, todos.id`,
      due: `todos.due_date IS NULL, todos.due_date, todos.position, todos.id`,
      title: `lower(todos.title), todos.position, todos.id`,
    }[query.sort ?? 'manual'];
    if (!orderBy) {
      throw domainError('INVALID_SORT', 'sort must be manual, priority, due, or title.', {
        details: { sort: query.sort },
      });
    }
    return db.prepare(`
      SELECT todos.* FROM todos
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
    `).all(...parameters).map(dtoFromRow);
  }

  function audit(action, target, context, summary, result) {
    const entry = {
      action,
      actor: context?.actor ?? 'unknown',
      target,
      status: 'ok',
      summary,
      why: context?.reason ?? context?.why ?? summary,
      detail: { result },
      correlationId: context?.correlationId ?? randomUUID(),
    };
    actionLog.record(entry);
  }

  function mutate({ action, target, context, summary, result }, fn) {
    const value = withTodoTransaction(db, fn);
    audit(
      action,
      target,
      context,
      typeof summary === 'function' ? summary(value) : summary,
      result,
    );
    return value;
  }

  function insertTodo(input, timestamps) {
    db.prepare(`
      INSERT INTO todos (
        id, title, description, area, venture_tag, status, priority, due_date,
        recurrence, snoozed_until, position, created_at, updated_at, completed_at,
        archived_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      timestamps.id,
      input.title,
      input.description,
      input.area,
      input.ventureTag,
      input.status,
      input.priority,
      input.dueDate,
      input.recurrence,
      input.snoozedUntil,
      input.position,
      timestamps.createdAt,
      timestamps.updatedAt,
      timestamps.completedAt,
      timestamps.archivedAt,
      timestamps.deletedAt,
    );
  }

  function create(input = {}, context) {
    const normalized = normalizedTodo(input, {}, ventureTagNames());
    const tags = normalizedTags(input.tags) ?? [];
    const at = currentTimestamp();
    const id = requiredString(makeId(), 'id');
    const completedAt = normalized.status === 'done' ? at : null;
    return mutate({
      action: 'todo.create',
      target: id,
      context,
      summary: `Created todo "${normalized.title}"`,
      result: 'created',
    }, () => {
      insertTodo(normalized, {
        id,
        createdAt: at,
        updatedAt: at,
        completedAt,
        archivedAt: null,
        deletedAt: null,
      });
      for (const tag of tags) addTagToTodo(id, tag, at);
      return get(id);
    });
  }

  function ensureTag(rawName, createdAt) {
    const name = requiredString(rawName, 'tag');
    let tag = db.prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE').get(name);
    if (!tag) {
      const id = requiredString(makeId(), 'tag id');
      db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(id, name, createdAt);
      tag = { id, name };
    }
    return tag;
  }

  function addTagToTodo(todoId, rawName, createdAt) {
    const tag = ensureTag(rawName, createdAt);
    db.prepare(`
      INSERT OR IGNORE INTO todo_tags (todo_id, tag_id, created_at) VALUES (?, ?, ?)
    `).run(todoId, tag.id, createdAt);
    return tag;
  }

  function removeTagFromTodo(todoId, rawName) {
    const name = requiredString(rawName, 'tag');
    db.prepare(`
      DELETE FROM todo_tags
      WHERE todo_id = ? AND tag_id IN (SELECT id FROM tags WHERE name = ? COLLATE NOCASE)
    `).run(todoId, name);
  }

  function replaceTodoTags(todoId, tags, createdAt) {
    db.prepare('DELETE FROM todo_tags WHERE todo_id = ?').run(todoId);
    for (const tag of tags) addTagToTodo(todoId, tag, createdAt);
  }

  function addImportedCollections(todoId, input, createdAt) {
    if (Array.isArray(input.tags)) {
      for (const rawName of input.tags) addTagToTodo(todoId, rawName, createdAt);
    }
    if (Array.isArray(input.notes)) {
      for (const rawNote of input.notes) {
        const note = typeof rawNote === 'string' ? { body: rawNote } : rawNote;
        const body = requiredString(note?.body, 'note body');
        const noteAt = timestamp(note?.createdAt ?? createdAt, 'note.createdAt', { nullable: false });
        db.prepare(`
          INSERT INTO todo_notes (id, todo_id, body, created_at) VALUES (?, ?, ?, ?)
        `).run(requiredString(note?.id ?? makeId(), 'note id'), todoId, body, noteAt);
      }
    }
  }

  function importRecord(input = {}, importMeta = {}, context) {
    const source = requiredString(importMeta.source, 'importMeta.source');
    const externalId = requiredString(importMeta.externalId, 'importMeta.externalId');
    let inserted = false;
    const todo = withTodoTransaction(db, () => {
      const existing = db.prepare(`
        SELECT todo_id FROM todo_import_keys WHERE source = ? AND external_id = ?
      `).get(source, externalId);
      if (existing) return get(existing.todo_id);

      const normalized = normalizedTodo(input);
      const fallbackAt = currentTimestamp();
      const createdAt = timestamp(input.createdAt ?? fallbackAt, 'createdAt', { nullable: false });
      const updatedAt = timestamp(input.updatedAt ?? createdAt, 'updatedAt', { nullable: false });
      const completedAt = normalized.status === 'done'
        ? timestamp(input.completedAt ?? updatedAt, 'completedAt', { nullable: false })
        : null;
      const archivedAt = input.archived === true && input.archivedAt == null
        ? updatedAt
        : timestamp(input.archivedAt ?? null, 'archivedAt');
      const id = requiredString(input.id ?? makeId(), 'id');
      insertTodo(normalized, {
        id,
        createdAt,
        updatedAt,
        completedAt,
        archivedAt,
        deletedAt: timestamp(input.deletedAt ?? null, 'deletedAt'),
      });
      addImportedCollections(id, input, createdAt);
      db.prepare(`
        INSERT INTO todo_import_keys (source, external_id, todo_id, source_snapshot, imported_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(source, externalId, id, jsonForStorage(importMeta.sourceSnapshot), currentTimestamp());
      inserted = true;
      return get(id);
    });
    if (inserted) {
      audit(
        'todo.import',
        todo.id,
        context,
        `Imported todo "${todo.title}" from ${source}`,
        'imported',
      );
    }
    return todo;
  }

  function validateUpdate(id, patch = {}) {
    requireRow(id);
    if (!patch || Array.isArray(patch) || typeof patch !== 'object') {
      throw domainError('INVALID_PATCH', 'Todo patch must be an object.');
    }
    const unknown = Object.keys(patch).filter(key => !UPDATE_FIELDS.has(key));
    if (unknown.length) {
      throw domainError('UNKNOWN_PATCH_FIELD', `Unknown todo patch field: ${unknown.join(', ')}.`, {
        details: { fields: unknown },
      });
    }
    const before = requireTodo(id);
    const normalized = normalizedTodo(patch, before, ventureTagNames());
    const tags = normalizedTags(patch.tags);
    return { before, normalized, tags };
  }

  function update(id, patch = {}, context) {
    const { normalized, tags } = validateUpdate(id, patch);
    const at = currentTimestamp();
    return mutate({
      action: 'todo.update',
      target: id,
      context,
      summary: `Updated todo "${normalized.title}"`,
      result: 'updated',
    }, () => {
      db.prepare(`
        UPDATE todos SET
          title = ?, description = ?, area = ?, venture_tag = ?, priority = ?,
          due_date = ?, recurrence = ?, snoozed_until = ?, position = ?, updated_at = ?
        WHERE id = ?
      `).run(
        normalized.title,
        normalized.description,
        normalized.area,
        normalized.ventureTag,
        normalized.priority,
        normalized.dueDate,
        normalized.recurrence,
        normalized.snoozedUntil,
        normalized.position,
        at,
        id,
      );
      if (tags !== undefined) replaceTodoTags(id, tags, at);
      return get(id);
    });
  }

  function completionOwner(todo) {
    return todo.externalLinks.find(link => COMPLETION_OWNERS.has(link.connector)) ?? null;
  }

  function assertCanChangeCompletion(todo, nextStatus) {
    const owner = completionOwner(todo);
    if (!owner || (todo.status !== 'done' && nextStatus !== 'done')) return;
    throw domainError(
      'SOURCE_OWNS_COMPLETION',
      `Complete this task in ${owner.connector === 'github' ? 'GitHub' : 'the Action Items sheet'}.`,
      { status: 409, details: { source: owner.connector, url: owner.externalUrl } },
    );
  }

  function applyStatusChange(todo, nextStatus, at, outcome) {
    const done = nextStatus === 'done';
    db.prepare(`
      UPDATE todos SET status = ?, completed_at = ?, outcome = ?, updated_at = ? WHERE id = ?
    `).run(
      nextStatus,
      done ? (todo.completedAt ?? at) : null,
      // Reopening clears the outcome: a task back on the board has not ended yet.
      done ? (outcome ?? todo.outcome ?? 'completed') : null,
      at,
      todo.id,
    );
    // Abandoning a repeating task ends the series. Rolling the next occurrence would
    // put back exactly the thing just declared not worth doing.
    if (done && (outcome ?? todo.outcome) === 'not_doing') return;
    if (
      nextStatus !== 'done' ||
      todo.status === 'done' ||
      !todo.recurrence ||
      !todo.dueDate ||
      todo.externalLinks.length > 0
    ) return;

    const nextId = requiredString(makeId(), 'id');
    insertTodo({
      title: todo.title,
      description: todo.description,
      area: todo.area,
      ventureTag: todo.ventureTag,
      status: 'todo',
      priority: todo.priority,
      dueDate: nextOccurrence({ dueDate: todo.dueDate, recurrence: todo.recurrence }),
      recurrence: todo.recurrence,
      snoozedUntil: null,
      position: todo.position,
    }, {
      id: nextId,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      archivedAt: null,
      deletedAt: null,
    });
    db.prepare(`
      INSERT INTO todo_tags (todo_id, tag_id, created_at)
      SELECT ?, tag_id, ? FROM todo_tags WHERE todo_id = ?
    `).run(nextId, at, todo.id);
  }

  function move(id, nextStatus, context, { outcome } = {}) {
    nextStatus = status(nextStatus);
    const ending = outcome === undefined ? undefined : completionOutcome(outcome);
    if (ending && nextStatus !== 'done') {
      throw domainError('INVALID_OUTCOME', 'Only a completed task has an outcome.');
    }
    const at = currentTimestamp();
    let todo;
    return mutate({
      action: 'todo.move',
      target: id,
      context,
      summary: () => ending === 'not_doing'
        ? `Marked todo "${todo.title}" as not doing`
        : `Moved todo "${todo.title}" to ${nextStatus}`,
      result: ending === 'not_doing' ? 'not_doing' : nextStatus,
    }, () => {
      todo = requireTodo(id);
      assertCanChangeCompletion(todo, nextStatus);
      applyStatusChange(todo, nextStatus, at, ending);
      return get(id);
    });
  }

  function complete(id, context, options = {}) {
    return move(id, 'done', context, options);
  }

  /** Declare a task finished without it having been done. */
  function abandon(id, context) {
    return move(id, 'done', context, { outcome: 'not_doing' });
  }

  function snooze(id, until, context) {
    const snoozedUntil = timestamp(until, 'until', { nullable: false });
    const at = currentTimestamp();
    let todo;
    return mutate({
      action: 'todo.snooze',
      target: id,
      context,
      summary: () => `Snoozed todo "${todo.title}" until ${snoozedUntil}`,
      result: 'snoozed',
    }, () => {
      todo = requireTodo(id);
      db.prepare('UPDATE todos SET snoozed_until = ?, updated_at = ? WHERE id = ?')
        .run(snoozedUntil, at, id);
      return get(id);
    });
  }

  function addNote(id, body, context) {
    body = requiredString(body, 'note body');
    const noteId = requiredString(makeId(), 'note id');
    const at = currentTimestamp();
    let todo;
    return mutate({
      action: 'todo.note.add',
      target: id,
      context,
      summary: () => `Added note to todo "${todo.title}"`,
      result: 'noted',
    }, () => {
      todo = requireTodo(id);
      db.prepare('INSERT INTO todo_notes (id, todo_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(noteId, id, body, at);
      return { id: noteId, body, createdAt: at };
    });
  }

  function relationPair(leftId, rightId) {
    leftId = requiredString(leftId, 'leftId');
    rightId = requiredString(rightId, 'rightId');
    if (leftId === rightId) {
      throw domainError('TODO_RELATION_SELF', 'A todo cannot be related to itself.', {
        details: { id: leftId },
      });
    }
    return leftId < rightId ? [leftId, rightId] : [rightId, leftId];
  }

  function linkRelated(leftId, rightId, context) {
    const pair = relationPair(leftId, rightId);
    const at = currentTimestamp();
    return mutate({
      action: 'todo.relation.link',
      target: pair.join(':'),
      context,
      summary: `Related todos ${pair[0]} and ${pair[1]}`,
      result: 'linked',
    }, () => {
      requireRow(pair[0]);
      requireRow(pair[1]);
      db.prepare(`
        INSERT OR IGNORE INTO todo_relations (left_todo_id, right_todo_id, created_at)
        VALUES (?, ?, ?)
      `).run(pair[0], pair[1], at);
      return get(leftId);
    });
  }

  function unlinkRelated(leftId, rightId, context) {
    const pair = relationPair(leftId, rightId);
    return mutate({
      action: 'todo.relation.unlink',
      target: pair.join(':'),
      context,
      summary: `Unrelated todos ${pair[0]} and ${pair[1]}`,
      result: 'unlinked',
    }, () => {
      requireRow(pair[0]);
      requireRow(pair[1]);
      db.prepare('DELETE FROM todo_relations WHERE left_todo_id = ? AND right_todo_id = ?')
        .run(pair[0], pair[1]);
      return get(leftId);
    });
  }

  function reorder({ status: requestedStatus, orderedIds, context } = {}) {
    const expectedStatus = status(requestedStatus);
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw domainError('INVALID_REORDER', 'orderedIds must be a non-empty array.');
    }
    const ids = orderedIds.map(id => requiredString(id, 'orderedIds'));
    if (new Set(ids).size !== ids.length) {
      throw domainError('INVALID_REORDER', 'orderedIds cannot contain duplicates.');
    }
    const at = currentTimestamp();
    return mutate({
      action: 'todo.reorder',
      target: expectedStatus,
      context,
      summary: `Reordered ${ids.length} ${expectedStatus} todos`,
      result: 'reordered',
    }, () => {
      const todos = ids.map(requireTodo);
      const invalid = todos.find(todo => todo.status !== expectedStatus || todo.deletedAt || todo.archivedAt);
      if (invalid) {
        throw domainError('REORDER_STATUS_MISMATCH', `Todo ${invalid.id} is not an active ${expectedStatus} todo.`, {
          details: { id: invalid.id, status: invalid.status },
        });
      }
      const updatePosition = db.prepare('UPDATE todos SET position = ?, updated_at = ? WHERE id = ?');
      ids.forEach((id, index) => updatePosition.run(index, at, id));
      return ids.map(get);
    });
  }

  function normalizeBulk({ ids, operation, value } = {}) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw domainError('INVALID_BULK', 'ids must be a non-empty array.');
    }
    const normalizedIds = ids.map(id => requiredString(id, 'ids'));
    if (new Set(normalizedIds).size !== normalizedIds.length) {
      throw domainError('INVALID_BULK', 'ids cannot contain duplicates.');
    }
    operation = requiredString(operation, 'operation');
    const allowed = new Set([
      'move', 'complete', 'notDoing', 'priority', 'snooze', 'archive', 'unarchive',
      'delete', 'softDelete', 'restore', 'addTag', 'removeTag',
    ]);
    if (!allowed.has(operation)) {
      throw domainError('INVALID_BULK_OPERATION', `Unsupported bulk operation: ${operation}.`, {
        details: { operation },
      });
    }
    if (operation === 'move') value = status(value);
    if (operation === 'complete' || operation === 'notDoing') value = 'done';
    if (operation === 'priority') value = priority(value);
    if (operation === 'snooze') value = timestamp(value, 'value', { nullable: false });
    if (operation === 'addTag' || operation === 'removeTag') value = requiredString(value, 'value');
    return { ids: normalizedIds, operation, value };
  }

  function bulk(input = {}) {
    const { ids, operation, value } = normalizeBulk(input);
    const at = currentTimestamp();
    return mutate({
      action: 'todo.bulk',
      target: `${ids.length} todos`,
      context: input.context,
      summary: `Applied ${operation} to ${ids.length} todos`,
      result: operation,
    }, () => {
      const todos = ids.map(requireTodo);
      if (operation === 'move' || operation === 'complete' || operation === 'notDoing') {
        for (const todo of todos) assertCanChangeCompletion(todo, value);
        const outcome = operation === 'notDoing' ? 'not_doing' : undefined;
        for (const todo of todos) applyStatusChange(todo, value, at, outcome);
      } else if (operation === 'priority') {
        const statement = db.prepare('UPDATE todos SET priority = ?, updated_at = ? WHERE id = ?');
        for (const todo of todos) statement.run(value, at, todo.id);
      } else if (operation === 'snooze') {
        const statement = db.prepare('UPDATE todos SET snoozed_until = ?, updated_at = ? WHERE id = ?');
        for (const todo of todos) statement.run(value, at, todo.id);
      } else if (operation === 'archive' || operation === 'unarchive') {
        const statement = db.prepare('UPDATE todos SET archived_at = ?, updated_at = ? WHERE id = ?');
        for (const todo of todos) statement.run(operation === 'archive' ? at : null, at, todo.id);
      } else if (operation === 'delete' || operation === 'softDelete' || operation === 'restore') {
        const statement = db.prepare('UPDATE todos SET deleted_at = ?, updated_at = ? WHERE id = ?');
        for (const todo of todos) statement.run(operation === 'restore' ? null : at, at, todo.id);
      } else if (operation === 'addTag') {
        for (const todo of todos) addTagToTodo(todo.id, value, at);
      } else if (operation === 'removeTag') {
        for (const todo of todos) removeTagFromTodo(todo.id, value);
      }
      return ids.map(get);
    });
  }

  function lifecycle(id, column, value, action, verb, result, context) {
    const todo = requireTodo(id);
    const at = currentTimestamp();
    return mutate({
      action,
      target: id,
      context,
      summary: `${verb} todo "${todo.title}"`,
      result,
    }, () => {
      db.prepare(`UPDATE todos SET ${column} = ?, updated_at = ? WHERE id = ?`).run(value(at), at, id);
      return get(id);
    });
  }

  const archive = (id, context) => lifecycle(
    id, 'archived_at', at => at, 'todo.archive', 'Archived', 'archived', context,
  );
  const unarchive = (id, context) => lifecycle(
    id, 'archived_at', () => null, 'todo.unarchive', 'Unarchived', 'unarchived', context,
  );
  const softDelete = (id, context) => lifecycle(
    id, 'deleted_at', at => at, 'todo.delete', 'Deleted', 'deleted', context,
  );
  const restore = (id, context) => lifecycle(
    id, 'deleted_at', () => null, 'todo.restore', 'Restored', 'restored', context,
  );

  function archiveCompleted({ olderThan, context } = {}) {
    const cutoff = timestamp(olderThan, 'olderThan', { nullable: false });
    const at = currentTimestamp();
    return mutate({
      action: 'todo.archive-completed',
      target: 'completed todos',
      context,
      summary: count => `Archived ${count} completed todo${count === 1 ? '' : 's'}`,
      result: 'archived',
    }, () => {
      const ids = db.prepare(`
        SELECT id FROM todos
        WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at < ?
          AND archived_at IS NULL AND deleted_at IS NULL
        ORDER BY id
      `).all(cutoff).map(row => row.id);
      const statement = db.prepare('UPDATE todos SET archived_at = ?, updated_at = ? WHERE id = ?');
      for (const id of ids) statement.run(at, at, id);
      return ids.length;
    });
  }

  /** The configured venture tags, in display order: [{ name, color }]. */
  function listVentureTags() {
    const row = db.prepare('SELECT value_json FROM todo_preferences WHERE key = ?').get(VENTURE_TAGS_KEY);
    const parsed = row ? jsonFromStorage(row.value_json) : [];
    return (Array.isArray(parsed) ? parsed : [])
      .filter(tag => tag && typeof tag.name === 'string' && tag.name.trim())
      .map(tag => ({ name: tag.name.trim(), color: COLOR_RE.test(tag.color ?? '') ? tag.color : null }));
  }

  function ventureTagNames() {
    return listVentureTags().map(tag => tag.name);
  }

  /**
   * Replace the venture tag list. Each entry is { name, color?, previousName? };
   * `previousName` renames a tag and every task carrying it. A tag left out is
   * removed, which is refused while any task (not in the recycle bin) still uses it.
   */
  function saveVentureTags(input, context) {
    if (!Array.isArray(input)) throw domainError('INVALID_VENTURE_TAGS', 'Venture tags must be an array.');
    const current = ventureTagNames();
    const next = input.map((entry, index) => {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      if (!name || name.length > MAX_VENTURE_TAG_LENGTH) {
        throw domainError('INVALID_VENTURE_TAGS', `Tag ${index + 1} needs a name of 1-${MAX_VENTURE_TAG_LENGTH} characters.`);
      }
      if (entry.color != null && entry.color !== '' && !COLOR_RE.test(entry.color)) {
        throw domainError('INVALID_VENTURE_TAGS', `Tag "${name}" has an invalid color; use #rrggbb.`);
      }
      const previousName = typeof entry.previousName === 'string' && current.includes(entry.previousName)
        ? entry.previousName : null;
      return { name, color: entry.color || null, previousName };
    });
    const lower = next.map(tag => tag.name.toLowerCase());
    if (new Set(lower).size !== lower.length) {
      throw domainError('INVALID_VENTURE_TAGS', 'Venture tag names must be unique.');
    }
    const sources = next.map(tag => tag.previousName).filter(Boolean);
    if (new Set(sources).size !== sources.length) {
      throw domainError('INVALID_VENTURE_TAGS', 'A tag can only be renamed to one new name.');
    }
    const kept = new Set(next.map(tag => tag.previousName ?? tag.name));
    const removed = current.filter(name => !kept.has(name));
    const at = currentTimestamp();
    return mutate({
      action: 'todo.venture_tags.update',
      target: 'todo-venture-tags',
      context,
      summary: 'Updated venture tags',
      result: 'updated',
    }, () => {
      for (const name of removed) {
        const { n } = db.prepare(
          'SELECT count(*) AS n FROM todos WHERE venture_tag = ? AND deleted_at IS NULL',
        ).get(name);
        if (n > 0) {
          throw domainError('VENTURE_TAG_IN_USE', `${n} task(s) still use "${name}". Rename it, or move those tasks first.`, {
            status: 409, details: { name, count: n },
          });
        }
      }
      // Every rename is applied against the tags the tasks had BEFORE this save,
      // in one statement. Renaming one at a time would chain: a swap (A->B, B->A)
      // would put everything on A, and A->B with B->C would carry A's tasks to C.
      const renames = next.filter(tag => tag.previousName && tag.previousName !== tag.name);
      if (renames.length) {
        const cases = renames.map(() => 'WHEN ? THEN ?').join(' ');
        db.prepare(`
          UPDATE todos SET venture_tag = CASE venture_tag ${cases} END, updated_at = ?
          WHERE venture_tag IN (${renames.map(() => '?').join(', ')})
        `).run(
          ...renames.flatMap(tag => [tag.previousName, tag.name]),
          at,
          ...renames.map(tag => tag.previousName),
        );
      }
      db.prepare(`
        INSERT INTO todo_preferences (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(VENTURE_TAGS_KEY, JSON.stringify(next.map(({ name, color }) => ({ name, color }))), at);
      return listVentureTags();
    });
  }

  function getPreferences() {
    const preferences = { ...DEFAULT_PREFERENCES };
    for (const row of db.prepare('SELECT key, value_json FROM todo_preferences ORDER BY key').all()) {
      if (!PREFERENCE_FIELDS.has(row.key)) continue;
      preferences[row.key] = jsonFromStorage(row.value_json);
    }
    return preferences;
  }

  function preferenceTimeOfDay(value, field) {
    if (value == null || value === '') return null;
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value).trim());
    if (!match) {
      throw domainError('INVALID_PREFERENCE', `${field} must be a 24-hour HH:MM time or null.`, {
        details: { field },
      });
    }
    return `${match[1]}:${match[2]}`;
  }

  function preferenceDays(value, field) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw domainError('INVALID_PREFERENCE', `${field} must be a positive integer or null.`, {
        details: { field },
      });
    }
    return value;
  }

  function updatePreferences(patch = {}, context) {
    if (!patch || Array.isArray(patch) || typeof patch !== 'object') {
      throw domainError('INVALID_PREFERENCES', 'Preference patch must be an object.');
    }
    const unknown = Object.keys(patch).filter(key => !PREFERENCE_FIELDS.has(key));
    if (unknown.length) {
      throw domainError('UNKNOWN_PREFERENCE', `Unknown todo preference: ${unknown.join(', ')}.`, {
        details: { fields: unknown },
      });
    }
    const normalized = Object.fromEntries(Object.entries(patch).map(([key, value]) => [
      key,
      key === 'autoArchiveAt' ? preferenceTimeOfDay(value, key) : preferenceDays(value, key),
    ]));
    const at = currentTimestamp();
    return mutate({
      action: 'todo.preferences.update',
      target: 'todo-preferences',
      context,
      summary: 'Updated todo maintenance preferences',
      result: 'updated',
    }, () => {
      const statement = db.prepare(`
        INSERT INTO todo_preferences (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `);
      for (const [key, value] of Object.entries(normalized)) {
        statement.run(key, JSON.stringify(value), at);
      }
      return getPreferences();
    });
  }

  function purgeDeletedAfterBackup({ olderThan, eligibleIds, context } = {}) {
    const cutoff = timestamp(olderThan, 'olderThan', { nullable: false });
    if (eligibleIds !== undefined && !Array.isArray(eligibleIds)) {
      throw domainError('INVALID_PURGE_SNAPSHOT', 'eligibleIds must be an array when supplied.');
    }
    const snapshotIds = eligibleIds?.map(id => requiredString(id, 'eligibleIds'));
    return mutate({
      action: 'todo.purge',
      target: 'deleted todos',
      context,
      summary: count => `Purged ${count} deleted todo${count === 1 ? '' : 's'} after backup`,
      result: 'purged',
    }, () => {
      const ids = snapshotIds ?? db.prepare(`
        SELECT id FROM todos WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY id
      `).all(cutoff).map(row => row.id);
      const statement = db.prepare(`
        DELETE FROM todos WHERE id = ? AND deleted_at IS NOT NULL AND deleted_at < ?
      `);
      let purged = 0;
      for (const id of ids) purged += Number(statement.run(id, cutoff).changes);
      return purged;
    });
  }

  function attachExternalLink(id, link = {}, context) {
    const connector = requiredString(link.connector, 'connector').toLowerCase();
    const externalId = requiredString(link.externalId, 'externalId');
    const at = currentTimestamp();
    const linkId = requiredString(link.id ?? makeId(), 'link id');
    const externalUrl = optionalString(link.externalUrl, 'externalUrl');
    const sourceStatus = optionalString(link.sourceStatus, 'sourceStatus');
    const lastObservedAt = timestamp(link.lastObservedAt ?? null, 'lastObservedAt');
    const lastSyncedAt = timestamp(link.lastSyncedAt ?? null, 'lastSyncedAt');
    const missingAt = timestamp(link.missingAt ?? null, 'missingAt');
    let todo;
    try {
      return mutate({
        action: 'todo.external-link.attach',
        target: id,
        context,
        summary: () => `Linked todo "${todo.title}" to ${connector}`,
        result: 'linked',
      }, () => {
        todo = requireTodo(id);
        if (COMPLETION_OWNERS.has(connector)) {
          const owner = completionOwner(todo);
          if (owner) {
            throw domainError(
              'EXTERNAL_COMPLETION_OWNER_EXISTS',
              `This task already gets completion state from ${owner.connector}.`,
              { status: 409, details: { source: owner.connector, url: owner.externalUrl } },
            );
          }
        }
        db.prepare(`
          INSERT INTO external_links (
            id, todo_id, connector, external_id, external_url, source_status,
            source_snapshot, last_sync_snapshot, initial_status_seeded,
            last_observed_at, last_synced_at, missing_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          linkId,
          id,
          connector,
          externalId,
          externalUrl,
          sourceStatus,
          jsonForStorage(link.sourceSnapshot),
          jsonForStorage(link.lastSyncSnapshot),
          link.initialStatusSeeded ? 1 : 0,
          lastObservedAt,
          lastSyncedAt,
          missingAt,
          at,
          at,
        );
        return get(id);
      });
    } catch (error) {
      if (/UNIQUE constraint failed: external_links\.connector, external_links\.external_id/.test(error.message)) {
        throw domainError('EXTERNAL_LINK_EXISTS', 'That external record is already linked.', {
          status: 409,
          details: { connector, externalId },
        });
      }
      throw error;
    }
  }

  function detachExternalLink(id, connector, context) {
    const todo = requireTodo(id);
    connector = requiredString(connector, 'connector').toLowerCase();
    return mutate({
      action: 'todo.external-link.detach',
      target: id,
      context,
      summary: `Unlinked todo "${todo.title}" from ${connector}`,
      result: 'unlinked',
    }, () => {
      db.prepare('DELETE FROM external_links WHERE todo_id = ? AND connector = ?').run(id, connector);
      return get(id);
    });
  }

  function observationLink(observation) {
    const taskId = requiredString(observation.taskId, 'taskId');
    requireRow(taskId);
    const clauses = ['todo_id = ?'];
    const parameters = [taskId];
    if (observation.connector) {
      clauses.push('connector = ?');
      parameters.push(requiredString(observation.connector, 'connector').toLowerCase());
    }
    if (observation.externalId) {
      clauses.push('external_id = ?');
      parameters.push(requiredString(observation.externalId, 'externalId'));
    }
    const links = db.prepare(`
      SELECT * FROM external_links WHERE ${clauses.join(' AND ')} ORDER BY id
    `).all(...parameters);
    const owners = links.filter(link => COMPLETION_OWNERS.has(link.connector));
    const link = owners.length === 1 ? owners[0] : links.length === 1 ? links[0] : null;
    if (!link) {
      throw domainError('EXTERNAL_LINK_NOT_FOUND', 'A unique external link was not found for this observation.', {
        status: 404,
        details: { taskId },
      });
    }
    return link;
  }

  function applyExternalObservation(observation = {}, context) {
    if (typeof observation.completed !== 'boolean') {
      throw domainError('INVALID_EXTERNAL_OBSERVATION', 'completed must be a boolean.', {
        details: { field: 'completed' },
      });
    }
    const link = observationLink(observation);
    const todo = get(link.todo_id);
    const ownsCompletion = COMPLETION_OWNERS.has(link.connector);
    const at = currentTimestamp();
    const observedAt = timestamp(observation.observedAt ?? at, 'observedAt', { nullable: false });
    const lastSyncedAt = observation.lastSyncedAt === undefined
      ? link.last_synced_at
      : timestamp(observation.lastSyncedAt, 'lastSyncedAt');
    const priorCompleted = sourceWasCompleted(link);
    const firstObservation = !Boolean(link.initial_status_seeded);
    let nextStatus = todo.status;
    let nextCompletedAt = todo.completedAt;
    if (ownsCompletion && observation.completed) {
      nextStatus = 'done';
      nextCompletedAt = todo.status === 'done' ? todo.completedAt : observedAt;
    } else if (ownsCompletion && priorCompleted) {
      nextStatus = 'todo';
      nextCompletedAt = null;
    } else if (ownsCompletion && firstObservation) {
      const seed = status(observation.initialStatus ?? todo.status);
      if (seed === 'done') {
        throw domainError('INVALID_INITIAL_STATUS', 'An open external task can seed only todo or doing.');
      }
      nextStatus = seed;
      nextCompletedAt = null;
    }
    const sourceStatus = optionalString(
      observation.sourceStatus ?? (observation.completed ? 'completed' : 'open'),
      'sourceStatus',
    );
    const rawSourceSnapshot = observation.sourceSnapshot === undefined
      ? observationMetadata(link.source_snapshot).sourceSnapshot
      : observation.sourceSnapshot;
    const snapshotValue = observationSnapshotForStorage(rawSourceSnapshot ?? null, observation.completed);
    const syncSnapshotValue = observation.lastSyncSnapshot === undefined
      ? link.last_sync_snapshot
      : jsonForStorage(observation.lastSyncSnapshot);
    const externalUrl = observation.externalUrl === undefined
      ? link.external_url
      : optionalString(observation.externalUrl, 'externalUrl');
    const missingAt = observation.missing === undefined
      ? link.missing_at
      : observation.missing
        ? timestamp(observation.missingAt ?? observedAt, 'missingAt', { nullable: false })
        : null;
    const nextTitle = observation.title === undefined
      ? todo.title
      : requiredString(observation.title, 'title');

    return mutate({
      action: 'todo.external.observe',
      target: todo.id,
      context,
      summary: `Observed ${link.connector} state for todo "${todo.title}"`,
      result: observation.completed ? 'completed' : priorCompleted ? 'reopened' : 'open',
    }, () => {
      db.prepare(`
        UPDATE external_links SET
          external_url = ?, source_status = ?, source_snapshot = ?, last_sync_snapshot = ?,
          initial_status_seeded = 1, last_observed_at = ?, last_synced_at = ?,
          missing_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        externalUrl,
        sourceStatus,
        snapshotValue,
        syncSnapshotValue,
        observedAt,
        lastSyncedAt,
        missingAt,
        at,
        link.id,
      );
      if (
        nextTitle !== todo.title ||
        nextStatus !== todo.status ||
        nextCompletedAt !== todo.completedAt
      ) {
        db.prepare(`
          UPDATE todos SET title = ?, status = ?, completed_at = ?, updated_at = ? WHERE id = ?
        `).run(nextTitle, nextStatus, nextCompletedAt, at, todo.id);
      }
      return get(todo.id);
    });
  }

  return {
    list,
    get,
    create,
    importRecord,
    validateUpdate,
    update,
    move,
    complete,
    abandon,
    snooze,
    addNote,
    linkRelated,
    unlinkRelated,
    reorder,
    bulk,
    archive,
    unarchive,
    softDelete,
    restore,
    archiveCompleted,
    getPreferences,
    updatePreferences,
    listVentureTags,
    saveVentureTags,
    purgeDeletedAfterBackup,
    attachExternalLink,
    detachExternalLink,
    applyExternalObservation,
  };
}

export { TodoDomainError } from './errors.mjs';
