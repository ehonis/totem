import { join } from 'node:path';

import { backupTodoDatabase } from './db.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizedNow(now) {
  const value = new Date(now());
  if (!Number.isFinite(value.getTime())) throw new TypeError('maintenance now() must return a valid timestamp');
  return value;
}

function cutoff(date, days) {
  return new Date(date.getTime() - days * DAY_MS).toISOString();
}

/**
 * The most recent occurrence of a local HH:MM at or before `date`.
 *
 * Archiving *everything* finished the moment the hour arrives would make a task
 * completed at 18:05 disappear within the next sweep, which is the opposite of the
 * point: the evening list is what you did today. Archiving strictly before the last
 * boundary means today's work stays on the board until today is over, and the sweep
 * needs no memory of whether it has already run — falling behind and catching up at
 * 09:00 tomorrow archives exactly the same set.
 */
export function lastDailyBoundary(date, timeOfDay) {
  const [hours, minutes] = String(timeOfDay).split(':').map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    throw new TypeError('autoArchiveAt must be an HH:MM time');
  }
  const boundary = new Date(date);
  boundary.setHours(hours, minutes, 0, 0);
  if (boundary > date) boundary.setDate(boundary.getDate() - 1);
  return boundary.toISOString();
}

/**
 * Two ways to fall off the board, and the later boundary wins: a daily sweep is the
 * one the owner actually watches, and an age rule alongside it should only ever catch
 * things the sweep has not reached yet.
 */
function archiveBoundary(preferences, at) {
  const boundaries = [
    preferences.autoArchiveAt == null ? null : lastDailyBoundary(at, preferences.autoArchiveAt),
    preferences.autoArchiveDays == null ? null : cutoff(at, preferences.autoArchiveDays),
  ].filter(Boolean).sort();
  return boundaries.length === 0 ? null : boundaries[boundaries.length - 1];
}

function backupName(date) {
  return `todos-${date.toISOString().replaceAll(':', '-').replace('.', '-')}.db`;
}

function canonicalTimestamp(value, field) {
  if (value == null || (typeof value === 'string' && !value.trim())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return parsed.toISOString();
}

export function createTodoMaintenance({
  db,
  service,
  backupDirectory,
  now = () => new Date().toISOString(),
  backupDatabase = backupTodoDatabase,
} = {}) {
  if (!db) throw new Error('createTodoMaintenance requires db');
  if (!service) throw new Error('createTodoMaintenance requires service');
  if (typeof backupDirectory !== 'string' || !backupDirectory) {
    throw new Error('createTodoMaintenance requires backupDirectory');
  }
  if (typeof now !== 'function') throw new Error('createTodoMaintenance requires now to be a function');
  if (typeof backupDatabase !== 'function') {
    throw new Error('createTodoMaintenance requires backupDatabase to be a function');
  }

  async function purgeDeleted({ olderThan, context } = {}) {
    const at = normalizedNow(now);
    const cutoff = canonicalTimestamp(olderThan, 'olderThan');
    const eligibleIds = db.prepare(`
      SELECT id FROM todos WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY id
    `).all(cutoff).map(row => row.id);
    const backup = join(backupDirectory, backupName(at));
    await backupDatabase({ db, destination: backup });
    const purged = service.purgeDeletedAfterBackup({
      olderThan: cutoff,
      eligibleIds,
      context,
    });
    return { purged, backup };
  }

  /**
   * Archive whatever is past its boundary. Split out from `run` because it wants a
   * completely different cadence: the sweep has to land close to the hour the owner set
   * or the Done column does not clear when he looks at it, while the purge half of
   * `run` takes a database backup every time and belongs on a nightly clock.
   */
  function archiveDue(context) {
    const at = normalizedNow(now);
    const preferences = service.getPreferences();
    const boundary = archiveBoundary(preferences, at);
    return boundary == null ? 0 : service.archiveCompleted({ olderThan: boundary, context });
  }

  async function run(context) {
    const at = normalizedNow(now);
    const preferences = service.getPreferences();
    const boundary = archiveBoundary(preferences, at);
    const archived = boundary == null ? 0 : service.archiveCompleted({ olderThan: boundary, context });
    if (preferences.recyclePurgeDays == null) return { archived, purged: 0, backup: null };
    const result = await purgeDeleted({
      olderThan: cutoff(at, preferences.recyclePurgeDays),
      context,
    });
    return { archived, ...result };
  }

  return { run, archiveDue, purgeDeleted };
}
