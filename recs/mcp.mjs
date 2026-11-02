import { RecDomainError } from './errors.mjs';
import { DECISIONS, DECLINED_WINDOW_DAYS, OUTCOMES } from './service.mjs';

// The rule every agent with these tools is given, in the gateway's instructions
// (`recs__`) and the bridge's /mcp instructions (`totem_recs_`). Each tool's
// description carries only the clause it needs.
export const recPromptRule = (prefix = 'recs__') =>
  `Before recommending something, check the owner's ledger with ${prefix}list (similarTo, declinedWithinDays ${DECLINED_WINDOW_DAYS}) `
  + `and do not suggest again what he declined in the last ${DECLINED_WINDOW_DAYS} days unless circumstances changed, then say what changed. `
  + `Record a real recommendation with ${prefix}record; only he decides it, in the dashboard.`;
export const REC_PROMPT_RULE = recPromptRule();

const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const EDIT = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
const S = { type: 'string' };
const N = { type: 'number' };
const O = { type: 'object' };
const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const output = (properties, required) => ({
  type: 'object', properties: { fetchedAt: { type: 'string' }, ...properties }, required: ['fetchedAt', ...required],
});
const recs = { type: 'array', items: O };
const stats = { type: 'object', description: 'The ledger\'s track record; `line` is the one-line summary (hit rate, acceptance, cost).' };

export function createRecMcpTools({ service, fetchedAt = () => new Date().toISOString() } = {}) {
  if (!service) throw new TypeError('createRecMcpTools requires service');
  const required = (input, field) => {
    if (!input?.[field]) throw new RecDomainError(`MISSING_${field.toUpperCase()}`, `${field} is required.`);
    return input[field];
  };
  // No `via` here, ever: that is what keeps a decision out of an agent's reach.
  const context = (session, reason) => ({ actor: session?.actor ?? session?.client ?? 'mcp', reason: `mcp: ${reason}` });
  const stamp = (body) => ({ ...body, fetchedAt: fetchedAt() });
  return {
    async totem_recs_record(input = {}, session) {
      return stamp({ ok: true, ...(await service.record(input, context(session, 'record recommendation'))) });
    },
    async totem_recs_list(input = {}) {
      if (input.id) return stamp({ rec: await service.get(input.id), stats: await service.stats() });
      return stamp(await service.list(input));
    },
    async totem_recs_set_outcome(input = {}, session) {
      const { id, ...rest } = input;
      return stamp({ ok: true, ...(await service.setOutcome(required(input, 'id'), rest, context(session, 'set recommendation outcome'))) });
    },
  };
}

export const REC_MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'totem_recs_record', title: 'Record a recommendation',
    description: 'Add a recommendation you are making to the owner\'s ledger, with its evidence; it starts pending and he decides it. '
      + `Refused if he declined something like it in the last ${DECLINED_WINDOW_DAYS} days unless changed says what changed, and refused as a duplicate of one still open.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { ...S, description: 'The recommendation in a few words, as an action ("Buy a standing desk").' },
        body: { ...S, description: 'What exactly, and why.' },
        evidence: { ...S, description: 'What it rests on: the data, readings or sources.' },
        costUsd: { ...N, minimum: 0, description: 'What saying yes costs, in US dollars.' },
        source: { ...S, description: 'Who recommends it: your chat id as "chat:<id>", or "totem:<id>".' },
        actBy: { ...DAY, description: 'YYYY-MM-DD after which it is no longer worth doing.' },
        changed: { ...S, description: 'What has changed since he declined something like it.' },
      },
      required: ['title', 'source'],
      additionalProperties: false,
    },
    annotations: WRITE,
    outputSchema: output({ ok: { type: 'boolean' }, rec: O, declinedSimilar: recs, openSimilar: recs }, ['ok', 'rec', 'declinedSimilar', 'openSimilar']),
  },
  {
    name: 'totem_recs_list', title: 'Read the recommendations ledger',
    description: 'Read the owner\'s recommendations with their decisions, outcomes and the hit-rate line; '
      + `similarTo with declinedWithinDays ${DECLINED_WINDOW_DAYS} finds what he declined that resembles a suggestion. Filter by decision or source, or pass id for one.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: S,
        decision: { anyOf: [{ type: 'string', enum: DECISIONS }, { type: 'array', items: { type: 'string', enum: DECISIONS } }] },
        source: S,
        similarTo: { ...S, description: 'Keywords; matches recommendations whose title or body share them.' },
        declinedWithinDays: { ...N, exclusiveMinimum: 0, description: 'Only recommendations declined within this many days.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    annotations: READ,
    outputSchema: output({ recs, rec: O, count: N, stats }, ['stats']),
  },
  {
    name: 'totem_recs_set_outcome', title: 'Record how a recommendation turned out',
    description: `Record the measured outcome of a recommendation the owner accepted: ${OUTCOMES.join(', ')}, with a note on what was measured. `
      + 'Accepted ones only; it is labelled as agent-reported, and an outcome he set himself cannot be changed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: S,
        outcome: { type: 'string', enum: OUTCOMES },
        note: { ...S, description: 'What was measured, and the numbers.' },
      },
      required: ['id', 'outcome'],
      additionalProperties: false,
    },
    annotations: EDIT,
    outputSchema: output({ ok: { type: 'boolean' }, rec: O }, ['ok', 'rec']),
  },
]);

export function createRecMcpClient(options) {
  const tools = createRecMcpTools(options);
  const definitions = REC_MCP_TOOL_DEFINITIONS.map((tool) => ({ ...tool, name: tool.name.replace(/^totem_recs_/, '') }));
  const names = new Set(definitions.map((tool) => tool.name));
  return {
    async start() {}, async listTools() { return definitions; },
    async callTool(name, args) {
      if (!names.has(name)) throw new Error(`unknown recommendation tool: ${name}`);
      const payload = await tools[`totem_recs_${name}`](args, { actor: 'mcp-gateway' });
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    },
    close() {},
  };
}
