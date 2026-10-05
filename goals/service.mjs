/**
 * The one business-rule boundary over the goal tables.
 *
 * Shaped like `todos/service.mjs` beside it: it takes the existing action-log sink, writes
 * through `withTodoTransaction`, returns canonical camel-case DTOs, and records one
 * action-log entry per committed mutation. HTTP, MCP and the CLI all come through here —
 * none of them talk to SQLite.
 *
 * Four rules live here rather than anywhere else, because each of them is the kind that
 * quietly stops being true if it is enforced in three places:
 *
 * 1. **One level of nesting.** The schema has triggers for it too; this layer exists to
 *    say why in a sentence a person can act on rather than raising a SQLite abort.
 * 2. **A rollup edge only ever points at the row's own parent.** Never a sibling, never a
 *    stranger's metric, never a metric two goals away.
 * 3. **A sourced metric's value belongs to its connector.** Writing one by hand is a
 *    conflict, reported the way a source-owned task completion already is.
 * 4. **Completion is always a human act.** Nothing in this file infers it from a full bar.
 *
 * Every public method is async, including the ones that only write. Reads have to be —
 * resolving a Strava-fed metric is I/O — and a surface where some methods need awaiting
 * and others don't is a surface somebody eventually gets wrong.
 */

import { randomUUID } from 'node:crypto';

import { withTodoTransaction } from '../todos/db.mjs';
import { GoalDomainError } from './errors.mjs';
import {
  DEFAULT_TIME_ZONE, daysLeft, isDayKey, nextPeriod, periodKey, periodLabel,
  periodState, resolvePeriod, todayKey,
} from './periods.mjs';
import { goalProgress, percent, subGoalProgress } from './progress.mjs';
import { createGoalMetricSources, describeSource, isGoalMetricSource, normalizeSourceConfig } from './sources.mjs';
import { normalizeUnit } from './units.mjs';

const GOAL_LINK_KINDS = ['todo', 'url'];
const UPDATABLE_GOAL_FIELDS = new Set(['title', 'notes', 'position', 'abandoned']);

function domainError(code, message, options) {
  return new GoalDomainError(code, message, options);
}

function requiredString(value, field, { max = 200 } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw domainError('INVALID_GOAL_FIELD', `${field} must be a non-empty string.`, { details: { field } });
  }
  return value.trim().slice(0, max);
}

function optionalString(value, field, { max = 200 } = {}) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw domainError('INVALID_GOAL_FIELD', `${field} must be a string or null.`, { details: { field } });
  }
  return value.trim().slice(0, max) || null;
}

function positiveNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw domainError('INVALID_GOAL_FIELD', `${field} must be a number greater than zero.`, { details: { field } });
  }
  return n;
}

