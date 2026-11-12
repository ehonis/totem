import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('inbox task acceptance crosses the shared command boundary', () => {
  const bridge = read('bridge.mjs');
  const start = bridge.indexOf('async function actionInboxItem');
  const end = bridge.indexOf('// Same detached shape', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = bridge.slice(start, end);
  assert.match(body, /todoCommands\.create/);
  assert.doesNotMatch(body, /\bcreateTodo\s*\(|\bghIssueCreate\s*\(/);
  // An accepted github proposal files its issue and makes no task: the connector that
  // turned issues into tasks is gone.
  const github = body.slice(body.indexOf('if (isGithubKind(item.kind))'));
  const branch = github.slice(0, github.indexOf('\n  }\n'));
  assert.match(branch, /assertIssueRepo\(issue\.repo\)\s*\n\s*dispatching\(\)\s*\n\s*const filed = await inboxIssueFiler\.file\(issue\)/, 'the repo is checked before dispatching');
  assert.doesNotMatch(github.slice(0, github.indexOf('\n  }\n')), /todoCommands|todoCommandFromInboxProposal/);
  const mutationMap = bridge.slice(
    bridge.indexOf('const MCP_MUTATION_ACTIONS'),
    bridge.indexOf('function logMcpMutation'),
  );
  assert.doesNotMatch(mutationMap, /totem_(?:create|update)_task/);
});

test('the GitHub task connector is gone and its job id is retired, not left to fail', () => {
  const bridge = read('bridge.mjs');
  assert.doesNotMatch(bridge, /createGitHubConnector|createGitHubAppClient|githubTodoConnector|GITHUB_APP_/);
  const seeds = bridge.slice(bridge.indexOf('const JOB_RUNNER_DEFS = {'), bridge.indexOf('const todoDatabase'));
  assert.doesNotMatch(seeds, /'github-todos-sync'/, 'no seed or runner definition');
  const runners = bridge.slice(bridge.indexOf('const JOB_RUNNERS = {'));
  assert.doesNotMatch(runners.slice(0, runners.indexOf('\n}\n')), /'github-todos-sync'/, 'no runner code');
  assert.match(bridge, /retiredIds:\s*\[[^\]]*'github-todos-sync'/);
  for (const file of ['todos/connectors/github-sync.mjs', 'todos/connectors/github-client.mjs', 'todos/connectors/github-app-client.mjs', 'todos/connectors/github-policy.mjs']) {
    assert.throws(() => read(file), /ENOENT/, `${file} should be removed`);
  }
});

test('no agent-facing text offers to sync a task to GitHub', () => {
  for (const file of ['bridge.mjs', 'mcp-gateway.mjs', 'todos/mcp.mjs']) {
    const text = read(file);
    assert.doesNotMatch(text, /syncTarget[^.]{0,40}\bgithub\b|sync: github/i, file);
  }
});

test('bridge serves the task sheet read-only, with no sync connector or job', () => {
  const bridge = read('bridge.mjs');
  assert.doesNotMatch(bridge, /createGoogleSheetsClient|createTaskSheetConnector|sheetTodoConnector|GOOGLE_SHEETS_CREDENTIALS_FILE/);
  assert.doesNotMatch(bridge, /runner: 'task-sheet-sync'|'task-sheet-sync': async/);
  assert.match(bridge, /retiredIds: \[[^\]]*'task-sheet-sync'/);
  // The feed is handed Drive's reads and nothing else.
  const start = bridge.indexOf('const taskSheetFeed = createTaskSheetFeed({');
  const block = bridge.slice(start, bridge.indexOf('\n})', start));
  assert.ok(start > 0);
  assert.deepEqual([...block.matchAll(/^    (\w+):/gm)].map(m => m[1]), ['configured', 'accountLabels', 'requireAccount', 'sheetInfo', 'sheetRead']);
  // GET /api/todos/sheet is the task routes' (todos/http.mjs), handed the feed.
  assert.match(bridge, /createTodoHttpHandler\(\{ service: todoService, commands: todoCommands, sheetFeed: taskSheetFeed[,} ]/);
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
