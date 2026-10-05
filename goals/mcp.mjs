/**
 * The `totem_*_goal(s)` MCP tools.
 *
 * MCP is a primary write surface here rather than a mirror of the UI, which is the real
 * departure from the task tools next door. The authoring path for a goal is a photograph
 * of a paper notebook read by a model, so these are shaped for an agent acting in one
 * pass without a human watching:
 *
 * - `totem_create_goals` takes a **whole period at once**, sub-goals and metrics nested
 *   inline, and reports per-row failures rather than refusing the batch.
 * - Periods are **named shortcuts resolved on this box** (`this_week`), never ISO dates a
 *   model has to derive from a photo, a week-start convention and a timezone.
 * - `clientKey` makes photographing the same page twice a no-op instead of a doubled week.
 * - `totem_find_goals` is the name-to-id resolver, so a follow-up ("log 12 miles") does
 *   not need an id nobody has seen.
 *
 * ## The open-world hints are the opposite way round from the task tools
 *
 * That is deliberate, not a copy-paste slip. A task *write* can reach GitHub or a Sheet,
 * so it declares an open world while reads stay local. A goal write never leaves this box
 * — there is nothing downstream to tell. A goal *read* can, because a Strava-sourced
 * metric resolves against the connector. So reads here are the open ones.
 */

import { GoalDomainError } from './errors.mjs';
import { GOAL_PERIOD_SHORTCUTS } from './periods.mjs';
import { ALL_COMMON_UNITS } from './units.mjs';
import { GOAL_METRIC_SOURCES, STRAVA_MEASURES } from './sources.mjs';

const ANN_READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
const ANN_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const ANN_EDIT = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });

const S_STR = { type: 'string' };
const S_NUM = { type: 'number' };
const S_BOOL = { type: 'boolean' };
const S_OBJ = { type: 'object' };
const S_LIST = (description) => ({ type: 'array', items: S_OBJ, description });
const out = (properties, required = ['fetchedAt']) => ({
  type: 'object',
  properties: { fetchedAt: { type: 'string', description: 'ISO timestamp for this result.' }, ...properties },
  required,
});

const PERIOD_SCHEMA = {
  type: 'string',
  enum: GOAL_PERIOD_SHORTCUTS,
  description: 'The goal cadence and window, resolved on the server from its own clock. Weekly: last_week, this_week or next_week. Monthly: last_month, this_month or next_month. Yearly: last_year, this_year or next_year. Weeks run Monday to Sunday in the owner\'s local time. Default this_week. last_* is for reading and reviewing what just ended ("how did last week go"); file new goals into this_* or next_*. Do not file quarterly goals: the dashboard shows week, month and year, and a quarterly goal would be created where he never looks.',
};

const METRIC_SCHEMA = {
  type: 'object',
  description: 'A number being tracked. A goal OR a step may track several at once — "rides" and "miles" on the same step, each with its own bar — and a goal or step with none is tracked by completion alone.',
  properties: {
    label: { type: 'string', description: 'What is counted, in his words — "miles run", "pages".' },
    unit: { type: 'string', description: `Free text, lowercased on write. Prefer a common one: ${ALL_COMMON_UNITS.slice(0, 18).join(', ')}…` },
    targetValue: { type: 'number', exclusiveMinimum: 0, description: 'What counts as done.' },
    currentValue: { type: 'number', minimum: 0, description: 'Progress so far. Manual metrics only.' },
    sourceKind: {
      type: 'string',
      enum: GOAL_METRIC_SOURCES,
      description: 'manual (default) means he logs it. strava_distance reads activities inside the period; strava_gear_odometer reads one bike\'s lifetime odometer. A sourced metric cannot be logged by hand.',
    },
    sourceConfig: {
      type: 'object',
      description: 'For a Strava source: { sport?: "Ride"|"Run", gearId?, measure? }. gearId is required for an odometer.',
      properties: {
        sport: S_STR,
        gearId: S_STR,
        measure: { type: 'string', enum: STRAVA_MEASURES, description: 'Default distanceMi.' },
      },
    },
    rollsUpTo: {
      type: 'string',
      description: 'On a step\'s metric only: the exact label of the parent goal\'s metric this feeds — matched within this payload when creating a goal, and against the goal\'s existing numbers when adding to a step that is already there. A label naming nothing is refused rather than dropped. Omit for a number that stands alone, which is the usual case: a step\'s numbers count toward the goal on their own.',
    },
  },
  required: ['label', 'targetValue'],
};

