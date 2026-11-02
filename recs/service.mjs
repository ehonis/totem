import { randomUUID } from 'node:crypto';

import { DEFAULT_TIME_ZONE, addDays, isDayKey, todayKey } from '../goals/periods.mjs';
import { withTodoTransaction } from '../todos/db.mjs';
import { RecDomainError } from './errors.mjs';

export const DECISIONS = Object.freeze(['pending', 'accepted', 'declined', 'deferred']);
export const OUTCOMES = Object.freeze(['worked', 'partly', 'failed']);
// Recs still in play. A new one like any of these is the same advice again.
const OPEN_DECISIONS = Object.freeze(['pending', 'deferred', 'accepted']);
// How long a declined rec keeps an agent from suggesting it again, unless something
// has changed (the prompt rule says so; record refuses it otherwise).
export const DECLINED_WINDOW_DAYS = 30;
// The context a decision is accepted from. Only the HTTP adapter sets it, so no MCP
// tool can decide. Anyone holding BRIDGE_SECRET can still call that adapter; the
// audit line names how each decision was authenticated (`context.auth`).
export const OWNER_VIA = 'dashboard';
const MAX_DEFER_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;
const fail = (code, message, options) => new RecDomainError(code, message, options);

// Grammar and filler with no subject. "buy", "try" and "get" go too: they are what
// changes between two wordings of the same advice ("buy a desk", "get a desk").
const STOPWORDS = new Set(`
  a an am as at be by do go he if in is it me my no of ok on or so to up us we
  the and for with from that this these those your you yours into onto over under about
  after before then than when what which who why how its his her him she they them their
  are was were will would should could can not but out off per via any some much many
  very just also only each every all own same such too has have had does did
  try buy get got use make take taking put give let see look consider maybe instead
  owner week weeks day days month months year years daily weekly
`.split(/\s+/).filter(Boolean));

// Words that say which way the advice points. They are not subject terms, but two recs
// pointing opposite ways ("stop taking vitamin D3" / "start taking vitamin D3") are
// different advice however many words they share.
const POLARITY = new Map([
  ...'start begin resume increase more raise add adopt keep continue'.split(' ').map((w) => [w, 1]),
  // Not "lower" (or "upper"): they name a thing as often as a direction ("lower body").
  ...'stop quit end cease cut drop reduce decrease less avoid cancel skip remove'.split(' ').map((w) => [w, -1]),
]);

// A small fold for the commonest rewordings. Close paraphrases beyond these are left to
// the agent reading recs__list; this is a keyword match, not a model.
const SYNONYMS = new Map(Object.entries({
  jog: 'run', jogging: 'run', running: 'run',
  cycle: 'bike', cycling: 'bike', biking: 'bike', bicycle: 'bike',
  adjustable: 'standing',
  exercise: 'workout', exercising: 'workout',
  supplementation: 'supplement',
}));

function fold(word) {
  let w = SYNONYMS.get(word) ?? word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:ch|sh|x|z|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  w = SYNONYMS.get(w) ?? w;
  // "drinking" and "drink" are one word. Both sides fold alike, so "morning" → "morn" is harmless.
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  return w;
}

const words = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/** The subject terms of a text: words of 2+ characters, plurals and a few synonyms folded. */
export function recTerms(text) {
  const terms = new Set();
  for (const word of words(text)) {
    if (word.length < 2 || STOPWORDS.has(word) || POLARITY.has(word)) continue;
    terms.add(fold(word));
  }
  return terms;
}

/** 1 if the text says start/more, -1 if stop/less, 0 if neither or both. */
export function recPolarity(text) {
  let up = false;
  let down = false;
  for (const word of words(text)) {
    const p = POLARITY.get(word);
    if (p > 0) up = true;
    if (p < 0) down = true;
  }
  return up === down ? 0 : up ? 1 : -1;
}

/**
 * Whether a rec says what `query` says. A match needs two shared subject terms, or the
 * only one when the query has a single term, no opposite direction, and not exactly one
 * swapped detail between the query and the rec's title ("lower body workout" is not
 * "upper body workout", nor a 5k a 10k). The score is the overlap against both sides
 * (Dice), so one shared word in a long rec scores low.
 */
