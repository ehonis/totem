import { describe, it, expect } from 'vitest'
import { analyze, isClosingFence, listBackspace, listDelete, listEnter, listIndent, listIndentLines, listOutdent, messageText, nextOrderedMarker, parseListLine } from './markdown'

// The caret is `|` in each case; the result is the text with the caret marked the same way.
const at = (s: string) => ({ value: s.replace('|', ''), caret: s.indexOf('|') })
const show = (r: { value: string; caret: number } | null) => (r ? r.value.slice(0, r.caret) + '|' + r.value.slice(r.caret) : null)
const enter = (s: string, shift = false) => { const { value, caret } = at(s); return show(listEnter(value, caret, shift)) }
const tab = (s: string) => { const { value, caret } = at(s); return show(listIndent(value, caret)) }
const untab = (s: string) => { const { value, caret } = at(s); return show(listOutdent(value, caret)) }
const back = (s: string) => { const { value, caret } = at(s); return show(listBackspace(value, caret)) }
const del = (s: string) => { const { value, caret } = at(s); return show(listDelete(value, caret)) }

const IMG = '![image.png](totem-ref://upload/a1b2c3d4e5f6a7b8)'

describe('Return in a list', () => {
  it('continues bullets and tasks, keeping their indent', () => {
    expect(enter('- foo|')).toBe('- foo\n- |')
    expect(enter('  * foo|')).toBe('  * foo\n  * |')
    expect(enter('- [x] done|')).toBe('- [x] done\n- [ ] |')
  })

  it('splits an item at the caret and numbers the new one next', () => {
    expect(enter('1. fo|obar')).toBe('1. fo\n2. |obar')
    expect(enter('07) a|')).toBe('07) a\n08) |')
  })

  it('renumbers the items after it, with their padding, up to the end of the list', () => {
    expect(enter('1. a|\n2. b\n03. c\n10. d')).toBe('1. a\n2. |\n3. b\n04. c\n5. d')
    for (const boundary of ['', 'text', '1) other list']) {
      expect(enter(`1. a|\n2. b\n${boundary}\n3. untouched`)).toBe(`1. a\n2. |\n3. b\n${boundary}\n3. untouched`)
    }
  })

  it('renumbers past nested items and stops at the parent', () => {
    expect(enter('  1) a|\n\t1) child\n  2) b\n1) parent\n  3) untouched')).toBe('  1) a\n  2) |\n\t1) child\n  3) b\n1) parent\n  3) untouched')
  })

  it('on an empty item lifts it one level per press, then leaves the list', () => {
    let s = '1. parent\n   1. child\n      1. |'
    for (const expected of ['1. parent\n   1. child\n   2. |', '1. parent\n   1. child\n2. |', '1. parent\n   1. child\n|']) {
      s = enter(s)!
      expect(s).toBe(expected)
    }
    expect(enter('- |')).toBe('|')
    expect(enter('- [ ] |')).toBe('|')
    expect(enter('1)\t|')).toBe('|')
  })

  it('renumbers the parent list after lifting an empty item into it', () => {
    expect(enter('1. a\n   1. |\n2. b')).toBe('1. a\n2. |\n3. b')
  })

  it('with Shift starts a continuation line, and Return on it adds the next item', () => {
    expect(enter('1. foo|', true)).toBe('1. foo\n   |')
    expect(enter('10. foo|', true)).toBe('10. foo\n    |')
    expect(enter('1. foo\n   |')).toBe('1. foo\n2. |')
    expect(enter('1. foo\n   bar|\n2. baz')).toBe('1. foo\n   bar\n2. |\n3. baz')
  })

  it('leaves a chip whole: the split is at its edge, and a line of chips keeps them', () => {
    expect(enter(`1. see ${IMG}|`)).toBe(`1. see ${IMG}\n2. |`)
    expect(enter(`1. ${IMG}| and more`)).toBe(`1. ${IMG}\n2. | and more`)
  })

  it('does nothing off a list, in a code block, or inside a marker', () => {
    expect(enter('plain|')).toBeNull()
    expect(enter('```\n- a|\n```')).toBeNull()
    expect(enter('1|. a')).toBeNull()
    expect(enter('2026.|')).toBeNull()
  })
})

