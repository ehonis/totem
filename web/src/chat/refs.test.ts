import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { attachmentRef, editableRefs, formatRef, formatSize, middleTruncate, plainRefs, refIds, refLabel, splitRefs } from './refs'
import { BACKGROUNDS } from '../backgrounds'

const ID = 'a1b2c3d4e5f6a7b8'

describe('references in a message', () => {
  it('writes an image with ! and a file or pasted text without', () => {
    expect(formatRef(attachmentRef({ id: ID, name: 'image.png', kind: 'image' }))).toBe(`![image.png](totem-ref://upload/${ID})`)
    expect(formatRef(attachmentRef({ id: ID, name: 'notes.pdf', kind: 'file' }))).toBe(`[notes.pdf](totem-ref://upload/${ID})`)
    expect(formatRef(attachmentRef({ id: ID, name: 'Pasted text 1.txt', kind: 'text' }))).toBe(`[Pasted text 1.txt](totem-ref://upload/${ID})`)
  })

  it('strips brackets and line breaks from a label, keeps parentheses, and caps it at 200 UTF-16 units', () => {
    expect(refLabel('report [final] (v2)\nscan.pdf')).toBe('report final (v2) scan.pdf')
    expect(refLabel('[]')).toBe('file')
    expect(refLabel('é'.repeat(300))).toHaveLength(200)
    // A cut never splits a surrogate pair, and a long emoji name still makes a token that parses.
    expect(refLabel(`${'x'.repeat(199)}😀😀`)).toBe('x'.repeat(199))
    const emoji = formatRef(attachmentRef({ id: ID, name: '😀'.repeat(150), kind: 'file' }))
    expect(splitRefs(emoji)[0].ref?.label).toBe('😀'.repeat(100))
  })

  it('writes a label read back from the text as it was', () => {
    for (const label of ['a(b)', '', 'a  b', ' spaced ']) {
      const t = formatRef({ image: false, label, id: ID })
      expect(t).toBe(`[${label}](totem-ref://upload/${ID})`)
      expect(splitRefs(t)[0].ref?.label).toBe(label)
    }
    expect(formatRef({ image: false, label: 'a]b', id: ID })).toBe(`[a b](totem-ref://upload/${ID})`)
  })

  it('gives a plain text box names to edit and puts the references back', () => {
    const text = `see ![a.png](totem-ref://upload/${ID}) and [b.pdf](totem-ref://upload/ffffffffff)`
    const e = editableRefs(text)
    expect(e.text).toBe('see [a.png] and [b.pdf]')
    expect(e.restore(e.text)).toBe(text)
    expect(e.restore('Please see [a.png] and [b.pdf] now')).toBe(`Please see ![a.png](totem-ref://upload/${ID}) and [b.pdf](totem-ref://upload/ffffffffff) now`)
    // A name he deleted loses its reference; the rest keep theirs.
    expect(e.restore('see and [b.pdf]')).toBe('see and [b.pdf](totem-ref://upload/ffffffffff)')
  })

  it('deletes the right one of two same-named files', () => {
    const text = `a ![x.png](totem-ref://upload/${ID}) b [x.png](totem-ref://upload/ffffffffff)`
    const e = editableRefs(text)
    expect(e.text).toBe('a [x.png] b [x.png]')
    // The first (an image) goes; the second (a file) keeps its own reference.
    expect(e.restore('a  b [x.png]')).toBe('a  b [x.png](totem-ref://upload/ffffffffff)')
    expect(e.restore('a [x.png] b ')).toBe(`a ![x.png](totem-ref://upload/${ID}) b `)
  })

  it('keeps a file when a stray bracket next to it is deleted', () => {
    const text = `x [![a.png](totem-ref://upload/${ID}) y`
    const e = editableRefs(text)
    expect(e.text).toBe('x [[a.png] y')
    expect(e.restore('x [a.png] y')).toBe(`x ![a.png](totem-ref://upload/${ID}) y`)
  })

  it('takes the first of two adjacent same-named files when the caret says so', () => {
    const text = `![image.png](totem-ref://upload/${ID})![image.png](totem-ref://upload/ffffffffff)`
    const e = editableRefs(text)
    // Backspace after the first one leaves the caret at 0; the second keeps its own id.
    expect(e.restore('[image.png]', 0)).toBe('![image.png](totem-ref://upload/ffffffffff)')
    expect(e.restore('[image.png]', 11)).toBe(`![image.png](totem-ref://upload/${ID})`)
  })

  it('keeps a [name] he typed as text', () => {
    const text = `see [notes.pdf](totem-ref://upload/${ID})`
    const e = editableRefs(text)
    expect(e.restore('[notes.pdf] see [notes.pdf]')).toBe(`[notes.pdf] see [notes.pdf](totem-ref://upload/${ID})`)
  })

  it('maps a caret between the box and the message', () => {
    const text = `ab ![x.png](totem-ref://upload/${ID}) cd`
    const e = editableRefs(text)
    expect(e.text).toBe('ab [x.png] cd')
    expect(e.toValue(2)).toBe(2)
    expect(e.toValue(5)).toBe(text.indexOf(' cd'))
    expect(e.toValue(e.text.length)).toBe(text.length)
    expect(e.toShown(text.length - 1)).toBe(e.text.length - 1)
    expect(e.toShown(text.indexOf('totem'))).toBe(e.text.indexOf(' cd'))
  })

  it('reads every reference back, in order, with the text around it', () => {
    const text = `see ${formatRef({ image: true, label: 'a.png', id: ID })} and [b.pdf](totem-ref://upload/ffffffffff)!`
    expect(splitRefs(text)).toEqual([
      { text: 'see ' },
      { text: `![a.png](totem-ref://upload/${ID})`, ref: { image: true, label: 'a.png', id: ID } },
      { text: ' and ' },
      { text: '[b.pdf](totem-ref://upload/ffffffffff)', ref: { image: false, label: 'b.pdf', id: 'ffffffffff' } },
      { text: '!' },
    ])
    expect(refIds(`${text} ${text}`)).toEqual([ID, 'ffffffffff'])
  })

  it('leaves anything that is not a reference as text', () => {
    for (const s of [
      `[a](https://example.com/${ID})`,
      '[a](totem-ref://upload/short)',
      `[a](totem-ref://upload/${ID}`,
      `[a\nb](totem-ref://upload/${ID})`,
      `[${'x'.repeat(201)}](totem-ref://upload/${ID})`,
      `[a](totem-ref://upload/${ID}/../x)`,
    ]) {
      expect(splitRefs(s).some((p) => p.ref), s).toBe(false)
      expect(plainRefs(s)).toBe(s)
    }
  })

  it('shows plain names for previews and titles', () => {
    expect(plainRefs(`Why is ![image.png](totem-ref://upload/${ID}) blurry? [notes.pdf](totem-ref://upload/${ID})`)).toBe('Why is image.png blurry? notes.pdf')
  })

  it('reads in linear time on a long line', () => {
    const t = Date.now()
    plainRefs(`[${'x'.repeat(100_000)}`)
    splitRefs(`![${'['.repeat(50_000)}`)
    expect(Date.now() - t).toBeLessThan(500)
  })
})

