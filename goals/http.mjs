/**
 * The authenticated `/api/goals*` adapter.
 *
 * Mounted in `bridge.mjs` beside the todo handler and behind the same bearer check. It
 * does no business logic — every route is a thin parse of the request into a service call,
 * and every domain error comes back as a structured `{ error: { code, message, details } }`
 * so the web view can name what went wrong ("that number is read from Strava") instead of
 * flattening it into a generic failure. Same contract `todos/http.mjs` already offers.
 */

import { GoalDomainError } from './errors.mjs';
import { GOAL_PERIOD_SHORTCUTS } from './periods.mjs';
import { ALL_COMMON_UNITS, COMMON_UNITS } from './units.mjs';
import { GOAL_METRIC_SOURCES, GOAL_SPORT_FAMILIES, GOAL_SPORT_FILTERS, STRAVA_MEASURES } from './sources.mjs';

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };

function send(res, status, body) {
  res.writeHead(status, JSON_TYPE);
  res.end(JSON.stringify(body));
}

const errorBody = (error) => ({ error: { code: error.code, message: error.message, details: error.details ?? {} } });

function bad(code, message, status = 400, details = {}) {
  return new GoalDomainError(code, message, { status, details });
}

function decodePart(value) {
  try { return decodeURIComponent(value); }
  catch { throw bad('INVALID_GOAL_PATH', 'Malformed goal identifier.'); }
}

async function readJson(req, maxBodyBytes) {
  const advertised = Number(req.headers['content-length']);
  if (Number.isFinite(advertised) && advertised > maxBodyBytes) {
    throw bad('GOAL_BODY_TOO_LARGE', `Goal request body exceeds ${maxBodyBytes} bytes.`, 413);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw bad('GOAL_BODY_TOO_LARGE', `Goal request body exceeds ${maxBodyBytes} bytes.`, 413);
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw bad('INVALID_JSON', 'Request body must be valid JSON.'); }
}

function queryFrom(url) {
  const params = url.searchParams;
  const query = {};
  // A bare `period=this_week` is a shortcut; `type`+`start` names an explicit window —
  // the period of that type containing that day (plus `end` for a custom range). The
  // dashboard's ‹ › arrows use the second form, handing back a day just outside the
  // window it is showing, which is how it walks to any week without knowing the calendar.
  if (params.has('period')) query.period = params.get('period');
  else if (params.has('type') && params.has('start')) {
    query.period = { type: params.get('type'), start: params.get('start') };
    if (params.has('end')) query.period.end = params.get('end');
  }
  if (params.has('periodType')) query.periodType = params.get('periodType');
  if (params.has('from')) query.from = params.get('from');
  if (params.has('to')) query.to = params.get('to');
  if (params.has('state')) query.state = params.get('state');
  if (params.get('includeCompleted') === 'false') query.includeCompleted = false;
  return query;
}

