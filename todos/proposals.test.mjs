import assert from 'node:assert/strict';
import { test } from 'node:test';

import { todoCommandFromInboxProposal } from './proposals.mjs';

test('todo proposals default to private Personal tasks', () => {
  assert.deepEqual(todoCommandFromInboxProposal({
    id: 'P1', kind: 'todo', title: 'Buy detergent', when: null, src: 'journal', meta: {}, raw: '- [ ] P1 | todo | Buy detergent',
  }), {
    title: 'Buy detergent',
    area: 'Personal',
    ventureTag: null,
    description: 'From inbox P1 (src: journal)',
    syncTarget: 'local',
  });
});

test('sheet proposal requires the one explicit sync marker and keeps venture classification', () => {
  const input = todoCommandFromInboxProposal({
    id: 'P2', kind: 'todo', title: 'Send Initech quote', when: '2026-09-15', src: 'meeting',
    meta: { project: 'Ventures', venture: 'Initech', sync: 'sheet' },
    raw: '- [ ] P2 | todo | Send Initech quote | project: Ventures | venture: Initech | sync: sheet | when: 2026-09-15',
  });
  assert.deepEqual(input, {
    title: 'Send Initech quote', area: 'Ventures', ventureTag: 'Initech', dueDate: '2026-09-15',
    description: 'From inbox P2 (src: meeting)', syncTarget: 'sheet',
  });
});

test('classification never implies sharing and future Work proposals are rejected', () => {
  assert.equal(todoCommandFromInboxProposal({
    id: 'P3', kind: 'todo', title: 'Private venture', meta: { project: 'Ventures', venture: 'Acme' }, raw: '',
  }).syncTarget, 'local');
  assert.throws(() => todoCommandFromInboxProposal({
    id: 'P4', kind: 'todo', title: 'Old work', meta: { project: 'Work' }, raw: '',
  }), error => error.code === 'FUTURE_WORK_TASK_UNSUPPORTED');
  assert.throws(() => todoCommandFromInboxProposal({
    id: 'P4B', kind: 'todo', title: 'Contradictory', meta: { project: 'Personal', venture: 'Initech' }, raw: '',
  }), error => error.code === 'VENTURE_TAG_NOT_ALLOWED');
});

test('contradictory, repeated, and invalid sync markers are rejected', () => {
  assert.throws(() => todoCommandFromInboxProposal({
    id: 'P5', kind: 'todo', title: 'Repeated', meta: { sync: 'sheet' },
    raw: '- [ ] P5 | todo | Repeated | sync: sheet | sync: github',
  }), error => error.code === 'AMBIGUOUS_SYNC_TARGET');
  assert.throws(() => todoCommandFromInboxProposal({
    id: 'P6', kind: 'todo', title: 'Invalid', meta: { sync: 'todoist' }, raw: '',
  }), error => error.code === 'INVALID_SYNC_TARGET');
});

test('github proposal becomes an explicit GitHub task command', () => {
  const input = todoCommandFromInboxProposal({
    id: 'P7', kind: 'github', title: 'Fix import', src: 'meeting', meta: { repo: 'alexdev/example' }, raw: '',
  }, { github: { repo: 'alexdev/example', body: 'Complete issue body', labels: ['bug'] } });
  assert.deepEqual(input, {
    title: 'Fix import', area: 'Personal', ventureTag: null,
    description: 'Complete issue body', syncTarget: 'github',
    github: { repo: 'alexdev/example', body: 'Complete issue body', labels: ['bug'] },
  });
});