describe('chip text', () => {
  it('gives sizes the way T3 Code does', () => {
    expect(formatSize(0)).toBe('1 KB')
    expect(formatSize(1)).toBe('1 KB')
    expect(formatSize(852_992)).toBe('833 KB')
    expect(formatSize(1023 * 1024 + 1)).toBe('1.0 MB')
    expect(formatSize(1022 * 1024)).toBe('1022 KB')
    expect(formatSize(5.5 * 1024 * 1024)).toBe('5.5 MB')
  })

  it('cuts a long name in the middle so the extension stays', () => {
    expect(middleTruncate('short.png')).toBe('short.png')
    const cut = middleTruncate('quarterly-report-for-the-board-final-version-2.pdf')
    expect(Array.from(cut)).toHaveLength(36)
    expect(cut.startsWith('quarterly-report-for')).toBe(true)
    expect(cut.endsWith('-version-2.pdf')).toBe(true)
    expect(cut).toContain('…')
  })
})

describe('chip colours', () => {
  // WCAG contrast of a #rrggbb pair.
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
  const css = readFileSync(join(resolve(__dirname), 'chat.css'), 'utf8')
  const colours = Object.fromEntries([...css.matchAll(/--(chip-[a-z]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]))

  it('defines one for each kind', () => {
    expect(Object.keys(colours).sort()).toEqual(['chip-file', 'chip-image', 'chip-skill', 'chip-text'])
  })

  it('are the iPhone app\'s too', () => {
    const app = readFileSync(join(resolve(__dirname), '../../../mobile/src/features/chat/Message.tsx'), 'utf8')
    const line = /const CHIP = \{([^}]*)\}/.exec(app)?.[1] || ''
    const appColours = Object.fromEntries([...line.matchAll(/(\w+): '(#[0-9a-f]{6})'/g)].map((m) => [`chip-${m[1]}`, m[2]]))
    expect(appColours).toEqual(colours)
  })

  it('read at 4.5:1 or more on every background palette\'s page, panel and bubble', () => {
    for (const b of BACKGROUNDS) {
      for (const surface of [b.bg, b.panel, b.raised]) {
        for (const [name, colour] of Object.entries(colours)) expect(contrast(colour, surface), `${name} on ${b.name} ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('the app\'s copy', () => {
  it('is byte for byte the web\'s', () => {
    const here = resolve(__dirname)
    expect(readFileSync(join(here, '../../../mobile/src/lib/chat/refs.ts'), 'utf8')).toBe(readFileSync(join(here, 'refs.ts'), 'utf8'))
  })
})