export function createGoalHttpHandler({ service, maxBodyBytes = 1_000_000 } = {}) {
  if (!service) throw new TypeError('createGoalHttpHandler requires service');

  return async function goalHttpHandler(req, res, suppliedUrl) {
    const url = suppliedUrl instanceof URL ? suppliedUrl : new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path !== '/api/goals' && !path.startsWith('/api/goals/')) return false;
    const context = { actor: 'http', reason: `${req.method} ${path}` };

    try {
      if (req.method === 'GET' && path === '/api/goals') {
        const query = queryFrom(url);
        // The resolved window rides along so an empty period can still be named.
        const period = query.period ? service.windowOf(query.period) : null;
        send(res, 200, { goals: await service.listGoals(query), period });
        return true;
      }

      // Everything the composer needs to offer choices without hard-coding them in the
      // client: the period shortcuts, the unit suggestions, and the metric sources.
      if (req.method === 'GET' && path === '/api/goals/options') {
        send(res, 200, {
          periods: GOAL_PERIOD_SHORTCUTS,
          units: COMMON_UNITS,
          allUnits: ALL_COMMON_UNITS,
          sources: GOAL_METRIC_SOURCES,
          measures: STRAVA_MEASURES,
          sports: GOAL_SPORT_FILTERS,
          sportFamilies: GOAL_SPORT_FAMILIES,
        });
        return true;
      }

      if (req.method === 'GET' && path === '/api/goals/review') {
        send(res, 200, await service.review({ period: url.searchParams.get('period') || 'this_week' }));
        return true;
      }

      if (req.method === 'GET' && path === '/api/goals/search') {
        const query = url.searchParams.get('q') ?? '';
        if (!query.trim()) throw bad('MISSING_QUERY', 'Pass a search query.');
        send(res, 200, { goals: await service.findGoals(query, { limit: url.searchParams.get('limit') ?? 20 }) });
        return true;
      }

      if (req.method === 'POST' && path === '/api/goals') {
        const body = await readJson(req, maxBodyBytes);
        if (Array.isArray(body.goals)) {
          send(res, 200, await service.createGoals(body.goals, context));
          return true;
        }
        send(res, 200, await service.createGoal(body, context));
        return true;
      }

      if (req.method === 'PATCH' && path === '/api/goals/metrics') {
        const { id, ...patch } = await readJson(req, maxBodyBytes);
        if (!id) throw bad('MISSING_METRIC_ID', 'missing id');
        send(res, 200, await service.updateMetric(id, patch, context));
        return true;
      }

      if (req.method === 'DELETE' && path === '/api/goals/metrics') {
        const { id } = await readJson(req, maxBodyBytes);
        if (!id) throw bad('MISSING_METRIC_ID', 'missing id');
        send(res, 200, await service.deleteMetric(id, context));
        return true;
      }

      if (req.method === 'DELETE' && path === '/api/goals/links') {
        const { id } = await readJson(req, maxBodyBytes);
        if (!id) throw bad('MISSING_LINK_ID', 'missing id');
        send(res, 200, await service.deleteLink(id, context));
        return true;
      }

      const byId = /^\/api\/goals\/([^/]+)$/.exec(path);
      if (byId) {
        const id = decodePart(byId[1]);
        if (req.method === 'GET') { send(res, 200, { goal: await service.getGoal(id) }); return true; }
        if (req.method === 'PATCH') {
          send(res, 200, { goal: await service.updateGoal(id, await readJson(req, maxBodyBytes), context) });
          return true;
        }
        if (req.method === 'DELETE') { send(res, 200, await service.deleteGoal(id, context)); return true; }
      }

      const action = /^\/api\/goals\/([^/]+)\/(complete|postpone|steps|metrics|links)$/.exec(path);
      if (action && req.method === 'POST') {
        const id = decodePart(action[1]);
        const input = await readJson(req, maxBodyBytes);
        if (action[2] === 'complete') {
          // Explicit in the payload rather than inferred, so reopening is the same route.
          send(res, 200, { goal: await service.setGoalCompletion(id, input.complete !== false, context) });
          return true;
        }
        if (action[2] === 'postpone') { send(res, 200, await service.postponeGoal(id, context)); return true; }
        if (action[2] === 'steps') { send(res, 200, await service.addSubGoal(id, input, context)); return true; }
        if (action[2] === 'metrics') { send(res, 200, await service.addMetric(id, input, context)); return true; }
        send(res, 200, await service.addLink(id, input, context));
        return true;
      }

      return false;
    } catch (error) {
      if (error instanceof GoalDomainError) {
        send(res, error.status, errorBody(error));
        return true;
      }
      // A period the caller invented ("last_week") arrives as a plain Error from the pure
      // module; it is still the caller's mistake, not a crash.
      if (/unknown period|not a day key|cannot end before|needs a type/i.test(error?.message ?? '')) {
        send(res, 400, errorBody({ code: 'INVALID_PERIOD', message: error.message, details: {} }));
        return true;
      }
      throw error;
    }
  };
}
