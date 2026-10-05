import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommandDetector } from './commands.mjs'

/** Type a string and press Enter, returning whatever commands came out. */
function run(detector, typed) {
  return detector.pushInput(typed + '\r')
}

test('records a plain command line', () => {
  const d = createCommandDetector()
  assert.deepEqual(run(d, 'git status'), [{ text: 'git status', labeled: true }])
})

test('splits multiple commands submitted in one chunk', () => {
  const d = createCommandDetector()
  const out = d.pushInput('echo one\recho two\r')
  assert.deepEqual(out.map((c) => c.text), ['echo one', 'echo two'])
})

test('a bare Enter at the prompt is not a command', () => {
  const d = createCommandDetector()
  assert.deepEqual(d.pushInput('\r'), [])
  assert.deepEqual(d.pushInput('   \r'), [])
})

test('applies backspace, ctrl-u and ctrl-w before submitting', () => {
  const d = createCommandDetector()
  assert.deepEqual(run(d, 'git stauts\x7f\x7f\x7ftus'), [{ text: 'git status', labeled: true }])

  const killed = createCommandDetector()
  assert.deepEqual(run(killed, 'rm -rf /\x15ls'), [{ text: 'ls', labeled: true }])

  const word = createCommandDetector()
  assert.deepEqual(run(word, 'git push origin\x17main'), [{ text: 'git push main', labeled: true }])
})

test('ctrl-c abandons the line without counting it', () => {
  const d = createCommandDetector()
  d.pushInput('rm -rf /\x03')
  assert.deepEqual(d.pushInput('\r'), [])
  assert.equal(d.state().line, '')
})

test('counts but does not label a line touched by history recall', () => {
  const d = createCommandDetector()
  // Up arrow: the shell replaces the line with something we never saw.
  const out = run(d, '\x1b[A')
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], { text: '', labeled: false, reason: 'line-editing' })
})

test('an escape sequence does not leak its letters into the next line', () => {
  const d = createCommandDetector()
  d.pushInput('\x1b[A')
  d.pushInput('\x03') // clear the unreliable line
  assert.deepEqual(run(d, 'ls'), [{ text: 'ls', labeled: true }])
})

test('tab completion marks the line unreliable', () => {
  const d = createCommandDetector()
  const out = run(d, 'cd pro\t')
  assert.equal(out[0].labeled, false)
})

test('ignores Enter while a full-screen program owns the terminal', () => {
  const d = createCommandDetector()
  assert.equal(run(d, 'vim notes.md')[0].text, 'vim notes.md')
  d.pushOutput('\x1b[?1049h') // vim takes the alternate screen
  assert.deepEqual(d.pushInput('ihello\rworld\r\x1b'), [])
  d.pushOutput('\x1b[?1049l') // :q
  assert.deepEqual(run(d, 'ls'), [{ text: 'ls', labeled: true }])
})

test('nested full-screen programs only re-enable counting at the outer exit', () => {
  const d = createCommandDetector()
  d.pushOutput('\x1b[?1049h')
  d.pushOutput('\x1b[?1049h')
  d.pushOutput('\x1b[?1049l')
  assert.deepEqual(run(d, 'still inside'), [])
  d.pushOutput('\x1b[?1049l')
  assert.deepEqual(run(d, 'ls'), [{ text: 'ls', labeled: true }])
})

test('handles enter and exit arriving in the same output chunk', () => {
  const d = createCommandDetector()
  d.pushOutput('\x1b[?1049hpaged output\x1b[?1049l')
  assert.equal(d.state().altScreenDepth, 0)
  assert.deepEqual(run(d, 'ls'), [{ text: 'ls', labeled: true }])
})

test('never labels what was typed at a password prompt', () => {
  const d = createCommandDetector()
  assert.equal(run(d, 'sudo systemctl restart nginx')[0].labeled, true)
  d.pushOutput('[sudo] password for ethan: ')
  const out = run(d, 'hunter2')
  assert.equal(out.length, 1, 'the submission is still counted')
  assert.deepEqual(out[0], { text: '', labeled: false, reason: 'sensitive-prompt' })
})

test('sees a password prompt through ANSI styling', () => {
  const d = createCommandDetector()
  d.pushOutput('\x1b[1;36mEnter passphrase for key \'/home/user/.ssh/id_ed25519\':\x1b[0m ')
  assert.equal(run(d, 'correct horse')[0].labeled, false)
})

test('stays armed at an echoing prompt, where the typed secret comes back as output', () => {
  // `read -p "Enter API token: "` echoes. If the flag were recomputed per chunk the
  // echoed characters would push the colon off the end of the line and disarm it.
  const d = createCommandDetector()
  d.pushOutput('Enter API token: ')
  d.pushInput('ghp_')
  d.pushOutput('ghp_')
  d.pushInput('secret')
  d.pushOutput('secret')
  assert.deepEqual(d.pushInput('\r'), [{ text: '', labeled: false, reason: 'sensitive-prompt' }])
})

test('disarms after the secret is submitted', () => {
  const d = createCommandDetector()
  d.pushOutput('Password: ')
  run(d, 'hunter2')
  d.pushOutput('\r\nWelcome back\r\nethan@box:~$ ')
  assert.deepEqual(run(d, 'whoami'), [{ text: 'whoami', labeled: true }])
})

test('disarms when the secret line is abandoned with ctrl-c', () => {
  const d = createCommandDetector()
  d.pushOutput('Password: ')
  d.pushInput('half-typed\x03')
  d.pushOutput('\r\nethan@box:~$ ')
  assert.deepEqual(run(d, 'ls'), [{ text: 'ls', labeled: true }])
})

test('does not treat prose mentioning a password as a prompt', () => {
  const d = createCommandDetector()
  d.pushOutput('warning: your password expires in 3 days\r\nethan@box:~$ ')
  assert.equal(run(d, 'passwd')[0].labeled, true)
})

test('counts an over-long pasted line without labeling it', () => {
  const d = createCommandDetector()
  const out = run(d, 'echo ' + 'x'.repeat(5000))
  assert.equal(out.length, 1)
  assert.equal(out[0].labeled, false)
})

test('ignores empty chunks in both directions', () => {
  const d = createCommandDetector()
  assert.deepEqual(d.pushInput(''), [])
  d.pushOutput('')
  assert.deepEqual(run(d, 'ls'), [{ text: 'ls', labeled: true }])
})