describe('Tab and Shift+Tab', () => {
  it.each([
    ['1. parent\n2. ch|ild', '1. parent\n   1. ch|ild'],
    ['10. parent\n11. ch|ild', '10. parent\n    1. ch|ild'],
    ['1.\tparent\n2. ch|ild', '1.\tparent\n    1. ch|ild'],
    ['- parent\n- ch|ild', '- parent\n  - ch|ild'],
  ])('nests %j under the item above', (s, expected) => {
    expect(tab(s)).toBe(expected)
  })

  it('continues the numbering of a list already nested there', () => {
    expect(tab('1. parent\n   1. first\n2. second|')).toBe('1. parent\n   1. first\n   2. second|')
  })

  it('renumbers the items after it, and takes its own nested lines along', () => {
    expect(tab('1. a\n2. b|\n   1. b1\n   more of b\n3. c')).toBe('1. a\n   1. b|\n      1. b1\n      more of b\n2. c')
  })

  it('keeps a first item where it is, and still takes the key', () => {
    expect(tab('1. on|ly')).toBe('1. on|ly')
    expect(tab('text|')).toBeNull()
  })

  it.each(['- parent\n- ch|ild', '1. parent\n2. ch|ild', '1. a\n2. b|\n   1. b1\n3. c'])('Shift+Tab undoes Tab on %j', (s) => {
    expect(untab(tab(s)!)).toBe(s)
  })

  it('lifts a nested item after its parent and renumbers both lists', () => {
    expect(untab('1. a\n   1. b|\n2. c')).toBe('1. a\n2. b|\n3. c')
    expect(untab('1. a\n   1. b\n   2. c|\n   3. d\n2. e')).toBe('1. a\n   1. b\n2. c|\n   1. d\n3. e')
    expect(untab('- a\n  5. b|')).toBe('- a\n5. b|')
  })

  it('takes one step of indent off an item with no parent, and keeps a top-level item', () => {
    expect(untab('    - a|')).toBe('  - a|')
    expect(untab('- item|')).toBe('- item|')
  })
})

describe('Backspace and Delete with formatting on', () => {
  it('Backspace at an item\'s start takes it out of the list, or lifts a nested one', () => {
    expect(back('1. a\n2. |b')).toBe('1. a\n|b')
    expect(back('1. a\n   1. |b')).toBe('1. a\n2. |b')
    expect(back('1. a\n2. b|')).toBeNull()
  })

  it('Backspace at the start of a continuation line or the line below a list joins the line above', () => {
    expect(back('1. a\n   |b')).toBe('1. a|b')
    expect(back('- a\n|after')).toBe('- a|after')
    expect(back('plain\n|after')).toBeNull()
  })

  it('Delete at the end of a line joins the next one without its marker', () => {
    expect(del('1. a|\n2. b')).toBe('1. a|b')
    expect(del('1. a|\n   more')).toBe('1. a|more')
    expect(del('before|\n- a')).toBe('before|a')
    expect(del('- a|\n```\ncode\n```')).toBe('- a|\n```\ncode\n```')
    expect(del('plain|\nmore')).toBeNull()
  })
})