const GOAL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'What he wants to be true by the end of the period.' },
    notes: S_STR,
    period: PERIOD_SCHEMA,
    clientKey: {
      type: 'string',
      description: 'Stable id for this line of the source (e.g. "notebook-2026-09-13-3"). Re-importing the same key updates the goal instead of creating a second one. Always set it when importing from a photo.',
    },
    metrics: { type: 'array', items: METRIC_SCHEMA },
    subGoals: {
      type: 'array',
      description: 'Steps inside this goal. One level only — a step cannot have steps. They inherit the period and can carry their own metrics, as many each as they need; a step with numbers counts how far through them it is rather than waiting to be ticked.',
      items: {
        type: 'object',
        properties: { title: S_STR, notes: S_STR, metrics: { type: 'array', items: METRIC_SCHEMA } },
      },
    },
    links: {
      type: 'array',
      description: 'Bookmarks: an existing Totem task, or a url. Never synced — a link says "related", not "kept in step".',
      items: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['todo', 'url'] }, todoId: S_STR, url: S_STR, label: S_STR },
      },
    },
  },
  required: ['title'],
};

export function createGoalMcpTools({ service, fetchedAt = () => new Date().toISOString() } = {}) {
  if (!service) throw new TypeError('createGoalMcpTools requires service');

  const contextFor = (session, reason) => ({ actor: session?.actor ?? 'mcp', reason: `mcp: ${reason}` });
  const required = (input, field) => {
    if (!input?.[field]) throw new GoalDomainError(`MISSING_${field.toUpperCase()}`, `${field} is required.`);
    return input[field];
  };

  return {
    async totem_get_goals(input = {}) {
      const goals = await service.listGoals({
        period: input.period ?? null,
        includeCompleted: input.includeCompleted !== false,
        state: input.state ?? null,
      });
      return { goals, count: goals.length, fetchedAt: fetchedAt() };
    },

    async totem_get_goal(input = {}) {
      return { goal: await service.getGoal(required(input, 'id')), fetchedAt: fetchedAt() };
    },

    async totem_find_goals(input = {}) {
      const goals = await service.findGoals(required(input, 'query'), { limit: input.limit });
      return { goals, count: goals.length, fetchedAt: fetchedAt() };
    },

    async totem_goal_review(input = {}) {
      return { ...(await service.review({ period: input.period ?? 'this_week' })), fetchedAt: fetchedAt() };
    },

    async totem_create_goals(input = {}, session) {
      const goals = Array.isArray(input.goals) ? input.goals : [input];
      const result = await service.createGoals(goals, contextFor(session, 'create goals'));
      return { ok: result.failed.length === 0, ...result, fetchedAt: fetchedAt() };
    },

    async totem_update_goal(input = {}, session) {
      const { id, ...patch } = input;
      required(input, 'id');
      return { ok: true, goal: await service.updateGoal(id, patch, contextFor(session, 'update goal')), fetchedAt: fetchedAt() };
    },

    async totem_complete_goal(input = {}, session) {
      const complete = input.complete !== false;
      const goal = await service.setGoalCompletion(required(input, 'id'), complete, contextFor(session, 'complete goal'));
      return { ok: true, completed: complete, goal, fetchedAt: fetchedAt() };
    },

    async totem_postpone_goal(input = {}, session) {
      const result = await service.postponeGoal(required(input, 'id'), contextFor(session, 'postpone goal'));
      return { ok: true, ...result, fetchedAt: fetchedAt() };
    },

    async totem_delete_goal(input = {}, session) {
      return { ok: true, ...(await service.deleteGoal(required(input, 'id'), contextFor(session, 'delete goal'))), fetchedAt: fetchedAt() };
    },

    async totem_add_goal_step(input = {}, session) {
      const { goalId, ...step } = input;
      required(input, 'goalId');
      return { ok: true, ...(await service.addSubGoal(goalId, step, contextFor(session, 'add goal step'))), fetchedAt: fetchedAt() };
    },

    async totem_add_goal_metric(input = {}, session) {
      const { goalId, ...metric } = input;
      required(input, 'goalId');
      return { ok: true, ...(await service.addMetric(goalId, metric, contextFor(session, 'add goal metric'))), fetchedAt: fetchedAt() };
    },

    async totem_log_goal_metric(input = {}, session) {
      const { metricId, ...patch } = input;
      required(input, 'metricId');
      const editsSomethingElse = ['label', 'unit', 'targetValue', 'rollsUpToMetricId', 'sourceKind']
        .some((field) => patch[field] !== undefined);
      if (patch.value === undefined && patch.delta === undefined && !editsSomethingElse) {
        throw new GoalDomainError('MISSING_METRIC_VALUE', 'Pass value (absolute) or delta (relative), or a field to change.');
      }
      return { ok: true, ...(await service.updateMetric(metricId, patch, contextFor(session, 'log goal metric'))), fetchedAt: fetchedAt() };
    },

    async totem_delete_goal_metric(input = {}, session) {
      return { ok: true, ...(await service.deleteMetric(required(input, 'metricId'), contextFor(session, 'delete goal metric'))), fetchedAt: fetchedAt() };
    },

    async totem_link_goal(input = {}, session) {
      const { goalId, ...link } = input;
      required(input, 'goalId');
      return { ok: true, ...(await service.addLink(goalId, link, contextFor(session, 'link goal'))), fetchedAt: fetchedAt() };
    },

    async totem_unlink_goal(input = {}, session) {
      return { ok: true, ...(await service.deleteLink(required(input, 'linkId'), contextFor(session, 'unlink goal'))), fetchedAt: fetchedAt() };
    },
  };
}

