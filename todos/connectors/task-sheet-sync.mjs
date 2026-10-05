import { createHash, randomUUID } from 'node:crypto';

import { TodoDomainError } from '../errors.mjs';
import { withTodoTransaction } from '../db.mjs';
import {
  ACTION_ITEMS,
  buildCreationRow,
  buildSchemaBootstrap,
  eligibleActionItem,
  isOwnerAssignee,
  parseActionItemRow,
  resolveActionItemSchema,
  validateStableIds,
} from './task-sheet-policy.mjs';

const SHARED_FIELDS = ['title', 'priority', 'dueDate', 'notes', 'tag'];
const NOTE_MARKER = /\n?\u2063\u2063[\u200B\u200C]{64}\u2064/g;

function invisibleNoteMarker(digest) {
  const bits = [...digest].map(hex => Number.parseInt(hex, 16).toString(2).padStart(4, '0')).join('');
  return `\u2063\u2063${[...bits].map(bit => bit === '1' ? '\u200C' : '\u200B').join('')}\u2064`;
}
const MAX_OUTBOX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60 * 1000;

function cleanNotes(value) {
  return String(value ?? '').replace(NOTE_MARKER, '').trim();
}

function remoteShared(row) {
  return { title: row.title, priority: row.priority, dueDate: row.dueDate, notes: cleanNotes(row.notes), tag: row.tag };
}

function localShared(task) {
  return {
    title: task.title,
    priority: task.priority,
    dueDate: task.dueDate,
    notes: [task.description, ...task.notes.map(note => note.body)].filter(Boolean).join('\n\n'),
    tag: task.ventureTag,
  };
}

function sourceStatus(row) {
  return row.status || 'Not Started';
}

function initialStatus(row) {
  return row.status === 'In Progress' ? 'doing' : 'todo';
}

function rowValues(row) {
  return [row.title, row.who, row.priority, row.status, row.dueDate ?? '', row.notes, row.tag, row.totemId];
}

