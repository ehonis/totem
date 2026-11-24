import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { createComposerExtensions } from './extensions'
import { REF_NODE, docRefIds, docToValue, offsetToPos, posToOffset, selectionRange, valueToDoc, valueToSlice } from './doc'

const schema = getSchema(createComposerExtensions({ known: () => new Set() }))
const formatted = getSchema(createComposerExtensions({ known: () => new Set(), markdown: true }))
const IMG = '![image.png](totem-ref://upload/a1b2c3d4e5f6a7b8)'
const DOC = '[notes.pdf](totem-ref://upload/f0e1d2c3b4a59687)'

describe('the editor\'s document and the message string', () => {
  it('keeps chips, lines and every other character through a round trip', () => {
    for (const value of [
      '',
      'plain',
      `look ${IMG} and ${DOC} please`,
      `${IMG}${DOC}`,
      `first line\n\n${IMG}\n  indented [not a ref](https://x.y) \\*kept\\* \`code\``,
      `trailing newline\n`,
      `[odd](totem-ref://upload/short) ${IMG}`,
      // Labels typed by hand come back as they were.
      '[a(b)](totem-ref://upload/abcdefgh12) [](totem-ref://upload/abcdefgh12) [ a  b ](totem-ref://upload/abcdefgh12)',
      'crlf stays\r',
    ]) {
      expect(docToValue(valueToDoc(schema, value))).toBe(value)
    }
  })

  it('makes each reference one inline node', () => {
    const doc = valueToDoc(schema, `a ${IMG} b ${DOC}\n${IMG}`)
    const refs: unknown[] = []
    doc.descendants((n) => { if (n.type.name === REF_NODE) refs.push(n.attrs) })
    expect(refs).toEqual([
      { id: 'a1b2c3d4e5f6a7b8', label: 'image.png', image: true },
      { id: 'f0e1d2c3b4a59687', label: 'notes.pdf', image: false },
      { id: 'a1b2c3d4e5f6a7b8', label: 'image.png', image: true },
    ])
    expect([...docRefIds(doc)]).toEqual(['a1b2c3d4e5f6a7b8', 'f0e1d2c3b4a59687'])
    expect(doc.childCount).toBe(2)
  })

  it('maps a caret between string offsets and document positions', () => {
    const value = `ab ${IMG} cd\nef`
    const doc = valueToDoc(schema, value)
    // Every offset outside a reference survives the trip; one inside lands after it.
    for (let offset = 0; offset <= value.length; offset++) {
      const back = posToOffset(doc, offsetToPos(doc, offset))
      const inside = offset > 3 && offset < 3 + IMG.length
      expect(back, `offset ${offset}`).toBe(inside ? 3 + IMG.length : offset)
    }
    expect(offsetToPos(doc, value.length)).toBe(doc.content.size - 1)
    expect(offsetToPos(doc, 0)).toBe(1)
  })

  it('parses pasted text into lines that join the lines around them', () => {
    const slice = valueToSlice(schema, `one ${IMG}\ntwo`)
    expect(slice.openStart).toBe(1)
    expect(slice.openEnd).toBe(1)
    expect(slice.content.childCount).toBe(2)
    expect(slice.content.firstChild?.lastChild?.type.name).toBe(REF_NODE)
  })
})

