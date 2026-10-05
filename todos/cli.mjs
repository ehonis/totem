#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../scripts/is-entry.mjs';

import { createActionLog } from '../logs/store.mjs';
import {
  backupTodoDatabase,
  closeTodoDatabase,
  exportTodoDatabase,
  openTodoDatabase,
  restoreTodoDatabase,
} from './db.mjs';
import { createTodoService } from './service.mjs';
import { createGitHubAppClient } from './connectors/github-app-client.mjs';
import { createGoogleSheetsClient } from './connectors/google-sheets-client.mjs';
import { createTaskSheetConnector } from './connectors/task-sheet-sync.mjs';
import {
  ACTION_ITEMS,
  configureTaskSheet,
  parseActionItemRow,
  resolveActionItemSchema,
  validateStableIds,
} from './connectors/task-sheet-policy.mjs';

const COMMAND_OPTIONS = {
  backup: new Set(['database', 'output']),
  export: new Set(['database', 'output']),
  restore: new Set(['source', 'database']),
  'sheet-inspect': new Set(['credentials']),
  'sheet-bootstrap-schema': new Set(['credentials', 'database', 'action-log', 'confirm-sheet-id']),
  'github-check': new Set(['app-id', 'private-key', 'installation', 'assignee']),
};

function usage() {
  return [
    'Usage:',
    '  node todos/cli.mjs backup --database <path> --output <path>',
    '  node todos/cli.mjs export --database <path> --output <path>',
    '  node todos/cli.mjs restore --source <path> --database <path>',
    '  node todos/cli.mjs sheet-inspect [--credentials <service-account.json>]',
    '  node todos/cli.mjs sheet-bootstrap-schema --confirm-sheet-id <id> [--credentials <service-account.json>] [--database <path>]',
    '  node todos/cli.mjs github-check [--app-id <id>] [--private-key <app.pem>] [--installation <id>] [--assignee <login>]',
  ].join('\n');
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) throw new Error(usage());
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith('--') || value == null || value.startsWith('--')) {
      throw new Error(`Invalid option near ${flag ?? '(end)'}\n${usage()}`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown option --${name} for ${command}`);
    if (Object.hasOwn(options, name)) throw new Error(`Option --${name} may only be supplied once`);
    options[name] = value;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || !value) throw new Error(`Missing required option --${name}`);
  return value;
}

async function withDatabase(file, operation) {
  const db = openTodoDatabase({ file });
  try {
    return await operation(db);
  } finally {
    closeTodoDatabase(db);
  }
}

export async function runTodoCli(argv, { stdout = process.stdout } = {}) {
  const { command, options } = parseArguments(argv);
  if (command === 'sheet-inspect' || command === 'sheet-bootstrap-schema') {
    // Same settings the bridge reads (docs/task-sheet.md). Tags for the bootstrap's
    // data validation come from the database below.
    configureTaskSheet({
      spreadsheetId: process.env.TASK_SHEET_ID || ACTION_ITEMS.spreadsheetId,
      spreadsheetTitle: process.env.TASK_SHEET_TITLE ?? ACTION_ITEMS.spreadsheetTitle,
      tab: process.env.TASK_SHEET_TAB || ACTION_ITEMS.tab,
      sheetId: process.env.TASK_SHEET_GID ?? ACTION_ITEMS.sheetId,
      ...(process.env.TASK_SHEET_ASSIGNEES ? { assignees: process.env.TASK_SHEET_ASSIGNEES } : {}),
    });
    if (!ACTION_ITEMS.spreadsheetId) throw new Error('Set TASK_SHEET_ID to the spreadsheet to use');
  }
  let result;
  if (command === 'backup') {
    const database = required(options, 'database');
    const output = required(options, 'output');
    if (existsSync(output)) throw new Error(`Refusing to overwrite existing backup ${output}`);
    await withDatabase(database, db => backupTodoDatabase({ db, destination: output }));
    result = { database, output };
  } else if (command === 'export') {
    const database = required(options, 'database');
    const output = required(options, 'output');
    await withDatabase(database, db => exportTodoDatabase({ db, destination: output }));
    result = { database, output };
  } else if (command === 'restore') {
    const source = required(options, 'source');
    const database = required(options, 'database');
    restoreTodoDatabase({ source, destination: database });
    result = { source, database };
  } else if (command === 'sheet-inspect') {
    const credentialsFile = options.credentials || process.env.GOOGLE_SHEETS_CREDENTIALS_FILE;
    if (!credentialsFile) throw new Error('Missing Google Sheets credentials (--credentials or GOOGLE_SHEETS_CREDENTIALS_FILE)');
    const client = createGoogleSheetsClient({ credentialsFile });
    const metadata = await client.getMetadata(ACTION_ITEMS.spreadsheetId);
    const values = (await client.readRange(ACTION_ITEMS.spreadsheetId, `'${ACTION_ITEMS.tab}'!B4:I`)).values ?? [];
    const schema = resolveActionItemSchema({ metadata, headerValues: values[0] ?? [] });
    const rows = values.slice(1).map(values => parseActionItemRow({ headers: schema, values }));
    validateStableIds(rows);
    result = { spreadsheetId: ACTION_ITEMS.spreadsheetId, tab: ACTION_ITEMS.tab, timeZone: schema.timeZone, rows: rows.length, linkedRows: rows.filter(row => row.totemId).length };
  } else if (command === 'sheet-bootstrap-schema') {
    const confirmation = required(options, 'confirm-sheet-id');
    if (confirmation !== ACTION_ITEMS.spreadsheetId) throw new Error('Refusing bootstrap without the exact spreadsheet id');
    const credentialsFile = options.credentials || process.env.GOOGLE_SHEETS_CREDENTIALS_FILE;
    if (!credentialsFile) throw new Error('Missing Google Sheets credentials (--credentials or GOOGLE_SHEETS_CREDENTIALS_FILE)');
    const database = options.database || process.env.TODO_DATABASE_FILE || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'todos.db');
    const actionLogFile = options['action-log'] || process.env.ACTION_LOG_FILE || join(dirname(database), 'action-log.jsonl');
    result = await withDatabase(database, async db => {
      const actionLog = createActionLog({ file: actionLogFile });
      const service = createTodoService({ db, actionLog });
      configureTaskSheet({ ventureTags: () => service.listVentureTags().map(tag => tag.name) });
      const connector = createTaskSheetConnector({
        db,
        service,
        client: createGoogleSheetsClient({ credentialsFile }),
        workerId: `cli-${process.pid}`,
        actionLog,
      });
      const inspected = await connector.bootstrapSchema({ confirmSheetId: confirmation });
      return { spreadsheetId: ACTION_ITEMS.spreadsheetId, tab: ACTION_ITEMS.tab, headers: inspected.schema.headers };
    });
  } else if (command === 'github-check') {
    // Proves the GitHub App credentials work before the bridge depends on them:
    // mints a real installation token and reports who the connector will act as
    // and which repositories it can see.
    const appId = options['app-id'] || process.env.GITHUB_APP_ID;
    const privateKeyFile = options['private-key'] || process.env.GITHUB_APP_PRIVATE_KEY_FILE;
    if (!appId) throw new Error('Missing GitHub App id (--app-id or GITHUB_APP_ID)');
    if (!privateKeyFile) throw new Error('Missing GitHub App private key (--private-key or GITHUB_APP_PRIVATE_KEY_FILE)');
    if (!existsSync(privateKeyFile)) throw new Error(`GitHub App private key not found: ${privateKeyFile}`);
    const client = createGitHubAppClient({
      appId,
      privateKey: readFileSync(privateKeyFile, 'utf8'),
      installationId: options.installation || process.env.GITHUB_APP_INSTALLATION_ID || null,
      assignee: options.assignee || process.env.GITHUB_ASSIGNEE_LOGIN || null,
    });
    const login = await client.login();
    const repos = await client.listAssignedRepos();
    result = { appId: String(appId), assignee: login, repositories: repos.length, sample: repos.slice(0, 10) };
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isEntry(import.meta.url)) {
  runTodoCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`todos CLI: ${error.message}\n`);
    process.exitCode = 1;
  });
}