function columnLetter(index) {
  let value = index + 1;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function same(left, right) {
  return (left ?? null) === (right ?? null);
}

export function classifySheetFields(local, previousRemote, currentRemote) {
  const result = { pull: {}, push: {}, conflicts: [] };
  for (const field of SHARED_FIELDS) {
    const remoteChanged = !same(previousRemote?.[field], currentRemote?.[field]);
    const localChanged = !same(previousRemote?.[field], local?.[field]);
    if (remoteChanged && !localChanged) result.pull[field] = currentRemote[field];
    else if (!remoteChanged && localChanged) result.push[field] = local[field];
    else if (remoteChanged && localChanged && !same(currentRemote[field], local[field])) {
      result.conflicts.push({ field, local: local[field], remote: currentRemote[field], previous: previousRemote?.[field] ?? null });
    }
  }
  return result;
}

/**
 * Health for a sheet connector that is not configured yet. Names exactly what is
 * missing, and counts the writes waiting in the outbox: they are kept, untouched,
 * and drain once the connector is configured — nothing here deletes them.
 */
export function unconfiguredTaskSheetHealth(db, missing = []) {
  const queued = Number(db.prepare(`
    SELECT COUNT(*) AS n FROM sync_outbox
    WHERE connector = 'sheet' AND status IN ('pending', 'retry', 'leased', 'conflict')
  `).get().n);
  const needs = missing.length ? `needs ${missing.join(', ')}` : 'not configured';
  return {
    status: 'unconfigured',
    missing,
    queued,
    conflicts: [],
    lastSuccessAt: null,
    lastError: `Google Sheet task sync ${needs}.${queued ? ` ${queued} queued write(s) are kept and will send once it is configured.` : ''}`,
    recovery: missing.length ? `Set ${missing.join(', ')} in .env or Settings -> Integrations, then restart Totem.` : null,
  };
}

export function createTaskSheetConnector({
  db,
  service,
  client,
  now = () => new Date().toISOString(),
  workerId,
  actionLog,
  makeId = randomUUID,
  spreadsheetId = ACTION_ITEMS.spreadsheetId,
} = {}) {
  if (!db || !service || !client || !workerId || !actionLog?.record) {
    throw new TypeError('createTaskSheetConnector requires db, service, client, workerId, and actionLog');
  }
  if (!spreadsheetId) throw new Error('Task sheet connector needs a spreadsheet id (TASK_SHEET_ID)');
  if (spreadsheetId !== ACTION_ITEMS.spreadsheetId) throw new Error('Task sheet connector refuses a spreadsheet other than the configured one');

  function record(action, target, summary, detail, status = 'ok', error = null) {
    actionLog.record({ action, actor: 'job', target, status, summary, why: summary, detail, error });
  }

  function ensureState() {
    const at = now();
    db.prepare(`
      INSERT OR IGNORE INTO connector_state (connector, settings_json, created_at, updated_at)
      VALUES ('sheet', ?, ?, ?)
    `).run(JSON.stringify({ spreadsheetId, tab: ACTION_ITEMS.tab }), at, at);
    return db.prepare("SELECT * FROM connector_state WHERE connector = 'sheet'").get();
  }

  function healthSuccess() {
    const at = now();
    ensureState();
    db.prepare("UPDATE connector_state SET last_success_at = ?, last_error = NULL, updated_at = ? WHERE connector = 'sheet'").run(at, at);
  }

  function healthError(error) {
    const at = now();
    ensureState();
    db.prepare("UPDATE connector_state SET last_error = ?, updated_at = ? WHERE connector = 'sheet'").run(String(error.message ?? error), at);
    record('sheet.sync.error', 'Action Items', 'Action Items sync failed', null, 'error', String(error.message ?? error));
  }

  async function inspect({ bootstrap = false } = {}) {
    const metadata = await client.getMetadata(spreadsheetId);
    const range = bootstrap ? `'${ACTION_ITEMS.tab}'!B4:G4` : `'${ACTION_ITEMS.tab}'!B4:I`;
    const values = (await client.readRange(spreadsheetId, range)).values ?? [];
    if (bootstrap) return { metadata, headerValues: values[0] ?? [] };
    const schema = resolveActionItemSchema({ metadata, headerValues: values[0] ?? [] });
    const rows = values.slice(1).map((values, index) => ({
      ...parseActionItemRow({ headers: schema, values }),
      rowNumber: schema.dataStartRow + index,
      rawValues: values,
    }));
    validateStableIds(rows);
    return { metadata, schema, rows };
  }

  async function readRow(rowNumber, schema) {
    const response = await client.readRange(spreadsheetId, `'${ACTION_ITEMS.tab}'!B${rowNumber}:I${rowNumber}`);
    const values = response.values?.[0];
    if (!values) return null;
    return { ...parseActionItemRow({ headers: schema, values }), rowNumber, rawValues: values };
  }

  function linkedById(id) {
    return db.prepare("SELECT todo_id FROM external_links WHERE connector = 'sheet' AND external_id = ?").get(id);
  }

  function sheetLink(taskId) {
    return db.prepare("SELECT * FROM external_links WHERE connector = 'sheet' AND todo_id = ?").get(taskId);
  }

  function observe(taskId, row, { lastSyncSnapshot, title = true } = {}) {
    return service.applyExternalObservation({
      taskId,
      connector: 'sheet',
      externalId: row.totemId,
      completed: row.status === 'Done',
      initialStatus: initialStatus(row),
      ...(title ? { title: row.title } : {}),
      sourceStatus: sourceStatus(row),
      sourceSnapshot: { ...remoteShared(row), who: row.who, status: row.status, rowNumber: row.rowNumber },
      ...(lastSyncSnapshot === undefined ? {} : { lastSyncSnapshot }),
      externalUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${ACTION_ITEMS.sheetId}&range=B${row.rowNumber}`,
      observedAt: now(),
      lastSyncedAt: now(),
      missing: false,
    }, { actor: 'job', reason: 'Observed authoritative Action Items row' });
  }

  function attachOrImport(row) {
    const existingLink = linkedById(row.totemId);
    if (existingLink) return observe(existingLink.todo_id, row);
    let task = service.get(row.totemId);
    if (!task) {
      task = service.importRecord({
        id: row.totemId,
        title: row.title,
        description: cleanNotes(row.notes),
        area: 'Ventures',
        ventureTag: row.tag,
        status: row.status === 'Done' ? 'done' : initialStatus(row),
        priority: row.priority,
        dueDate: row.dueDate,
      }, {
        source: 'sheet', externalId: row.totemId, sourceSnapshot: remoteShared(row),
      }, { actor: 'job', reason: 'Imported eligible Action Items row' });
    }
    if (!sheetLink(task.id)) service.attachExternalLink(task.id, {
      connector: 'sheet', externalId: row.totemId,
      externalUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=0&range=B${row.rowNumber}`,
      sourceStatus: row.status, sourceSnapshot: remoteShared(row), lastSyncSnapshot: remoteShared(row),
      initialStatusSeeded: true, lastObservedAt: now(), lastSyncedAt: now(),
    }, { actor: 'job', reason: 'Linked Action Items row by stable Totem ID' });
    return observe(task.id, row, { lastSyncSnapshot: remoteShared(row) });
  }

  function fieldValue(field, value) {
    if (field === 'priority') return { 4: 'High', 3: 'Medium', 2: 'Low', 1: 'Low' }[value];
    return value ?? '';
  }

  async function writeFields(rowNumber, schema, fields) {
    const data = Object.entries(fields).map(([field, value]) => {
      const absoluteColumn = schema.firstColumnIndex + schema.columns[field];
      const letter = columnLetter(absoluteColumn);
      return { range: `'${ACTION_ITEMS.tab}'!${letter}${rowNumber}:${letter}${rowNumber}`, values: [[fieldValue(field, value)]] };
    });
    if (data.length) await client.batchUpdateValues(spreadsheetId, data);
  }

  function localPatch(fields) {
    const patch = {};
    if (Object.hasOwn(fields, 'title')) patch.title = fields.title;
    if (Object.hasOwn(fields, 'priority')) patch.priority = fields.priority;
    if (Object.hasOwn(fields, 'dueDate')) patch.dueDate = fields.dueDate;
    if (Object.hasOwn(fields, 'notes')) patch.description = fields.notes;
    if (Object.hasOwn(fields, 'tag')) patch.ventureTag = fields.tag;
    return patch;
  }

  function storeConflicts(taskId, conflicts) {
    const at = now();
    db.prepare("DELETE FROM sync_outbox WHERE connector = 'sheet' AND todo_id = ? AND status = 'conflict'").run(taskId);
    for (const conflict of conflicts) {
      db.prepare(`
        INSERT INTO sync_outbox (
          id, todo_id, connector, operation, payload, idempotency_key, status,
          conflict_payload, created_at, updated_at
        ) VALUES (?, ?, 'sheet', 'update', '{}', ?, 'conflict', ?, ?, ?)
      `).run(makeId(), taskId, `conflict:${taskId}:${conflict.field}:${now()}`, JSON.stringify(conflict), at, at);
      record('sheet.sync.conflict', taskId, `Action Items conflict on ${conflict.field}`, conflict, 'error');
    }
  }

  async function reconcileLinked(taskId, row, schema) {
    let task = service.get(taskId);
    const link = task.externalLinks.find(item => item.connector === 'sheet');
    if (!isOwnerAssignee(row.who)) {
      if (!task.archivedAt) task = service.archive(taskId, { actor: 'job', reason: 'Action item reassigned away from the owner' });
      observe(taskId, row, { title: false });
      return task;
    }
    const local = localShared(task);
    const remote = remoteShared(row);
    const previous = link.lastSyncSnapshot ?? remote;
    const classified = classifySheetFields(local, previous, remote);
    if (Object.keys(classified.pull).length) {
      task = service.update(taskId, localPatch(classified.pull), { actor: 'job', reason: 'Pulled Action Items field changes' });
    }
    if (Object.keys(classified.push).length) {
      await writeFields(row.rowNumber, schema, classified.push);
      Object.assign(remote, classified.push);
      record('sheet.row.update', taskId, 'Updated shared Action Items fields', { fields: Object.keys(classified.push) });
    }
    storeConflicts(taskId, classified.conflicts);
    return observe(taskId, { ...row, ...remote, notes: remote.notes }, {
      title: !classified.conflicts.some(conflict => conflict.field === 'title'),
      ...(classified.conflicts.length ? {} : { lastSyncSnapshot: remote }),
    });
  }

  async function claimBlankRow(candidate, schema) {
    const id = String(makeId());
    const fresh = await readRow(candidate.rowNumber, schema);
    if (!fresh || fresh.totemId || JSON.stringify(fresh.rawValues) !== JSON.stringify(candidate.rawValues)) return null;
    const column = columnLetter(schema.firstColumnIndex + schema.columns.totemId);
    try {
      await client.batchUpdateValues(spreadsheetId, [{
        range: `'${ACTION_ITEMS.tab}'!${column}${candidate.rowNumber}:${column}${candidate.rowNumber}`,
        values: [[id]],
      }]);
    } catch (error) {
      const recovered = await readRow(candidate.rowNumber, schema);
      if (recovered?.totemId !== id) throw error;
    }
    const claimed = await readRow(candidate.rowNumber, schema);
    if (claimed?.totemId !== id) throw new Error('Action Items row claim was not durable');
    return claimed;
  }

  async function reconcile() {
    let imported = 0;
    let refreshedCount = 0;
    let pullError = null;
    try {
      const { schema, rows } = await inspect();
      for (const candidate of rows) {
        if (!candidate.totemId && eligibleActionItem(candidate)) {
          const claimed = await claimBlankRow(candidate, schema);
          if (claimed) { attachOrImport(claimed); imported += 1; }
        }
      }
      const refreshed = await inspect();
      const byId = new Map(refreshed.rows.filter(row => row.totemId).map(row => [row.totemId, row]));
      for (const row of refreshed.rows) {
        if (row.totemId && !linkedById(row.totemId) && eligibleActionItem(row)) {
          attachOrImport(row); imported += 1;
        }
      }
      const links = db.prepare("SELECT todo_id, external_id FROM external_links WHERE connector = 'sheet' ORDER BY id").all();
      refreshedCount = links.length;
      for (const link of links) {
        const row = byId.get(link.external_id);
        if (!row) {
          const task = service.get(link.todo_id);
          service.applyExternalObservation({
            taskId: task.id, connector: 'sheet', completed: task.status === 'done',
            sourceStatus: task.externalLinks.find(item => item.connector === 'sheet').sourceStatus,
            observedAt: now(), missing: true, missingAt: now(),
          }, { actor: 'job', reason: 'Action Items stable ID is missing' });
          record('sheet.row.missing', task.id, 'Action Items row is missing', { totemId: link.external_id }, 'error');
          continue;
        }
        await reconcileLinked(link.todo_id, row, refreshed.schema);
      }
    } catch (error) {
      pullError = error;
      healthError(error);
    }
    const outbox = await drainOutbox();
    if (!pullError && outbox.exhausted === 0) healthSuccess();
    return { imported, refreshed: refreshedCount, pullError: pullError?.message ?? null, outbox };
  }

  async function share(taskId, callerContext, options = {}) {
    let task = service.get(taskId);
    if (!task) throw new TodoDomainError('TODO_NOT_FOUND', 'Todo not found.', { status: 404 });
    if (sheetLink(taskId)) return task;
    if (task.area !== 'Ventures') {
      if (!options.ventureTag) throw new TodoDomainError('VENTURE_TAG_REQUIRED', 'Sharing to Action Items requires a venture tag.');
      task = service.update(taskId, { area: 'Ventures', ventureTag: options.ventureTag }, callerContext);
    }
    const { rows } = await inspect();
    const creation = buildCreationRow({ ...task, ...options, notes: localShared(task).notes, totemId: task.id });
    const existing = rows.find(row => row.totemId === task.id);
    if (existing) return attachOrImport(existing);
    const outboxId = enqueueOutbox(task.id, 'create', { creation }, callerContext);
    await drainOutbox();
    return finishOutbox(outboxId, task.id);
  }

  async function create(input, callerContext) {
    const task = service.create({ ...input, area: 'Ventures', ventureTag: input.ventureTag }, callerContext);
    return share(task.id, callerContext, input);
  }

  async function updateLinked(taskId, patch, callerContext) {
    service.update(taskId, patch, callerContext);
    const link = sheetLink(taskId);
    if (!link) throw new Error('Action Items row is missing');
    const task = service.get(taskId);
    const shared = localShared(task);
    const fields = {};
    for (const [patchField, sharedField] of [
      ['title', 'title'], ['priority', 'priority'], ['dueDate', 'dueDate'], ['ventureTag', 'tag'],
    ]) if (Object.hasOwn(patch, patchField)) fields[sharedField] = shared[sharedField];
    const outboxId = enqueueOutbox(taskId, 'update', { fields, base: link.last_sync_snapshot ? JSON.parse(link.last_sync_snapshot) : null }, callerContext);
    await drainOutbox();
    const row = db.prepare('SELECT status, last_error, conflict_payload FROM sync_outbox WHERE id = ?').get(outboxId);
    if (row?.status === 'completed') return service.get(taskId);
    if (row?.status === 'conflict') throw new TodoDomainError('SHEET_SYNC_CONFLICT', 'The Action Items row changed in the meeting.', { status: 409, details: JSON.parse(row.conflict_payload) });
    throw new Error(row?.last_error || 'Action Items update queued for retry');
  }

  function enqueueOutbox(taskId, operation, payload, callerContext) {
    const id = String(makeId());
    const at = now();
    db.prepare(`
      INSERT INTO sync_outbox (
        id, todo_id, connector, operation, payload, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, 'sheet', ?, ?, ?, ?, ?)
    `).run(id, taskId, operation, JSON.stringify(payload), `${operation}:${taskId}:${callerContext?.correlationId ?? id}`, at, at);
    return id;
  }

  function claimOutbox() {
    return withTodoTransaction(db, () => {
      const at = now();
      db.prepare(`
        UPDATE sync_outbox SET status = 'retry', lease_owner = NULL, lease_expires_at = NULL,
          next_attempt_at = COALESCE(next_attempt_at, ?), updated_at = ?
        WHERE connector = 'sheet' AND status = 'leased' AND lease_expires_at <= ?
      `).run(at, at, at);
      const row = db.prepare(`
        SELECT * FROM sync_outbox WHERE connector = 'sheet' AND status IN ('pending', 'retry')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at, id LIMIT 1
      `).get(at);
      if (!row) return null;
      const expires = new Date(Date.parse(at) + LEASE_MS).toISOString();
      db.prepare(`
        UPDATE sync_outbox SET status = 'leased', attempts = attempts + 1,
          lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?
      `).run(workerId, expires, at, row.id);
      return { ...row, attempts: Number(row.attempts) + 1 };
    });
  }

  async function performOutbox(row) {
    const payload = JSON.parse(row.payload);
    if (row.operation === 'create') {
      let inspected = await inspect();
      let remote = inspected.rows.find(item => item.totemId === row.todo_id);
      if (!remote) {
        const rowNumber = inspected.schema.dataStartRow + inspected.rows.length;
        try {
          await client.batchUpdateValues(spreadsheetId, [{
            range: `'${ACTION_ITEMS.tab}'!B${rowNumber}:I${rowNumber}`,
            values: [rowValues(payload.creation)],
          }]);
        } catch (error) {
          inspected = await inspect();
          remote = inspected.rows.find(item => item.totemId === row.todo_id);
          if (!remote) throw error;
        }
        remote ??= (await inspect()).rows.find(item => item.totemId === row.todo_id);
        if (!remote) throw new Error('Created Action Items row could not be recovered by Totem ID');
        record('sheet.row.create', row.todo_id, 'Created shared Action Items row', { rowNumber });
      }
      attachOrImport(remote);
      return { conflicts: [] };
    }
    if (row.operation === 'append-note') {
      const inspected = await inspect();
      const link = sheetLink(row.todo_id);
      let remote = inspected.rows.find(item => item.totemId === link?.external_id);
      if (!remote) throw new Error('Action Items row is missing');
      if (!remote.notes.includes(payload.marker)) {
        const notes = [cleanNotes(remote.notes), payload.body, payload.marker].filter(Boolean).join('\n\n');
        try { await writeFields(remote.rowNumber, inspected.schema, { notes }); }
        catch (error) {
          remote = await readRow(remote.rowNumber, inspected.schema);
          if (!remote?.notes.includes(payload.marker)) throw error;
        }
        record('sheet.row.append-note', row.todo_id, 'Appended a note to Action Items', { noteId: payload.noteId });
      }
      const refreshed = await readRow(remote.rowNumber, inspected.schema);
      let previous = {};
      try { previous = JSON.parse(link.last_sync_snapshot || '{}'); } catch { previous = {}; }
      observe(row.todo_id, refreshed, {
        title: false,
        lastSyncSnapshot: { ...previous, notes: remoteShared(refreshed).notes },
      });
      return { conflicts: [] };
    }
    if (row.operation !== 'update') throw new Error(`Unsupported Sheet outbox operation: ${row.operation}`);
    const inspected = await inspect();
    const link = sheetLink(row.todo_id);
    const current = inspected.rows.find(item => item.totemId === link?.external_id);
    if (!current) throw new Error('Action Items row is missing');
    const remote = remoteShared(current);
    const conflicts = [];
    for (const [field, desired] of Object.entries(payload.fields ?? {})) {
      const previous = payload.base?.[field];
      if (!same(remote[field], previous) && !same(remote[field], desired)) {
        conflicts.push({ field, local: desired, remote: remote[field], previous: previous ?? null });
      }
    }
    if (conflicts.length) return { conflicts };
    await writeFields(current.rowNumber, inspected.schema, payload.fields ?? {});
    Object.assign(remote, payload.fields ?? {});
    const updated = { ...current, ...remote };
    observe(row.todo_id, updated, {
      title: Object.hasOwn(payload.fields ?? {}, 'title'),
      lastSyncSnapshot: { ...(payload.base ?? {}), ...(payload.fields ?? {}) },
    });
    record('sheet.row.update', row.todo_id, 'Updated shared Action Items fields', { fields: Object.keys(payload.fields ?? {}) });
    return { conflicts: [] };
  }

  async function drainOutbox() {
    let processed = 0;
    let exhausted = 0;
    while (true) {
      const row = claimOutbox();
      if (!row) break;
      try {
        const result = await performOutbox(row);
        const at = now();
        if (result.conflicts.length) {
          db.prepare(`
            UPDATE sync_outbox SET status = 'conflict', lease_owner = NULL, lease_expires_at = NULL,
              conflict_payload = ?, updated_at = ? WHERE id = ?
          `).run(JSON.stringify(result.conflicts[0]), at, row.id);
          for (const conflict of result.conflicts) record('sheet.sync.conflict', row.todo_id, `Action Items conflict on ${conflict.field}`, conflict, 'error');
        } else {
          db.prepare(`
            UPDATE sync_outbox SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
              last_error = NULL, completed_at = ?, updated_at = ? WHERE id = ?
          `).run(at, at, row.id);
          processed += 1;
        }
      } catch (error) {
        const at = now();
        healthError(error);
        if (row.attempts >= MAX_OUTBOX_ATTEMPTS) {
          db.prepare(`
            UPDATE sync_outbox SET status = 'exhausted', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE id = ?
          `).run(String(error.message ?? error), at, row.id);
          record('sheet.outbox.exhausted', row.todo_id, 'Action Items write exhausted its retry budget', { operation: row.operation, attempts: row.attempts }, 'error', String(error.message ?? error));
          exhausted += 1;
        } else {
          const retryAt = new Date(Date.parse(at) + Math.min(60, 2 ** (row.attempts - 1)) * 60_000).toISOString();
          db.prepare(`
            UPDATE sync_outbox SET status = 'retry', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?
          `).run(retryAt, String(error.message ?? error), at, row.id);
          record('sheet.outbox.retry', row.todo_id, 'Action Items write queued for retry', { operation: row.operation, attempts: row.attempts }, 'error', String(error.message ?? error));
        }
      }
    }
    return { processed, exhausted };
  }

  function finishOutbox(outboxId, taskId) {
    const row = db.prepare('SELECT status, last_error, conflict_payload FROM sync_outbox WHERE id = ?').get(outboxId);
    if (row?.status === 'completed') return service.get(taskId);
    if (row?.status === 'conflict') throw new TodoDomainError('SHEET_SYNC_CONFLICT', 'The Action Items row changed in the meeting.', { status: 409, details: JSON.parse(row.conflict_payload) });
    throw new Error(row?.last_error || 'Action Items write queued for retry');
  }

  async function appendNote(taskId, body, callerContext) {
    const note = service.addNote(taskId, body, callerContext);
    const link = sheetLink(taskId);
    if (!link) throw new Error('Action Items row is missing');
    const digest = createHash('sha256').update(`${taskId}\0${note.id}`).digest('hex').slice(0, 16);
    const marker = invisibleNoteMarker(digest);
    const outboxId = enqueueOutbox(taskId, 'append-note', { body, noteId: note.id, marker }, callerContext);
    await drainOutbox();
    return finishOutbox(outboxId, taskId);
  }

  async function refreshTask(taskId) {
    await reconcile();
    return service.get(taskId);
  }

  function unshare(taskId, callerContext) {
    return service.detachExternalLink(taskId, 'sheet', callerContext);
  }

  async function bootstrapSchema({ confirmSheetId } = {}) {
    if (confirmSheetId !== spreadsheetId) throw new TodoDomainError('SHEET_CONFIRMATION_REQUIRED', 'Confirm the exact spreadsheet id before schema bootstrap.');
    const inspected = await inspect({ bootstrap: true });
    const plan = buildSchemaBootstrap(inspected);
    await client.batchUpdateValues(spreadsheetId, plan.headerValues);
    await client.batchUpdateSpreadsheet(spreadsheetId, plan.requests);
    record('sheet.schema.bootstrap', spreadsheetId, 'Added Action Items Tag and hidden Totem ID columns', null);
    return inspect();
  }

  function getHealth() {
    const state = ensureState();
    const conflicts = db.prepare("SELECT conflict_payload FROM sync_outbox WHERE connector = 'sheet' AND status = 'conflict' ORDER BY created_at, id").all()
      .map(row => JSON.parse(row.conflict_payload));
    const outbox = db.prepare(`
      SELECT status, COUNT(*) AS count, MAX(last_error) AS last_error
      FROM sync_outbox WHERE connector = 'sheet' AND status <> 'completed' GROUP BY status
    `).all();
    const counts = Object.fromEntries(outbox.map(row => [row.status, Number(row.count)]));
    const pending = (counts.pending ?? 0) + (counts.retry ?? 0) + (counts.leased ?? 0);
    const exhausted = counts.exhausted ?? 0;
    const missing = Boolean(db.prepare("SELECT 1 FROM external_links WHERE connector = 'sheet' AND missing_at IS NOT NULL LIMIT 1").get());
    const lastError = state.last_error ?? outbox.find(row => row.last_error)?.last_error ?? null;
    let status = 'idle';
    if (conflicts.length) status = 'conflict';
    else if (missing) status = 'missing';
    else if (pending) status = 'pending';
    else if (exhausted || lastError) status = 'error';
    else if (state.last_success_at) status = 'ok';
    const recovery = status === 'conflict' ? 'Resolve the local/meeting field conflicts before retrying.'
      : status === 'missing' ? 'Restore the row or unshare the retained local task.'
        : status === 'pending' ? 'The durable write will retry automatically; manual refresh can retry when due.'
          : status === 'error' ? 'Inspect the connector error, restore access, then run a manual refresh.'
            : null;
    return {
      status,
      pending,
      exhausted,
      conflicts,
      missing,
      lastSuccessAt: state.last_success_at,
      lastError,
      recovery,
    };
  }

  function getSettings() {
    return { spreadsheetId, tab: ACTION_ITEMS.tab, sheetId: ACTION_ITEMS.sheetId, headerRow: ACTION_ITEMS.headerRow };
  }

  return { share, unshare, create, updateLinked, appendNote, refreshTask, reconcile, bootstrapSchema, getHealth, getSettings,
    async bulk(input) {
      for (const id of input.ids ?? []) {
        if (input.operation === 'priority') await updateLinked(id, { priority: input.priority });
        else if (input.operation === 'addTag' || input.operation === 'removeTag') service.bulk({ ...input, ids: [id] });
      }
      return (input.ids ?? []).map(id => service.get(id));
    },
  };
}
