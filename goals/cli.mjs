#!/usr/bin/env node
// Inspect and drive goals from a shell, without the bridge running.
//
// Read-first by design: `list` and `review` are what this is usually for, and they
// answer straight from data/todos.db. The write commands exist so a goal can be set up
// or corrected when the dashboard is not to hand — they go through the same service the
// HTTP and MCP surfaces use, so every rule (one level of nesting, manual completion, the
// postpone counter) holds here too.
//
//   node goals/cli.mjs list [--period this_week]
//   node goals/cli.mjs review [--period this_week]
//   node goals/cli.mjs find <text>
//   node goals/cli.mjs add "Ride 150 miles" [--period this_week] [--metric "miles:150:miles"]
//   node goals/cli.mjs log <metricId> --delta 12
//   node goals/cli.mjs complete <goalId> [--undo]
//   node goals/cli.mjs postpone <goalId>
//
// Strava is never wired up here: a CLI read must not spend an API quota, so a
// connector-fed metric prints as "can't read" rather than as a number or a zero.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createActionLog } from '../logs/store.mjs';
import { closeTodoDatabase, openTodoDatabase } from '../todos/db.mjs';
import { createGoalService } from './service.mjs';
import { formatAmount } from './units.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith('--')) options[key] = true;
      else { options[key] = next; i += 1; }
    } else positional.push(token);
  }
  return { command, options, positional };
}

function usage() {
  return [
    'Usage:',
    '  node goals/cli.mjs list [--period this_week] [--database <path>]',
    '  node goals/cli.mjs review [--period this_week]',
    '  node goals/cli.mjs find <text>',
    '  node goals/cli.mjs add "<title>" [--period this_week] [--metric "label:target:unit"]…',
    '  node goals/cli.mjs log <metricId> (--delta N | --value N)',
    '  node goals/cli.mjs complete <goalId> [--undo]',
    '  node goals/cli.mjs postpone <goalId>',
  ].join('\n');
}

const pct = (value) => (value === null || value === undefined ? '  —' : `${String(value).padStart(3)}%`);

function printMetric(metric, indent) {
  const amount = metric.available
    ? `${formatAmount(metric.value, metric.unit)} / ${formatAmount(metric.targetValue, metric.unit)}`
    : `can't read — ${metric.unavailableReason}`;
  const rolled = metric.available && metric.feederCount > 0
    ? `  (incl. ${formatAmount(metric.rolledUpValue, metric.unit)} from ${metric.feederCount})`
    : '';
  const source = metric.sourceKind === 'manual' ? '' : '  [auto]';
  console.log(`${indent}${pct(metric.percent)}  ${metric.label}: ${amount}${rolled}${source}`);
  console.log(`${indent}      id ${metric.id}`);
}

function printGoal(goal) {
  const state = goal.complete ? 'done' : goal.periodState === 'expired' ? 'EXPIRED' : `${goal.daysLeft}d left`;
  const moved = goal.postponedCount > 0 ? `  moved ${goal.postponedCount}x` : '';
  console.log(`\n${pct(goal.progress.percent)}  ${goal.title}   [${state}]${moved}`);
  console.log(`      ${goal.period.label}   id ${goal.id}`);
  if (goal.notes) console.log(`      ${goal.notes}`);
  for (const metric of goal.metrics) printMetric(metric, '      ');
  for (const sub of goal.subGoals) {
    console.log(`      ${sub.complete ? '[x]' : '[ ]'} ${sub.title ?? '(unnamed step)'}`);
    for (const metric of sub.metrics) printMetric(metric, '          ');
  }
  for (const link of goal.links) {
    console.log(`      -> ${link.kind === 'todo' ? `task: ${link.todo?.title ?? link.label}` : link.url}`);
  }
}

// "miles:150:miles" -> { label, targetValue, unit }
function parseMetric(spec) {
  const [label, target, unit] = String(spec).split(':');
  if (!label || !Number(target)) throw new Error(`--metric wants "label:target[:unit]", got "${spec}"`);
  return { label, targetValue: Number(target), unit: unit || null };
}

async function main() {
  const { command, options, positional } = parseArguments(process.argv.slice(2));
  if (!command || command === 'help' || options.help) { console.log(usage()); return; }

  const file = options.database || process.env.TODO_DATABASE_FILE || join(HERE, 'data', 'todos.db');
  const db = openTodoDatabase({ file });
  const actionLog = createActionLog({ file: process.env.ACTION_LOG_FILE || join(HERE, 'data', 'action-log.jsonl') });
  // No Strava client: see the header.
  const service = createGoalService({ db, actionLog, strava: null });
  const context = { actor: 'cli', reason: `goals/cli.mjs ${command}` };
  const period = typeof options.period === 'string' ? options.period : 'this_week';

  try {
    if (command === 'list') {
      const goals = await service.listGoals({ period });
      if (goals.length === 0) console.log(`Nothing set for ${period.replace('_', ' ')}.`);
      goals.forEach(printGoal);
      return;
    }

    if (command === 'review') {
      const review = await service.review({ period });
      console.log(`${review.period.label} — ${review.completed}/${review.total} done, ${review.daysLeft} day(s) left`);
      const section = (title, list) => {
        if (list.length === 0) return;
        console.log(`\n${title}`);
        list.forEach((goal) => console.log(`  - ${goal.title} (${pct(goal.progress.percent).trim()})`));
      };
      section('Running out of time:', review.expiring);
      section('Expired and waiting on you:', review.expired);
      section('Moved three or more times — still a goal?:', review.repeatedlyPostponed);
      return;
    }

    if (command === 'find') {
      const goals = await service.findGoals(positional.join(' '));
      if (goals.length === 0) console.log('No match.');
      goals.forEach(printGoal);
      return;
    }

    if (command === 'add') {
      const metrics = [].concat(options.metric ?? []).filter((m) => typeof m === 'string').map(parseMetric);
      const { goal } = await service.createGoal({ title: positional.join(' '), period, metrics }, context);
      printGoal(goal);
      return;
    }

    if (command === 'log') {
      const [metricId] = positional;
      if (!metricId) throw new Error('log needs a metric id — find it with `list`');
      const patch = options.value !== undefined ? { value: Number(options.value) } : { delta: Number(options.delta) };
      printGoal((await service.updateMetric(metricId, patch, context)).goal);
      return;
    }

    if (command === 'complete') {
      const [goalId] = positional;
      if (!goalId) throw new Error('complete needs a goal id');
      printGoal(await service.setGoalCompletion(goalId, !options.undo, context));
      return;
    }

    if (command === 'postpone') {
      const [goalId] = positional;
      if (!goalId) throw new Error('postpone needs a goal id');
      const result = await service.postponeGoal(goalId, context);
      console.log(`${result.from.label} -> ${result.to.label} (moved ${result.goal.postponedCount}x)`);
      printGoal(result.goal);
      return;
    }

    console.error(`Unknown command "${command}".\n\n${usage()}`);
    process.exitCode = 64;
  } finally {
    closeTodoDatabase(db);
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