export function recSimilarity(query, rec) {
  const wanted = recTerms(query);
  if (!wanted.size) return null;
  if (recPolarity(query) * recPolarity(rec.title) < 0) return null;
  const titled = recTerms(rec.title);
  const onlyQuery = [...wanted].filter((term) => !titled.has(term));
  const onlyTitle = [...titled].filter((term) => !wanted.has(term));
  if (onlyQuery.length === 1 && onlyTitle.length === 1) return null;
  const have = recTerms(`${rec.title} ${rec.body ?? ''}`);
  const matched = [...wanted].filter((term) => have.has(term));
  if (matched.length < Math.min(2, wanted.size)) return null;
  return { score: Math.round(((2 * matched.length) / (wanted.size + have.size)) * 100) / 100, matched };
}

/** The same advice in other words: same direction, same subject terms. */
const titleKey = (title) => `${recPolarity(title)}:${[...recTerms(title)].sort().join(' ')}`;

function text(value, field, { max, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fail('INVALID_REC_FIELD', `${field} is required.`, { details: { field } });
    return '';
  }
  if (typeof value !== 'string') throw fail('INVALID_REC_FIELD', `${field} must be a string.`, { details: { field } });
  const trimmed = value.trim();
  if (required && !trimmed) throw fail('INVALID_REC_FIELD', `${field} must not be empty.`, { details: { field } });
  return trimmed.slice(0, max);
}

function day(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (!isDayKey(value)) throw fail('INVALID_REC_FIELD', `${field} must be a date as YYYY-MM-DD.`, { details: { field } });
  return value;
}

function cost(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw fail('INVALID_REC_FIELD', 'costUsd must be a number of dollars, 0 or more.', { details: { field: 'costUsd' } });
  }
  return Math.round(number * 100) / 100;
}

const dto = (row) => ({
  id: row.id,
  title: row.title,
  body: row.body,
  evidence: row.evidence,
  costUsd: row.cost_usd,
  source: row.source,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  actBy: row.act_by,
  reviewOn: row.review_on,
  decision: row.decision,
  decidedAt: row.decided_at,
  decisionNote: row.decision_note,
  outcome: row.outcome,
  outcomeNote: row.outcome_note,
  outcomeAt: row.outcome_at,
  outcomeBy: row.outcome_by,
  changedNote: row.changed_note,
  resurfacedAt: row.resurfaced_at,
});

const pct = (value) => `${Math.round(value * 100)}%`;
const dollars = (value) => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;

/** The ledger's track record, and the one line the dashboard and agents quote. */
export function recStats(rows) {
  const count = (fn) => rows.filter(fn).length;
  const measured = (r) => r.decision === 'accepted' && r.outcome;
  const stats = {
    total: rows.length,
    pending: count((r) => r.decision === 'pending'),
    accepted: count((r) => r.decision === 'accepted'),
    declined: count((r) => r.decision === 'declined'),
    deferred: count((r) => r.decision === 'deferred'),
    worked: count((r) => measured(r) && r.outcome === 'worked'),
    partly: count((r) => measured(r) && r.outcome === 'partly'),
    failed: count((r) => measured(r) && r.outcome === 'failed'),
    agentReported: count((r) => measured(r) && r.outcome_by === 'agent'),
    acceptedCostUsd: Math.round(rows.reduce((sum, r) => sum + (r.decision === 'accepted' ? r.cost_usd ?? 0 : 0), 0) * 100) / 100,
  };
  const decided = stats.accepted + stats.declined;
  stats.measured = stats.worked + stats.partly + stats.failed;
  stats.acceptRate = decided ? stats.accepted / decided : null;
  // A hit is an accepted rec measured as having worked. "Partly" is shown beside it
  // but is not a hit, and outcomes agents reported themselves are counted out loud,
  // so the rate is not one an agent can quietly flatter.
  stats.hitRate = stats.measured ? stats.worked / stats.measured : null;
  const parts = [];
  if (stats.measured) {
    const extras = [stats.partly ? `${stats.partly} partly` : '', stats.agentReported ? `${stats.agentReported} reported by agents` : ''].filter(Boolean);
    parts.push(`${stats.worked} of ${stats.measured} measured worked (${pct(stats.hitRate)})${extras.length ? `, ${extras.join(', ')}` : ''}`);
  } else {
    parts.push('No outcomes measured yet');
  }
  if (decided) parts.push(`${stats.accepted} of ${decided} accepted`);
  if (stats.acceptedCostUsd) parts.push(`${dollars(stats.acceptedCostUsd)} committed`);
  if (stats.pending) parts.push(`${stats.pending} waiting`);
  stats.line = parts.join(' · ');
  return stats;
}

const cite = (recs) => recs.map((r) => `"${r.title}" (${r.id}, ${r.decision}${r.decidedAt ? ` ${r.decidedAt.slice(0, 10)}` : ''}${r.decisionNote ? `: ${r.decisionNote}` : ''})`).join('; ');

