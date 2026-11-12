import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { RecDomainError } from './errors.mjs';
import { normalizeActor, OWNER_ACTOR } from '../logs/store.mjs';
import { createRecHttpHandler } from './http.mjs';
import { OWNER_VIA } from './service.mjs';

function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: {} });
  return req;
}

function response() {
  const res = { status: 0, body: null };
  res.writeHead = (status) => { res.status = status; };
  res.end = (text) => { res.body = JSON.parse(text); };
  return res;
}

test('the dashboard decides as the owner; the rest maps onto the service', async () => {
  const calls = [];
  const service = {
    async list(filter) { calls.push(['list', filter]); return { recs: [], count: 0, stats: {} }; },
    async ledger(query) { calls.push(['ledger', query]); return { open: [], history: [], nextBefore: null, stats: {} }; },
    async record(input, context) { calls.push(['record', input, context]); return { rec: { id: 'r1' }, declinedSimilar: [] }; },
    async decide(id, input, context) { calls.push(['decide', id, input, context]); return { rec: { id } }; },
    async setOutcome(id) { throw new RecDomainError('REC_NOT_ACCEPTED', 'not accepted', { status: 409 }); },
  };
  const handle = createRecHttpHandler({ service, authMethod: () => 'bearer' });

  let res = response();
  assert.equal(await handle(request('GET', '/api/recs?decision=declined&decision=deferred&similarTo=desk&declinedWithinDays=30'), res), true);
  assert.deepEqual(calls.pop(), ['list', { decision: ['declined', 'deferred'], similarTo: 'desk', declinedWithinDays: '30' }]);

  res = response();
  await handle(request('GET', '/api/recs/ledger?limit=25&before=2026-10-01T00%3A00%3A00.000Z%7Cr9'), res);
  assert.deepEqual(calls.pop(), ['ledger', { limit: '25', before: '2026-10-01T00:00:00.000Z|r9' }]);

  res = response();
  await handle(request('POST', '/api/recs/r1/decision', { decision: 'accepted' }), res);
  const [, id, input, context] = calls.pop();
  assert.equal(id, 'r1');
  assert.deepEqual(input, { decision: 'accepted' });
  assert.equal(context.via, OWNER_VIA);
  // Past the approval gate (auth/approval-routes.mjs, which refuses the bearer alone)
  // the decision is the owner's. The log files it under the owner (a known actor, not
  // `unknown`) and keeps how it was authenticated beside it.
  assert.deepEqual([context.actor, context.auth], [OWNER_ACTOR, 'bearer']);
  assert.equal(normalizeActor(context.actor), OWNER_ACTOR);

  res = response();
  await handle(request('POST', '/api/recs', { title: 'Note to self' }), res);
  assert.equal(calls.pop()[1].source, 'owner');

  res = response();
  await handle(request('POST', '/api/recs/r1/outcome', { outcome: 'worked' }), res);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'REC_NOT_ACCEPTED');

  assert.equal(await handle(request('GET', '/api/lists'), response()), false);
});

test('a record is the owner\'s only with ownerProof; the bearer alone records as an agent, so the declined hold applies', async () => {
  const seen = [];
  const service = {
    async record(input, context) { seen.push([input, context]); return { rec: { id: 'r1' }, declinedSimilar: [] }; },
  };
  let proof = false;
  const handle = createRecHttpHandler({ service, authMethod: () => 'bearer', ownerProof: async () => proof });
  await handle(request('POST', '/api/recs', { title: 'Buy the standing desk' }), response());
  const [agentInput, agentContext] = seen.pop();
  assert.equal(agentInput.source, 'api');
  assert.equal(agentContext.via, undefined);
  assert.equal(agentContext.actor, 'agent');
  assert.equal(agentContext.auth, 'bearer');
  proof = true;
  await handle(request('POST', '/api/recs', { title: 'Buy the standing desk' }), response());
  const [ownerInput, ownerContext] = seen.pop();
  assert.equal(ownerInput.source, 'owner');
  assert.equal(ownerContext.via, OWNER_VIA);
});
