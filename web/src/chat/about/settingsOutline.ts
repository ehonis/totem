// A Settings pane for "Chat about this", read by allowlist rather than as
// innerText: headings, each setting's label (`.setting-row` strong), and its
// state where the control is a switch, a checkbox or a select. Text fields,
// textareas, <pre> and <code> are never read, so a key, an address or command
// output on the pane cannot reach the chat.
import type { SettingsOutline } from './context'

const SKIP = 'pre, code, textarea, input, [contenteditable="true"]'

/** An element's text with any skipped part (a <code> inside a heading) taken out. */
function textOf(el: Element | null | undefined): string {
  if (!el) return ''
  const copy = el.cloneNode(true) as Element
  copy.querySelectorAll(SKIP).forEach((n) => n.remove())
  return (copy.textContent || '').replace(/\s+/g, ' ').trim()
}

function stateOf(control: Element | null): string | null {
  if (!control) return null
  const sw = control.querySelector('[role="switch"][aria-checked]')
  if (sw) return sw.getAttribute('aria-checked') === 'true' ? 'on' : 'off'
  const box = control.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (box) return box.checked ? 'on' : 'off'
  const select = control.querySelector('select')
  if (select) return textOf(select.selectedOptions[0]) || null
  return null
}

export function settingsOutline(pane: HTMLElement): SettingsOutline {
  const items: SettingsOutline['items'] = []
  for (const el of pane.querySelectorAll('h1, h2, h3, h4, .setting-row')) {
    if (el.closest(SKIP)) continue
    if (el.matches('.setting-row')) {
      const label = textOf(el.querySelector('.setting-copy strong'))
      if (label) items.push({ label, state: stateOf(el.querySelector('.setting-control')) })
    } else {
      const heading = textOf(el)
      if (heading) items.push({ heading })
    }
  }
  return { items }
}