export function createRecService({
  db,
  actionLog,
  now = () => new Date().toISOString(),
  timeZone = DEFAULT_TIME_ZONE,
  makeId = randomUUID,
} = {}) {
  if (!db) throw new TypeError('createRecService requires db');
  if (!actionLog || typeof actionLog.record !== 'function') throw new TypeError('createRecService requires actionLog');

  const today = () => todayKey(new Date(now()), timeZone);
  const row = (id) => db.prepare('SELECT * FROM recs WHERE id = ?').get(id);
  const requireRec = (id) => {
    const found = typeof id === 'string' && id ? row(id) : null;
    if (!found) throw fail('REC_NOT_FOUND', `Recommendation ${id} was not found.`, { status: 404, details: { id } });
    return found;
  };
  const isOwner = (context) => context?.via === OWNER_VIA;

  function audit(action, target, context, summary, detail) {
    actionLog.record({
      action, actor: context?.actor ?? 'unknown', target, status: 'ok', summary,
      why: context?.reason ?? summary,
      detail: context?.auth ? { ...detail, auth: context.auth } : detail,
      correlationId: context?.correlationId ?? randomUUID(),
    });
  }

  // Audit once, here, after the write commits; adapters never log the same write.
  function mutate(meta, fn) {
    const value = withTodoTransaction(db, fn);
    audit(meta.action, meta.target, meta.context, meta.summary, meta.detail);
    return value;
  }

  const stats = () => recStats(db.prepare('SELECT decision, outcome, outcome_by, cost_usd FROM recs').all());

  async function list(filter = {}) {
    const where = [];
    const params = [];
    const decisions = filter.decision === undefined ? [] : [filter.decision].flat();
    for (const value of decisions) {
      if (!DECISIONS.includes(value)) throw fail('INVALID_REC_FIELD', `decision must be one of ${DECISIONS.join(', ')}.`, { details: { field: 'decision' } });
    }
    if (decisions.length) {
      where.push(`decision IN (${decisions.map(() => '?').join(', ')})`);
      params.push(...decisions);
    }
    if (filter.source) { where.push('source = ?'); params.push(String(filter.source)); }
    if (filter.declinedWithinDays !== undefined && filter.declinedWithinDays !== null) {
      const days = Number(filter.declinedWithinDays);
      if (!Number.isFinite(days) || days <= 0) {
        throw fail('INVALID_REC_FIELD', 'declinedWithinDays must be a positive number.', { details: { field: 'declinedWithinDays' } });
      }
      where.push("decision = 'declined' AND decided_at >= ?");
      params.push(new Date(Date.parse(now()) - days * DAY_MS).toISOString());
    }
    const limit = Math.min(200, Math.max(1, Number.parseInt(filter.limit, 10) || 50));
    const rows = db.prepare(`
      SELECT * FROM recs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id
    `).all(...params);

    let recs;
    if (typeof filter.similarTo === 'string' && filter.similarTo.trim()) {
      recs = rows
        .map((r) => ({ rec: r, similarity: recSimilarity(filter.similarTo, r) }))
        .filter(({ similarity }) => similarity)
        .sort((a, b) => b.similarity.score - a.similarity.score)
        .map(({ rec, similarity }) => ({ ...dto(rec), similarity }));
    } else {
      recs = rows.map(dto);
    }
    return { recs: recs.slice(0, limit), count: recs.length, stats: stats() };
  }

  /**
   * What the Recommendations view shows: everything still waiting on the owner
   * (pending and deferred, never paged, so none can fall out of sight), and one page
   * of decided history, newest decision first. `before` is the previous page's
   * `nextBefore`.
   */
  async function ledger({ limit, before } = {}) {
    const open = db.prepare(`
      SELECT * FROM recs WHERE decision IN ('pending', 'deferred') ORDER BY created_at DESC, id DESC
    `).all().map(dto);
    const size = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
    const params = [];
    let after = '';
    if (before) {
      const cut = String(before).lastIndexOf('|');
      if (cut < 1) throw fail('INVALID_REC_FIELD', 'before must be a cursor from nextBefore.', { details: { field: 'before' } });
      after = 'AND (decided_at < ? OR (decided_at = ? AND id < ?))';
      const at = String(before).slice(0, cut);
      params.push(at, at, String(before).slice(cut + 1));
    }
    const rows = db.prepare(`
      SELECT * FROM recs WHERE decision IN ('accepted', 'declined') ${after}
      ORDER BY decided_at DESC, id DESC LIMIT ?
    `).all(...params, size + 1);
    const page = rows.slice(0, size);
    const last = page.at(-1);
    return {
      open,
      history: page.map(dto),
      nextBefore: rows.length > size && last ? `${last.decided_at}|${last.id}` : null,
      stats: stats(),
    };
  }

  async function get(id) { return dto(requireRec(id)); }

  async function record(input = {}, context = {}) {
    // A rec starts pending and only the owner moves it. Saying otherwise is refused
    // rather than ignored, so an agent never believes it recorded a decision.
    if (input.decision !== undefined && input.decision !== 'pending') {
      throw fail('REC_DECISION_OWNER_ONLY', 'Only the owner decides a recommendation, from the dashboard. Record it without a decision.', { status: 403 });
    }
    if (input.outcome !== undefined) {
      throw fail('INVALID_REC_FIELD', 'A new recommendation has no outcome yet; record one with set_outcome once it is accepted.', { details: { field: 'outcome' } });
    }
    const title = text(input.title, 'title', { max: 200, required: true });
    const rec = {
      id: makeId(),
      title,
      body: text(input.body, 'body', { max: 4000 }),
      evidence: text(input.evidence, 'evidence', { max: 4000 }),
      costUsd: cost(input.costUsd),
      source: text(input.source ?? context.source, 'source', { max: 200, required: true }),
      actBy: day(input.actBy, 'actBy'),
      changed: text(input.changed, 'changed', { max: 1000 }) || null,
    };

    // Checked before writing: a refused rec leaves nothing for the owner to decline again.
    const { recs: declinedSimilar } = await list({ similarTo: title, declinedWithinDays: DECLINED_WINDOW_DAYS, limit: 200 });
    if (declinedSimilar.length && !rec.changed && !isOwner(context)) {
      throw fail('REC_DECLINED_RECENTLY',
        `The owner declined this within the last ${DECLINED_WINDOW_DAYS} days: ${cite(declinedSimilar)}. `
        + 'Do not suggest it again unless something has changed; if it has, record it with changed set to what changed.',
        { status: 409, details: { declinedSimilar: declinedSimilar.map((r) => r.id) } });
    }
    const { recs: openSimilar } = await list({ similarTo: title, decision: OPEN_DECISIONS, limit: 200 });
    const duplicate = openSimilar.find((r) => titleKey(r.title) === titleKey(title));
    if (duplicate) {
      throw fail('REC_DUPLICATE',
        `This is already in the ledger as ${cite([duplicate])}; it was not recorded again.`,
        { status: 409, details: { id: duplicate.id } });
    }

    const stamp = now();
    mutate({ action: 'rec.record', target: rec.id, context, summary: `Recorded recommendation: ${title}`, detail: { source: rec.source, changed: rec.changed } }, () => {
      db.prepare(`
        INSERT INTO recs (id, title, body, evidence, cost_usd, source, created_at, updated_at, act_by, changed_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(rec.id, rec.title, rec.body, rec.evidence, rec.costUsd, rec.source, stamp, stamp, rec.actBy, rec.changed);
    });
    return { rec: dto(row(rec.id)), declinedSimilar, openSimilar };
  }

  async function decide(id, input = {}, context = {}) {
    if (!isOwner(context)) {
      throw fail('REC_DECISION_OWNER_ONLY', 'Only the owner decides a recommendation, from the dashboard.', { status: 403 });
    }
    const current = requireRec(id);
    const decision = input.decision;
    if (!DECISIONS.includes(decision)) {
      throw fail('INVALID_REC_FIELD', `decision must be one of ${DECISIONS.join(', ')}.`, { details: { field: 'decision' } });
    }
    let reviewOn = current.review_on;
    if (decision === 'deferred') {
      // Days from today, counted here in the bridge's time zone, so a device in
      // another zone cannot name a "tomorrow" that is already the bridge's today.
      if (input.deferDays !== undefined) {
        const days = Number(input.deferDays);
        if (!Number.isInteger(days) || days < 1 || days > MAX_DEFER_DAYS) {
          throw fail('INVALID_REC_FIELD', `deferDays must be a whole number from 1 to ${MAX_DEFER_DAYS}.`, { details: { field: 'deferDays' } });
        }
        reviewOn = addDays(today(), days);
      } else {
        reviewOn = day(input.reviewOn, 'reviewOn');
        if (!reviewOn || reviewOn <= today()) {
          throw fail('INVALID_REC_FIELD', 'A deferred recommendation needs deferDays, or a reviewOn date after today.', { details: { field: 'reviewOn' } });
        }
      }
    }
    const note = text(input.note, 'note', { max: 2000 }) || null;
    const stamp = now();
    // An outcome measures an accepted rec; one that is no longer accepted keeps none.
    const keep = decision === 'accepted' ? 1 : 0;
    mutate({ action: 'rec.decide', target: id, context, summary: `Marked recommendation ${decision}: ${current.title}`, detail: { from: current.decision, to: decision, reviewOn } }, () => {
      db.prepare(`
        UPDATE recs SET decision = ?, decided_at = ?, decision_note = ?, review_on = ?, updated_at = ?,
          outcome = CASE WHEN ? THEN outcome END,
          outcome_note = CASE WHEN ? THEN outcome_note END,
          outcome_at = CASE WHEN ? THEN outcome_at END,
          outcome_by = CASE WHEN ? THEN outcome_by END
        WHERE id = ?
      `).run(decision, decision === 'pending' ? null : stamp, note, reviewOn, stamp, keep, keep, keep, keep, id);
    });
    return { rec: dto(row(id)) };
  }

  async function setOutcome(id, input = {}, context = {}) {
    const current = requireRec(id);
    if (current.decision !== 'accepted') {
      throw fail('REC_NOT_ACCEPTED', `Only an accepted recommendation has an outcome; this one is ${current.decision}.`, { status: 409, details: { decision: current.decision } });
    }
    if (!OUTCOMES.includes(input.outcome)) {
      throw fail('INVALID_REC_FIELD', `outcome must be one of ${OUTCOMES.join(', ')}.`, { details: { field: 'outcome' } });
    }
    const by = isOwner(context) ? 'owner' : 'agent';
    if (by === 'agent' && current.outcome_by === 'owner') {
      throw fail('REC_OUTCOME_OWNER_SET', `The owner already recorded this outcome (${current.outcome}); an agent cannot change it.`, { status: 403 });
    }
    const note = text(input.note, 'note', { max: 2000 }) || null;
    const stamp = now();
    mutate({ action: 'rec.outcome', target: id, context, summary: `Outcome ${input.outcome}: ${current.title}`, detail: { outcome: input.outcome, by } }, () => {
      db.prepare('UPDATE recs SET outcome = ?, outcome_note = ?, outcome_at = ?, outcome_by = ?, updated_at = ? WHERE id = ?')
        .run(input.outcome, note, stamp, by, stamp, id);
    });
    return { rec: dto(row(id)) };
  }

  /** Ids of deferred recs whose review day has come, in the bridge's time zone. */
  async function dueForReview() {
    return db.prepare("SELECT id FROM recs WHERE decision = 'deferred' AND review_on <= ? ORDER BY review_on, id").all(today()).map((r) => r.id);
  }

  /** One deferred rec back to pending, if it is still deferred and due. Null if not. */
  async function resurface(id, context = { actor: 'scheduler', reason: 'deferred recommendation is due for review' }) {
    const current = requireRec(id);
    const stamp = now();
    const changed = withTodoTransaction(db, () => db.prepare(`
      UPDATE recs SET decision = 'pending', decided_at = NULL, resurfaced_at = ?, updated_at = ?
      WHERE id = ? AND decision = 'deferred' AND review_on <= ?
    `).run(stamp, stamp, id, today()).changes);
    if (!changed) return null;
    audit('rec.resurface', id, context, `Back for a decision: ${current.title}`, { reviewOn: current.review_on });
    return dto(row(id));
  }

  return { list, ledger, get, record, decide, setOutcome, dueForReview, resurface, stats };
}

/**
 * The job tick's step: resurface what is due and tell the owner, one rec at a time, so
 * a failed notification costs only its own push. The rec is pending and on the Recs
 * page either way; the failure is logged. Called from the bridge's one 30-second tick,
 * so there is no second scheduler.
 */
export async function resurfaceDeferredRecs({ service, notify, log = () => {} }) {
  const back = [];
  for (const id of await service.dueForReview()) {
    let rec;
    try { rec = await service.resurface(id); }
    catch (error) { log(`rec ${id}: could not resurface: ${error?.message || error}`); continue; }
    if (!rec) continue;
    back.push(rec);
    try {
      await notify({
        level: 'info',
        category: 'rec.review',
        title: `Decide again: ${rec.title}`,
        body: rec.decisionNote ? `You deferred this: ${rec.decisionNote}` : (rec.body || 'You deferred this recommendation to today.'),
        url: '/productivity/recs',
      });
    } catch (error) {
      log(`rec ${id}: back to pending, but its notification failed: ${error?.message || error}`);
    }
  }
  return back;
}
