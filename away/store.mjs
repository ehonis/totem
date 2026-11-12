/**
 * Away spans: trips and days off, kept in one small JSON file (`data/away.json`).
 *
 * Read synchronously and held in memory, because the date-grounding block every prompt
 * carries is built synchronously (`temporalContext()` in bridge.mjs) and must not grow an
 * await on every agent spawn. Every read checks the file's mtime and size first, so a hand
 * edit takes effect without a restart and a write never lays the in-memory copy over it.
 *
 * Only the owner writes here: the dashboard over HTTP, or accepting an `away` inbox
 * proposal. Agents propose (away/mcp.mjs); they never call create directly, and they do
 * not edit the file.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isDayKey } from '../goals/periods.mjs';
import { AWAY_KINDS, spanDays } from './days.mjs';

export class AwayError extends Error {
  constructor(code, message, { status = 400, details = null } = {}) {
    super(message);
    this.name = 'AwayError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// A year is generous for a sabbatical and still catches a typo'd year ("2027" for "2026").
const MAX_SPAN_DAYS = 366;
// Real dates that are no one's trip: a hand edit to 9999-12-31, or an epoch default.
const MIN_YEAR = 1970;
const MAX_YEAR = 2199;

const fail = (code, message, details) => new AwayError(code, message, { details });
const yearOf = (key) => Number(key.slice(0, 4));

/**
 * Validate a whole span. Shared with the inbox stager and the loader, so a proposal that
 * could never be accepted is refused when it is staged, and a hand-edited row that could
 * never have been saved is dropped when it is read.
 */
export function normalizeSpan(input = {}) {
  const start = String(input.start ?? '').trim();
  const end = String(input.end ?? input.start ?? '').trim();
  if (!isDayKey(start) || yearOf(start) < MIN_YEAR || yearOf(start) > MAX_YEAR) throw fail('INVALID_AWAY_START', 'start must be a real date as YYYY-MM-DD.', { field: 'start' });
  if (!isDayKey(end) || yearOf(end) > MAX_YEAR) throw fail('INVALID_AWAY_END', 'end must be a real date as YYYY-MM-DD.', { field: 'end' });
  if (end < start) throw fail('INVALID_AWAY_RANGE', 'end must be on or after start.', { field: 'end' });
  if (spanDays({ start, end }) > MAX_SPAN_DAYS) throw fail('INVALID_AWAY_RANGE', `A span is at most ${MAX_SPAN_DAYS} days.`, { field: 'end' });
  const label = String(input.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!label) throw fail('INVALID_AWAY_LABEL', 'label must be a non-empty string.', { field: 'label' });
  const kind = input.kind == null || input.kind === '' ? 'trip' : String(input.kind);
  if (!AWAY_KINDS.includes(kind)) throw fail('INVALID_AWAY_KIND', `kind must be one of ${AWAY_KINDS.join(', ')}.`, { field: 'kind' });
  const note = input.note == null ? '' : String(input.note).trim().slice(0, 500);
  return { start, end, label, kind, ...(note ? { note } : {}) };
}

/** The same trip twice: same days and the same name, whatever its case. */
export const sameSpan = (a, b) => a.start === b.start && a.end === b.end && a.label.toLowerCase() === b.label.toLowerCase();

export function createAwayStore({ file, now = () => new Date().toISOString(), makeId = randomUUID, actionLog = null, log = () => {} } = {}) {
  if (!file) throw new TypeError('createAwayStore requires file');

  let spans = [];
  let seen = null; // { mtimeMs, size } of the file as last read or written; null when absent

  const stamp = () => {
    try {
      const st = statSync(file);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };
  const sameStamp = (a, b) => (a === null || b === null ? a === b : a.mtimeMs === b.mtimeMs && a.size === b.size);

  function load() {
    seen = stamp();
    if (!seen) { spans = []; return; }
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) {
      // A hand edit that no longer parses must not stop the bridge booting; it must not
      // be overwritten either, so writes refuse until it is fixed.
      log(`away: ${file} is not valid JSON (${e.message}); treating it as empty until fixed`);
      spans = null;
      return;
    }
    const rows = Array.isArray(parsed?.spans) ? parsed.spans : [];
    spans = [];
    for (const row of rows) {
      try {
        if (!row?.id) throw fail('INVALID_AWAY_ID', 'no id');
        spans.push({ ...row, ...normalizeSpan(row) });
      } catch (e) {
        log(`away: dropped an invalid span from ${file} (${e.message}): ${JSON.stringify(row).slice(0, 200)}`);
      }
    }
  }

  // Re-read when the file is not the one this process last read or wrote.
  function sync() {
    if (!sameStamp(stamp(), seen)) load();
  }

  load();

  const current = () => spans || [];
  const sorted = (list) => [...list].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : 1));

  function save(next) {
    if (spans === null) throw new AwayError('AWAY_FILE_UNREADABLE', `${file} is not valid JSON; fix or remove it first.`, { status: 500 });
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ spans: sorted(next) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    spans = sorted(next);
    seen = stamp();
  }

  function audit(action, span, context, summary) {
    actionLog?.record({
      action, actor: context?.actor ?? 'unknown', target: span.id, status: 'ok', summary,
      why: context?.reason ?? summary, detail: { start: span.start, end: span.end, kind: span.kind },
      correlationId: context?.correlationId ?? randomUUID(),
    });
  }

  function findSpan(id) {
    const found = current().find((s) => s.id === id);
    if (!found) throw new AwayError('AWAY_NOT_FOUND', `Away span ${id} was not found.`, { status: 404, details: { id } });
    return found;
  }

  return {
    /** Every span, oldest first. Synchronous on purpose; see the header. */
    snapshot() { sync(); return current(); },

    list({ from = null } = {}) {
      sync();
      return from ? current().filter((s) => s.end >= from) : current();
    },

    get(id) { sync(); return findSpan(id); },

    create(input = {}, context = {}) {
      sync();
      const fields = normalizeSpan(input);
      const existing = current().find((s) => sameSpan(s, fields));
      if (existing) throw new AwayError('AWAY_DUPLICATE', `"${existing.label}" is already listed for those dates.`, { status: 409, details: { existing } });
      const at = now();
      const span = { id: makeId(), ...fields, source: String(context.source || context.actor || 'owner').slice(0, 80), createdAt: at, updatedAt: at };
      save([...current(), span]);
      audit('away.create', span, context, `Added away span ${span.label} (${span.start} to ${span.end})`);
      return span;
    },

    update(id, patch = {}, context = {}) {
      sync();
      const existing = findSpan(id);
      const fields = normalizeSpan({ ...existing, ...patch });
      const span = { ...existing, ...fields, updatedAt: now() };
      if (!fields.note) delete span.note;
      save(current().map((s) => (s.id === id ? span : s)));
      audit('away.update', span, context, `Updated away span ${span.label} (${span.start} to ${span.end})`);
      return span;
    },

    remove(id, context = {}) {
      sync();
      const existing = findSpan(id);
      save(current().filter((s) => s.id !== id));
      audit('away.delete', existing, context, `Deleted away span ${existing.label}`);
      return { ok: true, id, deleted: true };
    },
  };
}