describe('the formatted document and the message string', () => {
  const shape = (n: PMNode): unknown => (n.isText ? n.text : n.type.name === REF_NODE ? 'ref'
    : n.childCount ? { [n.type.name]: n.content.content.map(shape) } : n.type.name)

  it('gives back exactly the Markdown it was made from', () => {
    for (const value of [
      '1. a\n2. b\n3. c',
      '3) a\n07. b\n1.\tc\n10.  d',
      '- a\n* b\n+ c\n-\n1.',
      '- [ ] todo\n- [X]  done\n* [x] star\n- [ ]',
      '1. parent\n   - child\n     more of child\n   back in parent\n2. next',
      '  - indented first\n\t- tab\n    \n- after a blank continuation',
      `1. ${IMG} and ${DOC}\n   ${IMG}`,
      'text\n- list\nmore text\n\n```js\nconst a = 1\n  - not a list\n```\nafter',
      '```\nnever closed\n- still code',
      '```\n```\n~~~~\n```\n~~~~',
      '```\n',
      'not 1. a list\n1.5 kg\n-not either',
      '```\ncode\n  ```\nafter',
    ]) {
      expect(docToValue(valueToDoc(formatted, value)), JSON.stringify(value)).toBe(value)
    }
  })

  it('makes lists, items, continuation lines and code their own nodes', () => {
    const doc = valueToDoc(formatted, `intro\n1. a\n   more\n   - [x] b\n2. ${IMG}\n\n\`\`\`\nx\n\`\`\``)
    expect(doc.content.content.map(shape)).toEqual([
      { paragraph: ['intro'] },
      { orderedList: [
        { listItem: [{ paragraph: ['a'] }, { paragraph: ['more'] }, { taskList: [{ taskItem: [{ paragraph: ['b'] }] }] }] },
        { listItem: [{ paragraph: ['ref'] }] },
      ] },
      'paragraph',
      { codeBlock: ['x'] },
    ])
    expect(doc.child(1).child(0).attrs).toMatchObject({ indent: '', marker: '1.', space: ' ' })
    expect(doc.child(1).child(0).child(1).attrs.indent).toBe('   ')
    expect(doc.child(3).attrs).toMatchObject({ fence: '```', language: '', close: '\n```' })
  })

  it('writes a longer fence when the code holds one, and closes a block that more follows', () => {
    const code = formatted.nodes.codeBlock
    const p = formatted.nodes.paragraph.create(null, formatted.text('after'))
    expect(docToValue(formatted.nodes.doc.create(null, [code.create({ close: '\n```' }, formatted.text('a\n```\nb'))]))).toBe('````\na\n```\nb\n````')
    expect(docToValue(formatted.nodes.doc.create(null, [code.create({ close: '' }, formatted.text('x')), p]))).toBe('```\nx\n```\nafter')
  })

  it('writes a closing fence typed as the code\'s last line as the block\'s close, not inside it', () => {
    const code = formatted.nodes.codeBlock
    expect(docToValue(formatted.nodes.doc.create(null, [code.create({ close: '\n```' }, formatted.text('code\n```'))]))).toBe('```\ncode\n```')
    expect(docToValue(formatted.nodes.doc.create(null, [code.create({ close: '\n```' }, formatted.text('a\n```\nb\n  ```'))]))).toBe('````\na\n```\nb\n````')
  })

  it('copies a selection as its Markdown: markers and fences from a line\'s start, plain text inside one', () => {
    const value = `Plan:\n1. ab\n   - c\n- [x] d ${IMG}\n\`\`\`js\nx\n\`\`\`\nend`
    const doc = valueToDoc(formatted, value)
    const selectionToValue = (d: PMNode, from: number, to: number) => {
      const { start, end } = selectionRange(d, from, to)
      return value.slice(start, end)
    }
    expect(selectionToValue(doc, 0, doc.content.size)).toBe(value)
    const at = (offset: number) => offsetToPos(doc, offset)
    expect(selectionToValue(doc, at(value.indexOf('ab')), at(value.indexOf(' c') + 2))).toBe('1. ab\n   - c')
    expect(selectionToValue(doc, at(value.indexOf('ab') + 1), at(value.indexOf('ab') + 2))).toBe('b')
    // Inside one line or one code block, a selection is only its text.
    expect(selectionToValue(doc, at(value.indexOf('x\n')), at(value.indexOf('x\n') + 1))).toBe('x')
    expect(selectionToValue(doc, at(value.indexOf('ab')), at(value.indexOf('ab') + 2))).toBe('ab')
    // Reaching past the block takes its fences.
    expect(selectionToValue(doc, at(value.indexOf('x\n')), at(value.indexOf('end') + 1))).toBe('```js\nx\n```\ne')
  })

  it('maps a caret through the prefixes: one in a marker or fence lands on the text after it', () => {
    const value = `1. ab\n   - ${IMG} c\n\`\`\`\nxy\n\`\`\``
    const doc = valueToDoc(formatted, value)
    const L = IMG.length
    // `1. `, `   - `, the opening fence and its newline; the closing fence lands at the end of the code.
    const prefixes = [[0, 3], [6, 11], [14 + L, 18 + L]]
    for (let offset = 0; offset <= value.length; offset++) {
      const back = posToOffset(doc, offsetToPos(doc, offset))
      const prefix = prefixes.find(([a, b]) => offset >= a && offset < b)
      if (prefix) expect(back, `offset ${offset}`).toBe(prefix[1])
      else if (offset > 20 + L) expect(back, `offset ${offset}`).toBe(20 + L)
      else if (offset > 11 && offset < 11 + L) expect(back, `offset ${offset}`).toBe(11 + L)
      else expect(back, `offset ${offset}`).toBe(offset)
    }
  })
})
