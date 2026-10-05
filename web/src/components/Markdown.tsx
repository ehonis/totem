import React, { useMemo, useRef, useEffect } from 'react'
import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'

marked.use(
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
)
marked.setOptions({ breaks: true, gfm: true })

interface MarkdownProps {
  text?: string
  className?: string
}

export default function Markdown({ text, className = '' }: MarkdownProps) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => marked.parse(text || '') as string, [text])

  // Open links in a new tab and add a copy button to each code block.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.querySelectorAll('a[href]').forEach((a: any) => {
      a.target = '_blank'
      a.rel = 'noreferrer'
    })
    el.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.copy-btn')) return
      const btn = document.createElement('button')
      btn.className = 'copy-btn'
      btn.type = 'button'
      btn.textContent = 'Copy'
      btn.onclick = () => {
        const code = (pre.querySelector('code') as HTMLElement)?.innerText || pre.innerText
        navigator.clipboard?.writeText(code)
        btn.textContent = 'Copied'
        setTimeout(() => (btn.textContent = 'Copy'), 1200)
      }
      pre.appendChild(btn)
    })
  }, [html])

  return <div ref={ref} className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
}