describe('reading the lines', () => {
  it('nests deeper items, continues items, and ends lists at a blank or plain line', () => {
    const lines = analyze('1. a\n   b\n   - c\n   d\n2. e\n\nplain\n   - f')
    expect(lines.map((l) => [l.owner, l.parent ?? null])).toEqual([[0, -1], [0, null], [2, 0], [0, null], [4, -1], [undefined, null], [undefined, null], [7, -1]])
  })

  it('keeps fenced code out of the lists, and needs a line after a fence to open one', () => {
    expect(analyze('```js\n- a\n```\n- b').map((l) => !!l.code)).toEqual([true, true, true, false])
    expect(analyze('```\n```').map((l) => !!l.code)).toEqual([false, false])
  })

  it('parses each kind of marker with its padding', () => {
    // One space or tab belongs to the marker; more are the item's text.
    expect(parseListLine('- [X]  todo')).toMatchObject({ kind: 'task', check: 'X', space: ' ', end: 6 })
    expect(parseListLine('-  beta')).toMatchObject({ kind: 'bullet', space: ' ', end: 2 })
    expect(parseListLine('- [x]todo')).toMatchObject({ kind: 'bullet', marker: '-' })
    expect(parseListLine('  3)\tthree')).toMatchObject({ kind: 'ordered', indent: '  ', marker: '3)', space: '\t', column: 8 })
    expect(parseListLine('1.5 kg')).toBeNull()
  })

  it('counts a marker up with its padding', () => {
    expect(['1.', '1)', '09.', '001)', '99.'].map(nextOrderedMarker)).toEqual(['2.', '2)', '10.', '002)', '100.'])
  })
})

describe('several items at once, and what is sent', () => {
  // The selection is `[` to `]`.
  const lines = (s: string, out: boolean) => {
    const from = s.indexOf('['), to = s.indexOf(']') - 1
    const r = listIndentLines(s.replace('[', '').replace(']', ''), from, to, out)
    return r && r.value.slice(0, r.caret) + '[' + r.value.slice(r.caret, r.end) + ']' + r.value.slice(r.end)
  }

  it('Tab nests every selected item under the same parent and keeps the selection', () => {
    expect(lines('1. a\n2. [b\n3. c]\n4. d', false)).toBe('1. a\n   1. [b\n   2. c]\n2. d')
    expect(lines('- a\n- b[x\n- cy]', false)).toBe('- a\n  - b[x\n  - cy]')
  })

  it('moves an item with its children once, however many of them are selected', () => {
    expect(lines('- a\n- [b\n  - c1\n  - c2]\n- d', false)).toBe('- a\n  - [b\n    - c1\n    - c2]\n- d')
    expect(lines('- a\n  - [b\n    - c]', true)).toBe('- a\n- [b\n  - c]')
  })

  it('moves a selected child whose selected parent cannot move, either way', () => {
    expect(lines('- a\n- [b\n  - c\n  - d]', true)).toBe('- a\n- [b\n- c\n- d]')
    expect(lines('1. a\n2. [b\n   1. c]', true)).toBe('1. a\n2. [b\n3. c]')
    expect(lines('- [a\n- b\n  - c]', false)).toBe('- [a\n  - b\n    - c]')
  })

  it('puts a multi-level selection back with Shift+Tab after Tab', () => {
    const start = '- a\n- [b\n  - c\n- d]'
    expect(lines(lines(start, false)!, true)).toBe(start)
  })

  it('leaves out a line the selection only reaches the start of', () => {
    expect(lines('- a\n- [b\n]- c', false)).toBe('- a\n  - [b\n]- c')
  })

  it('Shift+Tab lifts every selected item, and a selection off any list is not taken', () => {
    expect(lines('1. a\n   1. [b\n   2. c]\n2. d', true)).toBe('1. a\n2. [b\n3. c]\n4. d')
    expect(lines('pl[ai]n', false)).toBeNull()
  })

  it('leaves out an empty item Return left at the end of a list, and nothing else', () => {
    expect(messageText('- a\n- ')).toBe('- a')
    expect(messageText('1. a\n2.  \n')).toBe('1. a')
    expect(messageText('Born in\n2026.')).toBe('Born in\n2026.')
    expect(messageText('- ')).toBe('-')
  })

  it('never reads a chip after the backticks as a language', () => {
    expect(analyze('```[a.png](totem-ref://upload/abc123)\nnext').map((l) => !!l.code)).toEqual([false, false])
  })

  it('closes a fence up to three spaces in, as CommonMark does', () => {
    expect(['```', '  ```', '   ```  ', '    ```'].map((l) => isClosingFence(l, '```'))).toEqual([true, true, true, false])
  })
})