export const GOAL_MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'totem_get_goals',
    title: 'Read goals',
    description: 'Read the owner\'s goals for a period, with progress, steps, metrics and links resolved. A step carries its own metrics under subGoals[].metrics and its own progress. A metric fed by a connector reports available:false with a reason when it cannot be read — that is not zero progress.',
    inputSchema: {
      type: 'object',
      properties: {
        period: PERIOD_SCHEMA,
        includeCompleted: { type: 'boolean', description: 'Default true.' },
        state: { type: 'string', enum: ['upcoming', 'active', 'expired'] },
      },
      additionalProperties: false,
    },
    annotations: ANN_READ,
    outputSchema: out({ goals: S_LIST('Top-level goals with their steps nested.'), count: S_NUM }, ['fetchedAt', 'goals', 'count']),
  },
  {
    name: 'totem_get_goal',
    title: 'Read one goal',
    description: 'Read a single goal by id. Passing the id of a step answers with the goal that owns it.',
    inputSchema: { type: 'object', properties: { id: S_STR }, required: ['id'], additionalProperties: false },
    annotations: ANN_READ,
    outputSchema: out({ goal: S_OBJ }, ['fetchedAt', 'goal']),
  },
  {
    name: 'totem_find_goals',
    title: 'Find goals by name',
    description: 'Resolve a name to a goal, so a follow-up action does not need an id. Matching a step answers with its parent goal.',
    inputSchema: {
      type: 'object',
      properties: { query: S_STR, limit: { type: 'number', minimum: 1, maximum: 100 } },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: ANN_READ,
    outputSchema: out({ goals: S_LIST('Matching goals.'), count: S_NUM }, ['fetchedAt', 'goals', 'count']),
  },
  {
    name: 'totem_goal_review',
    title: 'Review a period',
    description: 'Summarise a period: how many are done, what is expiring within two days, what has already expired, and which goals have been postponed three or more times — the ones he has quietly stopped doing.',
    inputSchema: { type: 'object', properties: { period: PERIOD_SCHEMA }, additionalProperties: false },
    annotations: ANN_READ,
    outputSchema: out({
      period: S_OBJ, total: S_NUM, completed: S_NUM, open: S_NUM, daysLeft: S_NUM,
      expiring: S_LIST('Open goals with two days or fewer left.'),
      expired: S_LIST('Open goals whose window has closed.'),
      repeatedlyPostponed: S_LIST('Open goals postponed three or more times.'),
    }, ['fetchedAt', 'period', 'total']),
  },
  {
    name: 'totem_create_goals',
    title: 'Create goals',
    description: 'Create one goal or a whole weekly, monthly, or yearly period at once, with steps and metrics nested inline. Set period to this_month/next_month for monthly goals or this_year/next_year for yearly goals. Each goal is its own transaction, so one bad row is reported in failed[] rather than costing the rest. Always pass clientKey when importing from a photo or a document: re-running the same import then updates rather than duplicating.',
    inputSchema: {
      type: 'object',
      properties: { goals: { type: 'array', items: GOAL_INPUT_SCHEMA }, ...GOAL_INPUT_SCHEMA.properties },
      anyOf: [{ required: ['goals'] }, { required: ['title'] }],
      additionalProperties: false,
    },
    annotations: ANN_WRITE,
    outputSchema: out({ ok: S_BOOL, created: S_LIST('What landed.'), failed: S_LIST('Per-row failures, with the index and reason.'), goals: S_LIST('The created goals.') }, ['fetchedAt', 'ok', 'created', 'failed']),
  },
  {
    name: 'totem_update_goal',
    title: 'Update a goal',
    description: 'Change a goal\'s title, note or order, or mark it as one he is no longer doing. Works on a step id too. `notes` is a single free-text note on the goal — a reminder, or why it ended the way it did — and writing it replaces what was there. `abandoned` resolves a goal without claiming it was achieved: it stops counting toward "done", stays visible in the list crossed off, and is reversible with false. On a STEP it is the same decision at a smaller scale — the add-on he knows he is not getting to while the goal itself still lands: the step leaves the steps count entirely rather than reading as undone, so the goal can still finish at 100%. Never set abandoned unless the owner says he is not doing it; the period is fixed at creation — use totem_postpone_goal to move it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: S_STR,
        title: S_STR,
        notes: S_STR,
        position: S_NUM,
        abandoned: { type: 'boolean', description: 'True to stop doing this goal or step, false to pick it back up.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: ANN_EDIT,
    outputSchema: out({ ok: S_BOOL, goal: S_OBJ }, ['fetchedAt', 'ok', 'goal']),
  },
  {
    name: 'totem_complete_goal',
    title: 'Complete or reopen a goal',
    description: 'Mark a goal or a step done, or put it back. Completion is always explicit: a goal whose metrics all read 100% is still not complete until this is called, because the point of a goal is noticing that he finished it. Works on a step id too.',
    inputSchema: {
      type: 'object',
      properties: { id: S_STR, complete: { type: 'boolean', description: 'Default true. Pass false to reopen.' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: ANN_EDIT,
    outputSchema: out({ ok: S_BOOL, completed: S_BOOL, goal: S_OBJ }, ['fetchedAt', 'ok', 'goal']),
  },
  {
    name: 'totem_postpone_goal',
    title: 'Move a goal to the next period',
    description: 'Move a goal to the next period of its own type — a weekly goal goes to next week, never to a month. Steps and logged progress come with it, and its postponed count goes up by one and is never reset. Top-level goals only. Ask him before calling this: the count is the signal that he has been avoiding something, so it should only ever go up because he decided it should.',
    inputSchema: { type: 'object', properties: { id: S_STR }, required: ['id'], additionalProperties: false },
    annotations: ANN_EDIT,
    outputSchema: out({ ok: S_BOOL, goal: S_OBJ, from: S_OBJ, to: S_OBJ }, ['fetchedAt', 'ok', 'goal']),
  },
  {
    name: 'totem_delete_goal',
    title: 'Delete a goal',
    description: 'Soft-delete a goal and its steps. Recoverable in the database, but there is no undo in the interface — prefer completing or postponing.',
    inputSchema: { type: 'object', properties: { id: S_STR }, required: ['id'], additionalProperties: false },
    annotations: ANN_EDIT,
    outputSchema: out({ ok: S_BOOL, id: S_STR, deleted: S_BOOL }, ['fetchedAt', 'ok', 'deleted']),
  },
  {
    name: 'totem_add_goal_step',
    title: 'Add a step to a goal',
    description: 'Add a step inside an existing goal, with any numbers it tracks. Steps inherit the goal\'s period and cannot have steps of their own. A step may have no title — three unnamed placeholders is a legal state. A step may track several numbers at once, and each may name a number on the parent goal with rollsUpTo.',
    inputSchema: {
      type: 'object',
      properties: { goalId: S_STR, title: S_STR, notes: S_STR, metrics: { type: 'array', items: METRIC_SCHEMA } },
      required: ['goalId'],
      additionalProperties: false,
    },
    annotations: ANN_WRITE,
    outputSchema: out({ ok: S_BOOL, subGoalId: S_STR, goal: S_OBJ }, ['fetchedAt', 'ok', 'goal']),
  },
  {
    name: 'totem_add_goal_metric',
    title: 'Track a number on a goal',
    description: 'Add a number to a goal or one of its steps — goalId takes either, a step\'s id being subGoals[].id from totem_get_goal. Both may track several numbers at once ("rides" and "miles" on one step). A step with numbers on it counts how far through them it is, so the goal moves as they are logged rather than only when the step is ticked. Pass rollsUpToMetricId (or rollsUpTo, the parent number\'s exact label) to feed a number on the parent goal — only a step may do that, only onto its own parent, and never onto a connector-sourced number, which already counts everything in the period.',
    inputSchema: {
      type: 'object',
      properties: { goalId: { type: 'string', description: 'The goal, or one of its steps.' }, rollsUpToMetricId: S_STR, ...METRIC_SCHEMA.properties },
      required: ['goalId', 'label', 'targetValue'],
      additionalProperties: false,
    },
    annotations: ANN_WRITE,
    outputSchema: out({ ok: S_BOOL, metricId: S_STR, goal: S_OBJ }, ['fetchedAt', 'ok', 'goal']),
  },
  {
    name: 'totem_log_goal_metric',
    title: 'Log progress against a number',
    description: 'Record progress. Pass exactly one of value (absolute) or delta (relative — "I ran another 3 miles"). A delta is applied in SQL, so two logs of 5 make 10. A connector-sourced metric refuses both: its number belongs to the connector.',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: S_STR,
        value: { type: 'number', minimum: 0, description: 'Set the total to this.' },
        delta: { type: 'number', description: 'Add this to the total. May be negative; the total never goes below zero.' },
        label: S_STR, unit: S_STR, targetValue: { type: 'number', exclusiveMinimum: 0 },
        rollsUpToMetricId: { type: ['string', 'null'], description: 'Feed a number on the parent goal, or null to detach.' },
        sourceKind: {
          type: 'string',
          enum: GOAL_METRIC_SOURCES,
          description: 'Change where the number comes from. Switching to a connector DISCARDS whatever was logged by hand, because the connector then owns the number — the discarded amount comes back in discardedValue. Switching to manual hands it back to him.',
        },
        sourceConfig: METRIC_SCHEMA.properties.sourceConfig,
      },
      required: ['metricId'],
      additionalProperties: false,
    },
    annotations: ANN_EDIT,
    outputSchema: out({ ok: S_BOOL, metricId: S_STR, sourceKind: S_STR, discardedValue: S_NUM, goal: S_OBJ }, ['fetchedAt', 'ok', 'goal']),
  },
  {
    name: 'totem_delete_goal_metric',
    title: 'Stop tracking a number',
    description: 'Remove a metric from a goal. Anything feeding it becomes standalone rather than being deleted.',
    inputSchema: { type: 'object', properties: { metricId: S_STR }, required: ['metricId'], additionalProperties: false },
    annotations: ANN_EDIT,
    outputSchema: out({ ok: S_BOOL, metricId: S_STR, goal: S_OBJ }, ['fetchedAt', 'ok', 'goal']),
  },
  {
    name: 'totem_link_goal',
    title: 'Bookmark something on a goal',
    description: 'Point a goal at an existing Totem task or a url. A bookmark only — nothing syncs, and completing the task does not complete the goal. Linking the same task twice is a no-op.',
    inputSchema: {
      type: 'object',
      properties: { goalId: S_STR, kind: { type: 'string', enum: ['todo', 'url'] }, todoId: S_STR, url: S_STR, label: S_STR },
      required: ['goalId'],
      additionalProperties: false,
    },
    annotations: ANN_WRITE,
    outputSchema: out({ ok: S_BOOL, linkId: S_STR, goal: S_OBJ }, ['fetchedAt', 'ok', 'goal']),
  },
  {
    name: 'totem_unlink_goal',
    title: 'Remove a bookmark',
    description: 'Remove a bookmark from a goal. The task or page it pointed at is untouched.',
    inputSchema: { type: 'object', properties: { linkId: S_STR }, required: ['linkId'], additionalProperties: false },
    annotations: ANN_EDIT,
    outputSchema: out({ ok: S_BOOL, linkId: S_STR, goal: S_OBJ }, ['fetchedAt', 'ok', 'goal']),
  },
]);

export function goalMcpResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

/** The in-process client the gateway aggregates as `goals__*`. */
export function createGoalMcpClient(options) {
  const tools = createGoalMcpTools(options);
  const definitions = GOAL_MCP_TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    name: definition.name.replace(/^totem_/, ''),
  }));
  const index = new Map(definitions.map((definition) => [definition.name, definition]));
  return {
    async start() {},
    async listTools() { return definitions; },
    async callTool(name, args) {
      if (!index.has(name)) throw new Error(`unknown goal tool: ${name}`);
      return goalMcpResult(await tools[`totem_${name}`](args, { actor: 'mcp-gateway' }));
    },
    close() {},
  };
}