export function createGoalService({
  db,
  now = () => new Date().toISOString(),
  makeId = randomUUID,
  actionLog,
  strava = null,
  timeZone = DEFAULT_TIME_ZONE,
  sources = null,
} = {}) {
  if (!db) throw new Error('createGoalService requires db');
  if (typeof now !== 'function') throw new Error('createGoalService requires now to be a function');
  if (typeof makeId !== 'function') throw new Error('createGoalService requires makeId to be a function');
  if (!actionLog || typeof actionLog.record !== 'function') {
    throw new Error('createGoalService requires an actionLog with record()');
  }

  const metricSources = sources ?? createGoalMetricSources({ strava });

  const today = () => todayKey(new Date(now()), timeZone);

  /**
   * The window a period name (or `{ type, start }`) resolves to, from the box's clock.
   * The list route returns it beside the goals so an EMPTY window still has a label
   * and a pair of dates to step from — a view that only learned the window from the
   * first goal in it had nothing to say about a week with none.
   */
  const windowOf = (period = 'this_week') => resolvePeriod(period, { now: new Date(now()), tz: timeZone });

  // ---- reads ---------------------------------------------------------------

  const goalRow = (id) => db.prepare('SELECT * FROM goals WHERE id = ? AND deleted_at IS NULL').get(id);

  function requireGoal(id) {
    const row = goalRow(id);
    if (!row) {
      throw domainError('GOAL_NOT_FOUND', `Goal ${id} was not found.`, { status: 404, details: { id } });
    }
    return row;
  }

  function requireTopLevel(id) {
    const row = requireGoal(id);
    if (row.parent_id) {
      throw domainError('GOAL_IS_A_SUB_GOAL',
        'That is a step inside another goal. Act on the goal that owns it.',
        { status: 409, details: { id, parentId: row.parent_id } });
    }
    return row;
  }

  const metricRow = (id) => db.prepare('SELECT * FROM goal_metrics WHERE id = ?').get(id);

  function requireMetric(id) {
    const row = metricRow(id);
    if (!row) {
      throw domainError('GOAL_METRIC_NOT_FOUND', `Metric ${id} was not found.`, { status: 404, details: { id } });
    }
    return row;
  }

  const metricsOf = (goalId) =>
    db.prepare('SELECT * FROM goal_metrics WHERE goal_id = ? ORDER BY position, id').all(goalId);

  const subGoalRows = (parentId) =>
    db.prepare('SELECT * FROM goals WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, id').all(parentId);

  // A goal link to a task reads the task live rather than trusting the label stored with
  // it. The two sit in one database, so there is no reason to show a stale title — the
  // stored label is kept only so a deleted task still reads as something.
  const linksOf = (goalId) => db.prepare(`
    SELECT goal_links.*, todos.title AS todo_title, todos.status AS todo_status,
           todos.due_date AS todo_due_date, todos.completed_at AS todo_completed_at
    FROM goal_links LEFT JOIN todos ON todos.id = goal_links.todo_id
    WHERE goal_links.goal_id = ? ORDER BY goal_links.position, goal_links.id
  `).all(goalId);

  const parsedConfig = (row) => {
    try { return JSON.parse(row.source_config || '{}'); } catch { return {}; }
  };

  function metricInput(row) {
    return {
      id: row.id,
      label: row.label,
      unit: row.unit,
      targetValue: row.target_value,
      currentValue: row.current_value,
      rollsUpToMetricId: row.rolls_up_to_metric_id,
      sourceKind: row.source_kind,
    };
  }

  /** Every metric on a goal and its sub-goals, with any sourced value already resolved. */
  async function resolveScope(rows, period) {
    const requests = rows
      .filter((row) => row.source_kind !== 'manual')
      .map((row) => ({ id: row.id, sourceKind: row.source_kind, sourceConfig: parsedConfig(row), period }));
    const resolved = await metricSources.resolve(requests);
    return new Map(rows.map((row) => {
      const hit = resolved.get(row.id);
      const base = metricInput(row);
      if (!hit) return [row.id, base];
      return [row.id, { ...base, currentValue: hit.value ?? 0, available: hit.available, unavailableReason: hit.reason, readAt: hit.readAt }];
    }));
  }

  function metricDto(row, resolved, computed) {
    const config = parsedConfig(row);
    return {
      id: row.id,
      goalId: row.goal_id,
      label: row.label,
      unit: row.unit,
      targetValue: row.target_value,
      ownValue: computed.ownValue,
      rolledUpValue: computed.rolledUpValue,
      value: computed.value,
      fraction: computed.fraction,
      percent: percent(computed.fraction),
      rollsUpToMetricId: row.rolls_up_to_metric_id,
      feederCount: computed.feederCount,
      unreadableFeederCount: computed.unreadableFeederCount,
      sourceKind: row.source_kind,
      sourceConfig: config,
      sourceLabel: describeSource(row.source_kind, config),
      available: computed.available,
      unavailableReason: computed.unavailableReason,
      readAt: resolved?.readAt ?? null,
      position: row.position,
    };
  }

  function linkDto(row) {
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      url: row.url,
      todoId: row.todo_id,
      // Null when the task is gone. The cascade means that should not happen, but a link
      // that renders as its stored label rather than crashing is the right failure.
      todo: row.todo_id && row.todo_title != null
        ? { id: row.todo_id, title: row.todo_title, status: row.todo_status, dueDate: row.todo_due_date, completedAt: row.todo_completed_at }
        : null,
      position: row.position,
    };
  }

  function periodOf(row) {
    return {
      type: row.period_type,
      start: row.period_start,
      end: row.period_end,
      key: periodKey(row.period_type, row.period_start, row.period_end),
      label: periodLabel(row.period_type, row.period_start, row.period_end),
    };
  }

  async function goalDto(row) {
    const period = periodOf(row);
    const subs = subGoalRows(row.id);
    const ownMetrics = metricsOf(row.id);
    const subMetrics = subs.map((sub) => metricsOf(sub.id));

    const resolved = await resolveScope([...ownMetrics, ...subMetrics.flat()], period);
    const asInput = (rows) => rows.map((r) => resolved.get(r.id));

    const progress = goalProgress({
      completedAt: row.completed_at,
      metrics: asInput(ownMetrics),
      // `abandonedAt` rides along so a step he decided against leaves the steps fraction
      // rather than holding the goal below 100% forever. What it already logged still
      // rolls up: those miles happened whether or not the step is still in play.
      subGoals: subs.map((sub, i) => ({
        id: sub.id, completedAt: sub.completed_at, abandonedAt: sub.abandoned_at ?? null, metrics: asInput(subMetrics[i]),
      })),
    });

    const day = today();
    return {
      id: row.id,
      clientKey: row.client_key,
      title: row.title,
      notes: row.notes,
      period,
      periodState: periodState(period, day),
      daysLeft: daysLeft(period, day),
      completedAt: row.completed_at,
      complete: Boolean(row.completed_at),
      // Resolved, but not done. Kept apart from `complete` because the count the owner
      // reads on a Sunday is how many he finished, and a goal he decided against is
      // not one of them.
      abandonedAt: row.abandoned_at ?? null,
      abandoned: Boolean(row.abandoned_at),
      postponedCount: row.postponed_count,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metrics: ownMetrics.map((m, i) => metricDto(m, resolved.get(m.id), progress.metrics[i])),
      subGoals: subs.map((sub, i) => {
        const subProgress = subGoalProgress({ id: sub.id, completedAt: sub.completed_at, metrics: asInput(subMetrics[i]) });
        return {
          id: sub.id,
          parentId: row.id,
          title: sub.title,
          notes: sub.notes,
          completedAt: sub.completed_at,
          complete: Boolean(sub.completed_at),
          // A step can be decided against on its own — an add-on to the goal he knows he
          // will not get to, while the goal itself still happened.
          abandonedAt: sub.abandoned_at ?? null,
          abandoned: Boolean(sub.abandoned_at),
          position: sub.position,
          metrics: subMetrics[i].map((m, j) => metricDto(m, resolved.get(m.id), subProgress.metrics[j])),
          progress: { fraction: subProgress.fraction, percent: percent(subProgress.fraction) },
        };
      }),
      links: linksOf(row.id).map(linkDto),
      progress: {
        fraction: progress.fraction,
        percent: percent(progress.fraction),
        subGoalsDone: progress.subGoalsDone,
        subGoalsTotal: progress.subGoalsTotal,
        subGoalsAbandoned: progress.subGoalsAbandoned,
        complete: progress.complete,
      },
    };
  }

  async function listGoals({ period = null, periodType = null, from = null, to = null, includeCompleted = true, state = null } = {}) {
    const where = ['parent_id IS NULL', 'deleted_at IS NULL'];
    const params = [];
    if (period) {
      const window = resolvePeriod(period, { now: new Date(now()), tz: timeZone });
      where.push('period_start = ? AND period_end = ?');
      params.push(window.start, window.end);
    }
    if (periodType) { where.push('period_type = ?'); params.push(periodType); }
    if (from) { where.push('period_end >= ?'); params.push(from); }
    if (to) { where.push('period_start <= ?'); params.push(to); }
    if (!includeCompleted) where.push('completed_at IS NULL');

    const rows = db.prepare(`
      SELECT * FROM goals WHERE ${where.join(' AND ')}
      ORDER BY period_start DESC, position, id
    `).all(...params);

    const dtos = [];
    for (const row of rows) dtos.push(await goalDto(row));
    return state ? dtos.filter((goal) => goal.periodState === state) : dtos;
  }

  async function getGoal(id) {
    const row = requireGoal(id);
    // Asking for a step by id answers with the goal that owns it, so a caller holding a
    // sub-goal id is never left with half a picture.
    return goalDto(row.parent_id ? requireGoal(row.parent_id) : row);
  }

  /** Name search — the id resolver an agent needs before it can act on anything. */
  async function findGoals(query, { limit = 20 } = {}) {
    const text = requiredString(query, 'query');
    const like = `%${text.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = db.prepare(`
      SELECT * FROM goals
      WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')
      ORDER BY period_start DESC, position, id LIMIT ?
    `).all(like, like, Math.min(Math.max(Number(limit) || 20, 1), 100));

    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const topId = row.parent_id ?? row.id;
      if (seen.has(topId)) continue;
      seen.add(topId);
      const top = goalRow(topId);
      if (top) out.push(await goalDto(top));
    }
    return out;
  }

  // ---- writes --------------------------------------------------------------

  function audit(action, target, context, summary, result) {
    actionLog.record({
      action,
      actor: context?.actor ?? 'unknown',
      target,
      status: 'ok',
      summary,
      why: context?.reason ?? context?.why ?? summary,
      detail: { result },
      correlationId: context?.correlationId ?? randomUUID(),
    });
  }

  function mutate({ action, target, context, summary, result }, fn) {
    const value = withTodoTransaction(db, fn);
    audit(action, target, context, typeof summary === 'function' ? summary(value) : summary, result);
    return value;
  }

  function nextPosition(table, column, id) {
    const row = db.prepare(`SELECT MAX(position) AS max FROM ${table} WHERE ${column} IS ?`).get(id);
    return (row?.max ?? -1) + 1;
  }

  function nextGoalPosition(period) {
    const row = db.prepare(`
      SELECT MAX(position) AS max FROM goals
      WHERE parent_id IS NULL AND deleted_at IS NULL AND period_start = ? AND period_end = ?
    `).get(period.start, period.end);
    return (row?.max ?? -1) + 1;
  }

  function validateMetric(input, { field = 'metric' } = {}) {
    const label = requiredString(input?.label, `${field}.label`, { max: 80 });
    const targetValue = positiveNumber(input?.targetValue ?? input?.target, `${field}.targetValue`);
    const sourceKind = input?.sourceKind ?? 'manual';
    if (!isGoalMetricSource(sourceKind)) {
      throw domainError('UNKNOWN_METRIC_SOURCE', `Unknown metric source "${sourceKind}".`, {
        details: { field: `${field}.sourceKind`, sourceKind },
      });
    }
    let sourceConfig;
    try {
      sourceConfig = normalizeSourceConfig(sourceKind, input?.sourceConfig ?? {});
    } catch (error) {
      throw domainError('INVALID_METRIC_SOURCE', error.message, { details: { field: `${field}.sourceConfig` } });
    }
    const currentValue = sourceKind === 'manual' ? Math.max(0, Number(input?.currentValue ?? 0) || 0) : 0;
    return { label, unit: normalizeUnit(input?.unit), targetValue, currentValue, sourceKind, sourceConfig };
  }

  function insertMetric(goalId, input, stamp, position) {
    const metric = validateMetric(input);
    const id = input?.id ?? makeId();
    db.prepare(`
      INSERT INTO goal_metrics (
        id, goal_id, label, unit, target_value, current_value,
        rolls_up_to_metric_id, source_kind, source_config, position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run(id, goalId, metric.label, metric.unit, metric.targetValue, metric.currentValue,
      metric.sourceKind, JSON.stringify(metric.sourceConfig), position, stamp, stamp);
    return id;
  }

  /**
   * Which of the parent's numbers a new metric feeds, from either form the surfaces take.
   *
   * Two spellings exist because the two authoring paths genuinely differ. An agent
   * importing a photographed page has no ids at all — it says `rollsUpTo: "miles"` and
   * means the metric it just described one line above — while the web editor has the
   * real `rollsUpToMetricId` in its hand and must never fall back to matching by name.
   * Both are resolved to an id here and handed to `setRollup`, which owns every refusal.
   *
   * A label that names nothing throws rather than being dropped: the alternative is a
   * step that looks like it is feeding the total, reads low for the rest of the week,
   * and has nothing anywhere saying why.
   */
  function rollupTargetFor(row, input) {
    if (input?.rollsUpToMetricId) return input.rollsUpToMetricId;
    const label = input?.rollsUpTo ?? input?.rollsUpToLabel;
    if (label === undefined || label === null || String(label).trim() === '') return null;
    if (!row?.parent_id) {
      throw domainError('ROLLUP_NEEDS_A_PARENT',
        'Only a step inside a goal can roll up — a top-level goal has nothing to feed.',
        { status: 409, details: { rollsUpTo: label } });
    }
    const wanted = String(label).trim().toLowerCase();
    const match = metricsOf(row.parent_id).find((metric) => metric.label.trim().toLowerCase() === wanted);
    if (!match) {
      throw domainError('ROLLUP_LABEL_NOT_FOUND',
        `"${label}" does not name a number on the goal that owns this step, so there is nothing to feed.`,
        { details: { rollsUpTo: label, parentId: row.parent_id } });
    }
    return match.id;
  }

  /**
   * Point a metric at the one on its goal's parent that it feeds.
   *
   * Every refusal here is a case where the alternative is a number that reads plausibly
   * and is wrong: feeding a stranger's metric, feeding a sibling, or feeding something
   * that already counts itself out of a connector.
   */
  function setRollup(metricId, targetId, stamp) {
    const metric = requireMetric(metricId);
    if (targetId == null) {
      db.prepare('UPDATE goal_metrics SET rolls_up_to_metric_id = NULL, updated_at = ? WHERE id = ?').run(stamp, metricId);
      return;
    }
    const goal = requireGoal(metric.goal_id);
    if (!goal.parent_id) {
      throw domainError('ROLLUP_NEEDS_A_PARENT',
        'Only a step inside a goal can roll up — a top-level goal has nothing to feed.',
        { status: 409, details: { metricId } });
    }
    const target = requireMetric(targetId);
    if (target.goal_id !== goal.parent_id) {
      throw domainError('ROLLUP_TARGET_NOT_ON_PARENT',
        'A step can only feed a number on the goal that owns it.',
        { status: 409, details: { metricId, targetId, parentId: goal.parent_id } });
    }
    if (target.source_kind !== 'manual') {
      throw domainError('ROLLUP_TARGET_IS_SOURCED',
        'That number is read from a connector, which already counts everything in the period. Feeding it as well would count the same miles twice.',
        { status: 409, details: { metricId, targetId } });
    }
    db.prepare('UPDATE goal_metrics SET rolls_up_to_metric_id = ?, updated_at = ? WHERE id = ?').run(targetId, stamp, metricId);
  }

  /**
   * Point a metric at a connector, or hand it back to you.
   *
   * This exists because `METRIC_IS_SOURCED` tells you to change the source to manual
   * first, and an error that names a fix no surface can perform is a dead end.
   *
   * Switching *to* a connector drops whatever was logged by hand: the schema keeps a
   * sourced metric's stored value at zero, since the connector owns the number. That is
   * real data loss, so it is reported in the result rather than done quietly.
   */
  function setSource(metricId, sourceKind, sourceConfig, stamp) {
    const row = requireMetric(metricId);
    if (!isGoalMetricSource(sourceKind)) {
      throw domainError('UNKNOWN_METRIC_SOURCE', `Unknown metric source "${sourceKind}".`, {
        details: { metricId, sourceKind },
      });
    }
    let config;
    try {
      config = normalizeSourceConfig(sourceKind, sourceConfig ?? parsedConfig(row));
    } catch (error) {
      throw domainError('INVALID_METRIC_SOURCE', error.message, { details: { metricId } });
    }

    if (sourceKind !== 'manual') {
      // A connector-fed number already counts everything in the period, so anything
      // feeding it would count the same miles twice.
      const feeders = db.prepare('SELECT count(*) AS n FROM goal_metrics WHERE rolls_up_to_metric_id = ?').get(metricId).n;
      if (feeders > 0) {
        throw domainError('SOURCED_METRIC_CANNOT_BE_FED',
          `${feeders} step${feeders === 1 ? '' : 's'} feed "${row.label}". A number read from a connector already counts everything in the period, so those would be counted twice. Detach them first.`,
          { status: 409, details: { metricId, feeders } });
      }
    }

    const discarded = sourceKind !== 'manual' ? row.current_value : 0;
    db.prepare(`
      UPDATE goal_metrics SET source_kind = ?, source_config = ?, current_value = ?, updated_at = ?
      WHERE id = ?
    `).run(sourceKind, JSON.stringify(config), sourceKind === 'manual' ? row.current_value : 0, stamp, metricId);
    return { discarded };
  }

  function insertLink(goalId, input, stamp, position) {
    const kind = input?.kind ?? (input?.todoId ? 'todo' : 'url');
    if (!GOAL_LINK_KINDS.includes(kind)) {
      throw domainError('UNKNOWN_LINK_KIND', `A goal links to a task or a url, not "${kind}".`, { details: { kind } });
    }
    const id = makeId();
    if (kind === 'todo') {
      const todoId = requiredString(input?.todoId, 'link.todoId');
      const todo = db.prepare('SELECT id, title FROM todos WHERE id = ?').get(todoId);
      if (!todo) {
        throw domainError('LINKED_TODO_NOT_FOUND', `Task ${todoId} was not found.`, { status: 404, details: { todoId } });
      }
      const existing = db.prepare('SELECT id FROM goal_links WHERE goal_id = ? AND todo_id = ?').get(goalId, todoId);
      // Linking the same task twice is a no-op rather than an error: an agent re-running
      // an import should not have to know what it did last time.
      if (existing) return existing.id;
      db.prepare(`
        INSERT INTO goal_links (id, goal_id, kind, todo_id, url, label, position, created_at)
        VALUES (?, ?, 'todo', ?, NULL, ?, ?, ?)
      `).run(id, goalId, todoId, optionalString(input?.label, 'link.label') ?? todo.title, position, stamp);
      return id;
    }
    const url = requiredString(input?.url, 'link.url', { max: 2000 });
    db.prepare(`
      INSERT INTO goal_links (id, goal_id, kind, todo_id, url, label, position, created_at)
      VALUES (?, ?, 'url', NULL, ?, ?, ?, ?)
    `).run(id, goalId, url, optionalString(input?.label, 'link.label') ?? url, position, stamp);
    return id;
  }

  function insertGoalTree(input, stamp) {
    const period = resolvePeriod(input?.period ?? 'this_week', { now: new Date(now()), tz: timeZone });
    const title = requiredString(input?.title, 'title');
    const notes = optionalString(input?.notes, 'notes', { max: 4000 }) ?? '';
    const clientKey = optionalString(input?.clientKey, 'clientKey', { max: 120 });
    const id = makeId();

    db.prepare(`
      INSERT INTO goals (
        id, client_key, title, notes, parent_id, period_type, period_start, period_end,
        completed_at, postponed_count, position, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, 0, ?, ?, ?, NULL)
    `).run(id, clientKey, title, notes, period.type, period.start, period.end,
      input?.position ?? nextGoalPosition(period), stamp, stamp);

    // Metrics before sub-goals, because a sub-goal metric may name one of these as the
    // number it feeds — by label, scoped to this one payload.
    const ownMetricIds = new Map();
    (input?.metrics ?? []).forEach((metric, i) => {
      const metricId = insertMetric(id, metric, stamp, i);
      ownMetricIds.set(metric.label.trim().toLowerCase(), metricId);
    });

    (input?.subGoals ?? []).forEach((sub, i) => {
      const subId = makeId();
      db.prepare(`
        INSERT INTO goals (
          id, client_key, title, notes, parent_id, period_type, period_start, period_end,
          completed_at, postponed_count, position, created_at, updated_at, deleted_at
        ) VALUES (?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?, ?, NULL)
      `).run(subId, optionalString(sub?.title, 'subGoal.title'), optionalString(sub?.notes, 'subGoal.notes', { max: 2000 }) ?? '', id, i, stamp, stamp);

      (sub?.metrics ?? []).forEach((metric, j) => {
        const metricId = insertMetric(subId, metric, stamp, j);
        const feeds = metric?.rollsUpTo ?? metric?.rollsUpToLabel ?? null;
        if (feeds == null) return;
        const targetId = ownMetricIds.get(String(feeds).trim().toLowerCase());
        if (!targetId) {
          // Loudly, at import, rather than reading low weeks later with nothing saying so.
          throw domainError('ROLLUP_LABEL_NOT_FOUND',
            `"${feeds}" does not name a number on this goal, so "${metric.label}" has nothing to feed.`,
            { details: { subGoal: sub?.title ?? null, metric: metric.label, rollsUpTo: feeds } });
        }
        setRollup(metricId, targetId, stamp);
      });
    });

    (input?.links ?? []).forEach((link, i) => insertLink(id, link, stamp, i));
    return id;
  }

  async function createGoal(input, context) {
    const stamp = now();
    const clientKey = optionalString(input?.clientKey, 'clientKey', { max: 120 });

    // A re-import is an update, not a second copy of the week.
    if (clientKey) {
      const existing = db.prepare('SELECT id FROM goals WHERE client_key = ? AND deleted_at IS NULL').get(clientKey);
      if (existing) {
        const updated = mutate(
          { action: 'goal.reimport', target: existing.id, context, summary: `Re-imported goal ${clientKey}`, result: 'updated' },
          () => {
            db.prepare('UPDATE goals SET title = ?, notes = ?, updated_at = ? WHERE id = ?')
              .run(requiredString(input?.title, 'title'), optionalString(input?.notes, 'notes', { max: 4000 }) ?? '', stamp, existing.id);
            return existing.id;
          },
        );
        return { goal: await goalDto(requireGoal(updated)), reimported: true };
      }
    }

    const id = mutate(
      { action: 'goal.create', target: null, context, summary: `Created goal "${input?.title ?? ''}"`, result: 'created' },
      () => insertGoalTree(input, stamp),
    );
    return { goal: await goalDto(requireGoal(id)), reimported: false };
  }

  /**
   * Import a batch, reporting per-row failures.
   *
   * One bad row out of a notebook page must not cost the other eleven, so each goal is its
   * own transaction and its own entry in `failed` — the caller sees exactly which line of
   * the photo did not survive.
   */
  async function createGoals(inputs, context) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw domainError('INVALID_GOAL_BATCH', 'Pass at least one goal.', { details: { field: 'goals' } });
    }
    const created = [];
    const failed = [];
    for (const [index, input] of inputs.entries()) {
      try {
        const { goal, reimported } = await createGoal(input, context);
        created.push({ index, id: goal.id, title: goal.title, reimported });
      } catch (error) {
        failed.push({
          index,
          title: typeof input?.title === 'string' ? input.title : null,
          code: error?.code ?? 'GOAL_IMPORT_FAILED',
          message: error?.message ?? String(error),
        });
      }
    }
    return { created, failed, goals: await Promise.all(created.map((c) => getGoal(c.id))) };
  }

  async function updateGoal(id, patch = {}, context) {
    const row = requireGoal(id);
    const stamp = now();
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!UPDATABLE_GOAL_FIELDS.has(key)) continue;
      if (key === 'title') {
        // A sub-goal may go back to being an unnamed placeholder; a goal may not.
        const title = row.parent_id ? optionalString(value, 'title') : requiredString(value, 'title');
        fields.push('title = ?'); params.push(title);
      } else if (key === 'notes') {
        fields.push('notes = ?'); params.push(optionalString(value, 'notes', { max: 4000 }) ?? '');
      } else if (key === 'abandoned') {
        // Reversible: you are allowed to change your mind about a week.
        fields.push('abandoned_at = ?'); params.push(value ? stamp : null);
      } else {
        fields.push('position = ?'); params.push(Number(value) || 0);
      }
    }
    if (fields.length === 0) return goalDto(row.parent_id ? requireGoal(row.parent_id) : row);

    const decision = patch.abandoned === undefined
      ? null
      : (patch.abandoned ? 'abandoned' : 'resumed');
    // A step and the goal that owns it are the same table, and a log line that calls
    // both "goal" makes "stopped doing X" unreadable — X is often a step of the thing
    // he did finish.
    const noun = row.parent_id ? 'step' : 'goal';
    mutate({
      action: decision ? `goal.${decision}` : 'goal.update',
      target: id,
      context,
      summary: decision
        ? `${decision === 'abandoned' ? 'Stopped doing' : 'Resumed'} ${noun} "${row.title ?? id}"`
        : `Updated ${noun} ${id}`,
      result: decision ?? 'updated',
    }, () => {
      db.prepare(`UPDATE goals SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...params, stamp, id);
    });
    const fresh = requireGoal(id);
    return goalDto(fresh.parent_id ? requireGoal(fresh.parent_id) : fresh);
  }

  /**
   * Mark a goal (or a step) done, or put it back.
   *
   * The only thing in this module that sets `completed_at`, and it only ever does it
   * because somebody asked. A goal reading 100% stays open until this is called.
   */
  async function setGoalCompletion(id, complete, context) {
    const row = requireGoal(id);
    const stamp = now();
    mutate({
      action: complete ? 'goal.complete' : 'goal.reopen',
      target: id,
      context,
      summary: `${complete ? 'Completed' : 'Reopened'} goal "${row.title ?? id}"`,
      result: complete ? 'completed' : 'reopened',
    }, () => {
      db.prepare('UPDATE goals SET completed_at = ?, updated_at = ? WHERE id = ?').run(complete ? stamp : null, stamp, id);
    });
    const fresh = requireGoal(id);
    return goalDto(fresh.parent_id ? requireGoal(fresh.parent_id) : fresh);
  }

  /**
   * Move a goal to the next period of its own type.
   *
   * Top-level only, and the type never changes — postponing a weekly goal gives you next
   * week, never "a month instead". Everything comes with it: the sub-goals hold no dates
   * of their own, so moving the parent is one row written however many steps hang off it,
   * and logged metric values carry forward untouched.
   *
   * `postponed_count` goes up by one, and nothing ever puts it back down.
   */
  async function postponeGoal(id, context) {
    const row = requireTopLevel(id);
    const from = periodOf(row);
    const to = nextPeriod(from);
    const stamp = now();

    mutate({
      action: 'goal.postpone',
      target: id,
      context,
      summary: `Moved "${row.title}" from ${from.label} to ${to.label}`,
      result: 'postponed',
    }, () => {
      db.prepare(`
        UPDATE goals SET period_start = ?, period_end = ?, postponed_count = postponed_count + 1, updated_at = ?
        WHERE id = ?
      `).run(to.start, to.end, stamp, id);
    });

    return { goal: await goalDto(requireGoal(id)), from, to };
  }

  async function deleteGoal(id, context) {
    const row = requireGoal(id);
    const stamp = now();
    mutate({ action: 'goal.delete', target: id, context, summary: `Deleted goal "${row.title ?? id}"`, result: 'deleted' }, () => {
      // Soft, and the children go with it, so a bad import is recoverable by hand.
      db.prepare('UPDATE goals SET deleted_at = ?, updated_at = ? WHERE id = ? OR parent_id = ?').run(stamp, stamp, id, id);
    });
    return { id, deleted: true };
  }

  async function addSubGoal(parentId, input, context) {
    const parent = requireTopLevel(parentId);
    const stamp = now();
    const id = mutate({ action: 'goal.add_step', target: parentId, context, summary: `Added a step to "${parent.title}"`, result: 'created' }, () => {
      const subId = makeId();
      db.prepare(`
        INSERT INTO goals (id, client_key, title, notes, parent_id, period_type, period_start, period_end,
          completed_at, postponed_count, position, created_at, updated_at, deleted_at)
        VALUES (?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?, ?, NULL)
      `).run(subId, optionalString(input?.title, 'title'), optionalString(input?.notes, 'notes', { max: 2000 }) ?? '',
        parentId, nextPosition('goals', 'parent_id', parentId), stamp, stamp);
      (input?.metrics ?? []).forEach((metric, i) => {
        const metricId = insertMetric(subId, metric, stamp, i);
        // A step added after the fact takes rollup the same way one nested in a
        // `createGoal` payload does. It did not, and a `rollsUpTo` sent here was
        // accepted and silently dropped — the worst shape of all, because the caller
        // is told it worked.
        const target = rollupTargetFor({ parent_id: parentId }, metric);
        if (target) setRollup(metricId, target, stamp);
      });
      return subId;
    });
    return { subGoalId: id, goal: await goalDto(requireGoal(parentId)) };
  }

  async function addMetric(goalId, input, context) {
    const row = requireGoal(goalId);
    const stamp = now();
    const id = mutate({ action: 'goal.add_metric', target: goalId, context, summary: `Tracked "${input?.label}" on "${row.title ?? goalId}"`, result: 'created' }, () => {
      const metricId = insertMetric(goalId, input, stamp, nextPosition('goal_metrics', 'goal_id', goalId));
      const target = rollupTargetFor(row, input);
      if (target) setRollup(metricId, target, stamp);
      return metricId;
    });
    return { metricId: id, goal: await goalDto(requireGoal(row.parent_id ?? goalId)) };
  }

  /**
   * Log against a metric: an absolute `value`, or a `delta` applied in SQL.
   *
   * The delta is `current_value = current_value + ?` inside the transaction rather than a
   * read-then-write, so two agents logging five miles each end up at ten rather than five.
   */
  async function updateMetric(metricId, patch = {}, context) {
    const row = requireMetric(metricId);
    const goal = requireGoal(row.goal_id);
    const stamp = now();
    const hasValue = patch.value !== undefined && patch.value !== null;
    const hasDelta = patch.delta !== undefined && patch.delta !== null;

    if (hasValue && hasDelta) {
      throw domainError('AMBIGUOUS_METRIC_WRITE', 'Pass either value or delta, not both.', { details: { metricId } });
    }
    if ((hasValue || hasDelta) && row.source_kind !== 'manual') {
      throw domainError('METRIC_IS_SOURCED',
        `"${row.label}" is read from ${describeSource(row.source_kind, parsedConfig(row))}, so it cannot be logged by hand. Change its source to manual first.`,
        { status: 409, details: { metricId, sourceKind: row.source_kind } });
    }

    mutate({ action: 'goal.log_metric', target: metricId, context, summary: `Logged "${row.label}" on "${goal.title ?? goal.id}"`, result: 'updated' }, () => {
      if (hasValue) {
        const value = Number(patch.value);
        if (!Number.isFinite(value) || value < 0) {
          throw domainError('INVALID_GOAL_FIELD', 'value must be a number of zero or more.', { details: { field: 'value' } });
        }
        db.prepare('UPDATE goal_metrics SET current_value = ?, updated_at = ? WHERE id = ?').run(value, stamp, metricId);
      } else if (hasDelta) {
        const delta = Number(patch.delta);
        if (!Number.isFinite(delta)) {
          throw domainError('INVALID_GOAL_FIELD', 'delta must be a number.', { details: { field: 'delta' } });
        }
        // max(0, ...) so a correction that overshoots cannot drive a count negative.
        db.prepare('UPDATE goal_metrics SET current_value = max(0, current_value + ?), updated_at = ? WHERE id = ?').run(delta, stamp, metricId);
      }
      if (patch.label !== undefined) {
        db.prepare('UPDATE goal_metrics SET label = ?, updated_at = ? WHERE id = ?').run(requiredString(patch.label, 'label', { max: 80 }), stamp, metricId);
      }
      if (patch.unit !== undefined) {
        db.prepare('UPDATE goal_metrics SET unit = ?, updated_at = ? WHERE id = ?').run(normalizeUnit(patch.unit), stamp, metricId);
      }
      if (patch.targetValue !== undefined) {
        db.prepare('UPDATE goal_metrics SET target_value = ?, updated_at = ? WHERE id = ?').run(positiveNumber(patch.targetValue, 'targetValue'), stamp, metricId);
      }
      if (patch.rollsUpToMetricId !== undefined) setRollup(metricId, patch.rollsUpToMetricId, stamp);
      if (patch.sourceKind !== undefined) setSource(metricId, patch.sourceKind, patch.sourceConfig, stamp);
    });

    const fresh = requireMetric(metricId);
    return {
      metricId,
      // Non-zero only when switching to a connector threw away a hand-logged number.
      discardedValue: patch.sourceKind !== undefined && patch.sourceKind !== 'manual' && row.current_value > 0
        ? row.current_value
        : 0,
      sourceKind: fresh.source_kind,
      goal: await goalDto(requireGoal(goal.parent_id ?? goal.id)),
    };
  }

  async function deleteMetric(metricId, context) {
    const row = requireMetric(metricId);
    const goal = requireGoal(row.goal_id);
    mutate({ action: 'goal.delete_metric', target: metricId, context, summary: `Stopped tracking "${row.label}"`, result: 'deleted' }, () => {
      db.prepare('DELETE FROM goal_metrics WHERE id = ?').run(metricId);
    });
    return { metricId, goal: await goalDto(requireGoal(goal.parent_id ?? goal.id)) };
  }

  async function addLink(goalId, input, context) {
    const row = requireGoal(goalId);
    const stamp = now();
    const id = mutate({ action: 'goal.link', target: goalId, context, summary: `Linked something to "${row.title ?? goalId}"`, result: 'created' },
      () => insertLink(goalId, input, stamp, nextPosition('goal_links', 'goal_id', goalId)));
    return { linkId: id, goal: await goalDto(requireGoal(row.parent_id ?? goalId)) };
  }

  async function deleteLink(linkId, context) {
    const row = db.prepare('SELECT * FROM goal_links WHERE id = ?').get(linkId);
    if (!row) throw domainError('GOAL_LINK_NOT_FOUND', `Link ${linkId} was not found.`, { status: 404, details: { linkId } });
    mutate({ action: 'goal.unlink', target: linkId, context, summary: `Unlinked ${row.label}`, result: 'deleted' }, () => {
      db.prepare('DELETE FROM goal_links WHERE id = ?').run(linkId);
    });
    return { linkId, goal: await goalDto(requireGoal(row.goal_id)) };
  }

  /** What the weekly review and the daily brief read. Never writes anything. */
  async function review({ period = 'this_week' } = {}) {
    const goals = await listGoals({ period });
    const day = today();
    const window = resolvePeriod(period, { now: new Date(now()), tz: timeZone });
    return {
      period: window,
      today: day,
      daysLeft: daysLeft(window, day),
      total: goals.length,
      completed: goals.filter((g) => g.complete).length,
      open: goals.filter((g) => !g.complete).length,
      expiring: goals.filter((g) => !g.complete && g.periodState === 'active' && g.daysLeft <= 2),
      expired: goals.filter((g) => !g.complete && g.periodState === 'expired'),
      // The number that earns this feature its keep: what you have quietly stopped doing.
      repeatedlyPostponed: goals.filter((g) => !g.complete && g.postponedCount >= 3),
      goals,
    };
  }

  return {
    listGoals, getGoal, findGoals, review, windowOf,
    createGoal, createGoals, updateGoal, setGoalCompletion, postponeGoal, deleteGoal,
    addSubGoal, addMetric, updateMetric, deleteMetric, addLink, deleteLink,
  };
}

export { GoalDomainError } from './errors.mjs';
