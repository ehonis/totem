/**
 * Away spans for agents: read them, and propose a new one through the inbox.
 *
 * There is deliberately no create, update or delete tool. A trip found in an email or a
 * calendar invite is an inference, and AGENTS.md §5 makes anything inferred confirm-only:
 * `totem_away_propose` stages an `away` inbox item and the span exists only once the owner
 * accepts it. The bridge registers these on /mcp; the gateway re-serves them as away__*.
 */

import { todayKey } from '../goals/periods.mjs';
import { AWAY_KINDS, awayOn } from './days.mjs';
import { normalizeSpan } from './store.mjs';

const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const STAGE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const S = { type: 'string' };
const B = { type: 'boolean' };
const N = { type: 'number' };
const O = { type: 'object' };
const NULLABLE_O = { type: ['object', 'null'] };
const output = (properties, required) => ({
  type: 'object', properties: { fetchedAt: S, ...properties }, required: ['fetchedAt', ...required],
});
const DAY = { type: 'string', description: 'A local date, YYYY-MM-DD. Resolve relative dates against the date table first.' };

export const AWAY_MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'totem_away_list',
    title: 'Read away spans',
    description:
      'The owner\'s away spans (trips, days off): today\'s, if any, and those still to come. Check this before '
      + 'scheduling, dating a task or planning a reminder. includePast also returns finished spans.',
    inputSchema: { type: 'object', properties: { includePast: B }, additionalProperties: false },
    annotations: READ,
    outputSchema: output({
      today: { ...S, description: 'Today as YYYY-MM-DD in the owner\'s time zone.' },
      awayToday: { ...NULLABLE_O, description: 'The span covering today, or null.' },
      spans: { type: 'array', items: O, description: '{ id, start, end, label, kind, note? }, start and end inclusive.' },
      count: N,
    }, ['today', 'spans', 'count']),
  },
  {
    name: 'totem_away_propose',
    title: 'Propose an away span (owner confirms)',
    description:
      'Propose a trip or day off for the owner to confirm. This does NOT add it: it lands in the Totem inbox as an '
      + '`away` proposal and becomes an away span only when the owner accepts it. Use it when an email, a booking or '
      + 'the calendar shows the owner will be away on dates not already listed by totem_away_list. The same dates are '
      + 'proposed once: a repeat returns the earlier proposal (open, accepted or denied) instead. start and end are '
      + `inclusive local dates; kind is one of ${AWAY_KINDS.join(', ')}. why says what the evidence is, for the owner to read.`,
    inputSchema: {
      type: 'object',
      properties: {
        start: DAY,
        end: { ...DAY, description: 'Last away day, inclusive. Defaults to start.' },
        label: { ...S, description: 'Short name, e.g. "Lisbon" or "Thanksgiving". Shown on the calendar.' },
        kind: { type: 'string', enum: AWAY_KINDS },
        note: { ...S, description: 'Optional detail kept with the span (flight times, who to call).' },
        why: { ...S, description: 'The evidence, in a sentence: which email or event shows this. Required.' },
      },
      required: ['start', 'label', 'why'],
      additionalProperties: false,
    },
    annotations: STAGE,
    outputSchema: output({
      id: { ...S, description: 'The inbox P-id of the proposal.' },
      staged: { ...B, description: 'True when it is waiting in the inbox.' },
      created: { ...B, description: 'Always false: only the owner accepting it creates the span.' },
      span: O,
      alreadyListed: { ...NULLABLE_O, description: 'An existing span with the same dates; nothing was staged.' },
      alreadyProposed: { ...NULLABLE_O, description: '{ id, status } of an earlier proposal for the same dates (open, accepted or denied); nothing was staged.' },
      nextStep: S,
    }, ['staged', 'created']),
  },
]);

/**
 * `store` is read only here (snapshot). `stage` is the bridge's inbox stager; it is the
 * only way a span leaves this module.
 */
export function createAwayMcpTools({ store, stage, tz, now = () => new Date(), fetchedAt = () => new Date().toISOString() } = {}) {
  if (!store || typeof store.snapshot !== 'function') throw new TypeError('createAwayMcpTools requires store');
  if (typeof stage !== 'function') throw new TypeError('createAwayMcpTools requires stage');
  const stamp = (body) => ({ ...body, fetchedAt: fetchedAt() });
  return {
    async totem_away_list(input = {}) {
      const today = todayKey(now(), tz);
      const all = store.snapshot();
      const spans = input.includePast ? all : all.filter((s) => s.end >= today);
      return stamp({ today, awayToday: awayOn(all, today), spans, count: spans.length });
    },

    async totem_away_propose(input = {}, session) {
      const span = normalizeSpan(input);
      const why = String(input.why || '').trim();
      if (why.length < 8) throw new Error('why is required: say which email or event shows the owner is away');
      const same = store.snapshot().find((s) => s.start === span.start && s.end === span.end);
      if (same) {
        return stamp({ staged: false, created: false, span, alreadyListed: same, alreadyProposed: null, nextStep: 'Already listed; nothing to propose.' });
      }
      // The session goes along so the proposal remembers the chat that asked (chat/inbox-outcome.mjs).
      const staged = await stage({ ...span, why, src: session?.actor ?? session?.client ?? 'mcp' }, session);
      if (staged.alreadyProposed) {
        const { id, status } = staged.alreadyProposed;
        return stamp({
          staged: false, created: false, span, alreadyListed: null, alreadyProposed: { id, status },
          nextStep: status === 'open' ? `Already waiting in the inbox as ${id}.` : `The owner already ${status} ${id}; do not propose these dates again.`,
        });
      }
      return stamp({
        id: staged.id, staged: true, created: false, span, alreadyListed: null, alreadyProposed: null,
        nextStep: 'Tell the owner it is waiting in the Totem inbox to accept. Do not treat these dates as away until then.',
      });
    },
  };
}
