import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('active agent and shipped skill prompts use Totem tasks rather than Todoist', () => {
  const bridge = read('bridge.mjs');
  const activeForbidden = [
    'Use Todoist for future commitments',
    'create Todoist tasks for todo-type items',
    'When creating a Todoist task',
    'todoist__add-tasks',
    'todoist__find-tasks',
    'Create one or more Todoist tasks from this request',
    'Creates a Todoist task in',
    'confirmed ${today} → Todoist',
    "todo: 'Todoist'",
  ];
  for (const phrase of activeForbidden) {
    assert.equal(bridge.includes(phrase), false, `bridge still contains active Todoist task instruction: ${phrase}`);
  }
  assert.match(bridge, /tasks__create_task/);
  assert.match(bridge, /syncTarget/);

  for (const path of [
    'skills/seeds/daily-brief/SKILL.md',
    'skills/seeds/journal-ingest/SKILL.md',
    'skills/seeds/plaud-action-items-ingest/SKILL.md',
    'skills/seeds/todays-tasks/SKILL.md',
  ]) {
    const contents = read(path);
    assert.doesNotMatch(contents, /Todoist|todoist__/i, `${path} still instructs Todoist use`);
  }
});

test('Plaud proposal prompts no longer route future Work tasks', () => {
  const contents = read('skills/seeds/plaud-action-items-ingest/SKILL.md');
  assert.doesNotMatch(contents, /project:\s*Work/i);
  assert.match(contents, /Personal/);
  // The shipped seed is generic; venture routing lives in an opt-in example.
  assert.doesNotMatch(contents, /venture:\s*[A-Z]/);
  const example = read('examples/skills/plaud-action-items-ingest-ventures/SKILL.md');
  assert.doesNotMatch(example, /project:\s*Work/i);
  assert.match(example, /Acme/);
});

test('inbox task acceptance crosses the shared command boundary', () => {
  const bridge = read('bridge.mjs');
  const start = bridge.indexOf('async function actionInboxItem');
  const end = bridge.indexOf('// Same detached shape', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = bridge.slice(start, end);
  assert.match(body, /todoCommands\.create/);
  assert.doesNotMatch(body, /\bcreateTodo\s*\(|\bghIssueCreate\s*\(/);
  const mutationMap = bridge.slice(
    bridge.indexOf('const MCP_MUTATION_ACTIONS'),
    bridge.indexOf('function logMcpMutation'),
  );
  assert.doesNotMatch(mutationMap, /totem_(?:create|update)_task/);
});

test('bridge wires the real GitHub task connector and a 15-minute sync job', () => {
  const bridge = read('bridge.mjs');
  assert.match(bridge, /createGitHubClient/);
  assert.match(bridge, /createGitHubConnector/);
  assert.match(bridge, /github:\s*githubTodoConnector/);
  assert.match(bridge, /'github-todos-sync'[\s\S]*?everyMinutes:\s*15/);
  assert.match(bridge, /'github-todos-sync':\s*async[\s\S]*?githubTodoConnector\.reconcile/);
});

test('bridge wires the credential-gated Action Items connector and 15-minute sync job', () => {
  const bridge = read('bridge.mjs');
  assert.match(bridge, /createGoogleSheetsClient/);
  assert.match(bridge, /createTaskSheetConnector/);
  assert.match(bridge, /sheet:\s*sheetTodoConnector/);
  assert.match(bridge, /'task-sheet-sync'[\s\S]*?everyMinutes:\s*15/);
  assert.match(bridge, /'task-sheet-sync':\s*async[\s\S]*?sheetTodoConnector\.reconcile/);
});

test('runtime exposes no Todoist path and schedules local task maintenance daily', () => {
  const bridge = read('bridge.mjs');
  const gateway = read('mcp-gateway.mjs');
  const settings = read('web/src/components/McpSettingsView.tsx');
  assert.doesNotMatch(bridge, /todoist/i);
  assert.doesNotMatch(gateway, /todoist/i);
  assert.doesNotMatch(settings, /todoist/i);
  assert.match(bridge, /'todo-maintenance'[\s\S]*?type:\s*'daily'[\s\S]*?time:\s*'02:15'/);
  assert.match(bridge, /'todo-maintenance':\s*async[\s\S]*?todoMaintenance\.run/);
});

test('every MCP output schema that declares tellEthan also declares tellOwner', () => {
  const bridge = read('bridge.mjs');
  const declaringAlias = bridge.match(/tellEthan: S_TELL_ETHAN/g) || [];
  const declaringNew = bridge.match(/tellOwner: S_TELL_OWNER, tellEthan: S_TELL_ETHAN/g) || [];
  assert.ok(declaringAlias.length >= 3);
  assert.equal(declaringNew.length, declaringAlias.length);
  assert.doesNotMatch(bridge, /tellEthan: S_STR|tellEthan: `/);
});
