// The "Select text" sheet shows a message as the text it reads as (plainText.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { markdownToPlainText as plain } from './plainText.ts'

test('emphasis, links and images read as their words', () => {
  assert.equal(plain('This is **bold**, *italic*, __also bold__ and ~~gone~~.'), 'This is bold, italic, also bold and gone.')
  assert.equal(plain('See [the docs](https://example.com/a_b) and ![a chart](/api/x.png).'), 'See the docs and a chart.')
  assert.equal(plain('Mail <mailto:owner@example.com> or <https://example.com>.'), 'Mail mailto:owner@example.com or https://example.com.')
})

test('words with underscores and lone asterisks stay as written', () => {
  assert.equal(plain('Set snake_case_name and 2 * 3 * 4.'), 'Set snake_case_name and 2 * 3 * 4.')
  assert.equal(plain('An escaped \\*star\\* and a path a/b_c.md'), 'An escaped *star* and a path a/b_c.md')
})

test('code keeps its characters', () => {
  assert.equal(plain('Run `npm **test**` now.'), 'Run npm **test** now.')
  assert.equal(plain('```js\nconst a = **b** // [x](y)\n```\nafter'), 'const a = **b** // [x](y)\nafter')
  assert.equal(plain('~~~\n# not a heading\n~~~'), '# not a heading')
})

test('headings, quotes, rules and lists', () => {
  assert.equal(plain('## Plan\n> quoted *line*\n\n---\n- one\n  * two\n1. first\n- [x] done\n- [ ] open'),
    'Plan\nquoted line\n\n• one\n  • two\n1. first\n☑ done\n☐ open')
})

test('a table reads as rows of tab-separated cells', () => {
  assert.equal(plain('| Item | Link |\n|---|:---:|\n| Website | [table link](https://e.com) |\n| A \\| B | `x` |'),
    'Item\tLink\nWebsite\ttable link\nA | B\tx')
})

test('blank runs collapse and the ends are trimmed', () => {
  assert.equal(plain('\n\nA\n\n\n\nB\n\n'), 'A\n\nB')
  assert.equal(plain(''), '')
  assert.equal(plain(undefined), '')
})

test('bold and links around code close, and code keeps its characters', () => {
  assert.equal(plain('**Run `npm test`** first'), 'Run npm test first')
  assert.equal(plain('- **`plainText.ts`**: pure'), '• plainText.ts: pure')
  assert.equal(plain('[`foo()`](https://e.com) and `a **b**`'), 'foo() and a **b**')
  assert.equal(plain('``code with ` inside`` done'), 'code with ` inside done')
  assert.equal(plain('an escaped \\`tick\\` here'), 'an escaped `tick` here')
  assert.equal(plain('an unclosed ` tick and *it*'), 'an unclosed ` tick and it')
  assert.equal(plain('a span of spaces `  ` and ` x ` kept'), 'a span of spaces    and x kept')
})

test('what Markdown leaves alone stays as written', () => {
  assert.equal(plain('Read [wiki](https://en.wikipedia.org/wiki/Foo_(bar)) now'), 'Read wiki now')
  assert.equal(plain('Set my__private__var and **bold**'), 'Set my__private__var and bold')
  assert.equal(plain('Press the key #'), 'Press the key #')
  assert.equal(plain('## Title ##'), 'Title')
  assert.equal(plain('## C#'), 'C#')
  assert.equal(plain('A prompt \ue0b0 glyph \ue05c'), 'A prompt \ue0b0 glyph \ue05c')
})

test('long runs of spaces, pipes, dashes or backticks stay fast', () => {
  for (const line of [
    ' '.repeat(100000) + 'x',
    '|' + ' '.repeat(100000) + '-x',
    '# ' + ' '.repeat(100000) + 'x',
    '<http:a'.repeat(15000),
    '| a ' .repeat(25000),
    '- '.repeat(50000) + 'x',
    Array.from({ length: 400 }, (_, i) => '`'.repeat(i + 1)).join(' x '),
  ]) {
    const start = performance.now()
    plain(line)
    assert.ok(performance.now() - start < 1000, `${JSON.stringify(line.slice(0, 12))}… took ${Math.round(performance.now() - start)} ms`)
  }
})

test('a long line with no closing markers stays fast', () => {
  const line = '**a *b _c [d `e ~~f '.repeat(5000)
  const start = performance.now()
  plain(line)
  assert.ok(performance.now() - start < 1000, `took ${Math.round(performance.now() - start)} ms`)
})
