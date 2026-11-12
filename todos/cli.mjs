#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { isEntry } from '../scripts/is-entry.mjs';

import {
  backupTodoDatabase,
  closeTodoDatabase,
  exportTodoDatabase,
  openTodoDatabase,
  restoreTodoDatabase,
} from './db.mjs';

const COMMAND_OPTIONS = {
  backup: new Set(['database', 'output']),
  export: new Set(['database', 'output']),
  restore: new Set(['source', 'database']),
};

function usage() {
  return [
    'Usage:',
    '  node todos/cli.mjs backup --database <path> --output <path>',
    '  node todos/cli.mjs export --database <path> --output <path>',
    '  node todos/cli.mjs restore --source <path> --database <path>',
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
