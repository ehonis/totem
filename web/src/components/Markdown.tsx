import React, { useMemo, useRef, useEffect } from 'react'
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'
import 'highlight.js/styles/github-dark.css'

// A private Marked instance, so nothing else that imports `marked` inherits the
// highlighter or the options.
const md = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext'
      try {
        return hljs.highlight(code, { language }).value
      } catch {
        return code
      }
    },
  }),
  { breaks: true, gfm: true },
)

// Agent replies are model output that has read web pages and emails; rendering
// them as raw HTML is how a page's <img onerror> ends up running in the
// dashboard. Sanitised, with links forced into a new tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  // A screenshot the agent is sharing names a file on the box until the turn
  // ends and the bridge swaps in its upload URL; until then it's a placeholder,
  // not a broken image.
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || ''
    if (/^(file:\/\/|\/(?!api\/))/.test(src)) { node.removeAttribute('src'); node.setAttribute('data-pending', '') }
    node.setAttribute('loading', 'lazy')
  }
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer noopener')
  }
})

function render(text: string) {
  return DOMPurify.sanitize(md.parse(text || '') as string, { ADD_ATTR: ['target'] })
}

// Pictures the agent found, laid out the way ChatGPT shows products and places:
// a paragraph holding only images (each optionally linked) is a row of cards
// captioned by their alt text; an image on its own stays full width, so images
// in separate paragraphs stack as a column. Remote pictures go out without a
// referrer (most hotlink blocks key on it), and one that fails to load removes
// itself rather than leaving a broken frame.
function layoutImages(root: HTMLElement) {
  root.querySelectorAll('img').forEach((img) => {
    if (img.dataset.laid) return
    img.dataset.laid = '1'
    img.referrerPolicy = 'no-referrer'
    img.decoding = 'async'
    img.addEventListener('error', () => {
      const card = img.closest('.md-card') || (img.parentElement?.tagName === 'A' ? img.parentElement : img)
      const gallery = card.closest('.md-gallery')
      card.remove()
      if (gallery && !gallery.querySelector('img')) gallery.remove()
    }, { once: true })
  })
  root.querySelectorAll('p').forEach((p) => {
    if (p.classList.contains('md-gallery')) return
    const items = [...p.childNodes].filter((n) => !(n.nodeType === 3 && !n.textContent?.trim()) && (n as Element).tagName !== 'BR')
    const isImage = (n: Node) => (n as Element).tagName === 'IMG'
      || ((n as Element).tagName === 'A' && (n as Element).children.length === 1 && (n as Element).firstElementChild?.tagName === 'IMG' && !(n as Element).textContent?.trim())
    if (items.length < 2 || !items.every(isImage)) return
    p.classList.add('md-gallery')
    p.replaceChildren(...items.map((n) => {
      const img = ((n as Element).tagName === 'IMG' ? n : (n as Element).firstElementChild) as HTMLImageElement
      const href = (n as Element).tagName === 'A' ? (n as HTMLAnchorElement).href : img.getAttribute('src') || ''
      const card = document.createElement('a')
      card.className = 'md-card'
      if (href && !img.hasAttribute('data-pending')) { card.href = href; card.target = '_blank'; card.rel = 'noreferrer noopener' }
      const frame = document.createElement('span')
      frame.className = 'md-card-img'
      frame.append(img)
      card.append(frame)
      if (img.alt) {
        const cap = document.createElement('span')
        cap.className = 'md-card-cap'
        cap.textContent = img.alt
        card.append(cap)
      }
      return card
    }))
  })
}

interface MarkdownProps {
  text?: string
  className?: string
}

/** Markdown with a language label and copy button on each code block. */
export default React.memo(function Markdown({ text, className = '' }: MarkdownProps) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => render(text || ''), [text])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    layoutImages(el)
    el.querySelectorAll('pre').forEach((pre) => {
      if (pre.parentElement?.classList.contains('md-code')) return
      const code = pre.querySelector('code')
      const lang = (code?.className.match(/language-([\w+-]+)/)?.[1] || '').replace('plaintext', '')
      const wrap = document.createElement('div')
      wrap.className = 'md-code'
      const head = document.createElement('div')
      head.className = 'md-code-head'
      const label = document.createElement('span')
      label.textContent = lang || 'text'
      const btn = document.createElement('button')
      btn.className = 'copy-btn'
      btn.type = 'button'
      btn.textContent = 'Copy'
      btn.onclick = () => {
        navigator.clipboard?.writeText(code?.innerText || pre.innerText)
        btn.textContent = 'Copied'
        setTimeout(() => (btn.textContent = 'Copy'), 1200)
      }
      head.append(label, btn)
      pre.replaceWith(wrap)
      wrap.append(head, pre)
    })
  }, [html])

  return <div ref={ref} className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
})
