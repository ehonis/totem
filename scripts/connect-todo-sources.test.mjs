// Run with: node --test scripts/connect-todo-sources.test.mjs
//
// The wizard writes TASK_SHEET_* to .env and then verifies the sheet with
// todos/cli.mjs in the same run. The CLI only sees those values if it is started
// with that .env loaded, which is what todo_cli does.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = join(import.meta.dirname, '..')
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'connect-todo-sources.sh'), 'utf8')

async function cli(args, env = {}) {
  const clean = { PATH: process.env.PATH, HOME: process.env.HOME, ...env }
  try {
    const { stdout, stderr } = await run(process.execPath, args, { cwd: ROOT, env: clean })
    return stdout + stderr
  } catch (error) {
    return `${error.stdout || ''}${error.stderr || ''}`
  }
}

test('every todos/cli.mjs call in the wizard goes through todo_cli', () => {
  const calls = SCRIPT.split('\n').filter((line) => /node .*todos\/cli\.mjs/.test(line) && !line.includes('SKIPPED+=') && !/^\s*#/.test(line))
  assert.deepEqual(calls.filter((line) => !line.includes('--env-file-if-exists')), [])
  assert.match(SCRIPT, /todo_cli sheet-inspect/)
  assert.match(SCRIPT, /todo_cli sheet-bootstrap-schema/)
  assert.match(SCRIPT, /todo_cli github-check/)
})

test('with the wizard\'s .env loaded, the CLI sees TASK_SHEET_ID written earlier in the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'totem-wizard-'))
  const envFile = join(dir, '.env')
  writeFileSync(envFile, 'TASK_SHEET_ID=example-sheet-id\nTASK_SHEET_ASSIGNEES=Alex\n')
  const without = await cli(['todos/cli.mjs', 'sheet-inspect'])
  assert.match(without, /Set TASK_SHEET_ID/)
  const withEnv = await cli([`--env-file-if-exists=${envFile}`, 'todos/cli.mjs', 'sheet-inspect'])
  assert.doesNotMatch(withEnv, /Set TASK_SHEET_ID/)
  assert.match(withEnv, /credentials/i, 'gets as far as needing the service-account file')
})

test('the wizard has no built-in GitHub login', () => {
  assert.doesNotMatch(SCRIPT, new RegExp(['eh', 'onis'].join('')))
  assert.match(SCRIPT, /gh api user --jq \.login/)
})
