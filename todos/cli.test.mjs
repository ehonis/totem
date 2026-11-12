// Run with: node --test todos/cli.test.mjs
//
// The CLI keeps only the database commands: the two-way sheet sync (its sheet-* commands)
// and the GitHub task connector (github-check) were retired, and their setup wizard with them.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = join(import.meta.dirname, '..')

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, ['todos/cli.mjs', ...args], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME } })
    return stdout + stderr
  } catch (error) {
    return `${error.stdout || ''}${error.stderr || ''}`
  }
}

test('the retired sheet and GitHub commands are gone', async () => {
  for (const command of ['sheet-inspect', 'sheet-bootstrap-schema', 'github-check']) {
    const out = await cli([command])
    assert.match(out, /Usage:/, command)
    assert.doesNotMatch(out.split('Usage:')[1], new RegExp(command), `${command} is not offered`)
  }
})
