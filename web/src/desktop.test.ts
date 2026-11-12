import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { desktopChrome, installWindowChrome } from './desktop'

const calls: string[] = []
let boot: string[] = []

function press(el: Element, detail = 1) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail }))
}

describe('desktop window chrome in a browser', () => {
  it('is off', () => {
    expect(desktopChrome()).toBe(null)
  })
})

describe('desktop window chrome', () => {
  beforeAll(() => {
    window.__TOTEM_DESKTOP__ = { chrome: 'windows' }
    window.__TAURI_INTERNALS__ = { invoke: async (cmd: string) => { calls.push(cmd); return cmd.endsWith('is_maximized') ? true : undefined } }
    document.body.innerHTML = `
      <div class="app shell">
        <main class="main">
          <div class="vc-split"><div class="vc"><header class="vc-top">
            <div class="vc-top-title">A chat</div>
            <button type="button" class="b">Files</button>
          </header><p class="log">reply</p></div></div>
        </main>
      </div>`
    installWindowChrome()
    boot = [...calls]
  })
  beforeEach(() => { calls.length = 0 })

  it('marks the document so the CSS and the app fallback can see it', async () => {
    expect(document.documentElement.dataset.desktop).toBe('windows')
    await Promise.resolve()
    await Promise.resolve()
    expect(document.documentElement.classList.contains('wc-maximized')).toBe(true)
  })

  it('takes the title bar away on load, in case the app had given it back', () => {
    expect(boot).toContain('plugin:window|set_decorations')
  })

  it('moves the window from a header, its title included', () => {
    press(document.querySelector('.vc-top')!)
    press(document.querySelector('.vc-top-title')!)
    expect(calls).toEqual(['plugin:window|start_dragging', 'plugin:window|start_dragging'])
  })

  it('maximizes on a double click', () => {
    press(document.querySelector('.vc-top-title')!, 2)
    expect(calls).toEqual(['plugin:window|internal_toggle_maximize'])
  })

  it('leaves buttons and page content alone', () => {
    press(document.querySelector('.b')!)
    press(document.querySelector('.log')!)
    expect(calls).toEqual([])
  })

  it('treats the page as a handle only where nothing covers it', () => {
    press(document.querySelector('.main')!)
    press(document.querySelector('.vc')!)
    expect(calls).toEqual(['plugin:window|start_dragging'])
  })
})

describe('desktop updates', () => {
  it('reads what the app last reported and hears each change', async () => {
    const { desktopUpdate, onDesktopUpdate } = await import('./desktop')
    window.__TOTEM_DESKTOP__ = { chrome: 'windows', version: '0.2.5' }
    expect(desktopUpdate()).toBe(null)
    let heard = 0
    const off = onDesktopUpdate(() => { heard++ })
    window.__TOTEM_DESKTOP__.update = { state: 'ready', version: '0.2.6' }
    window.dispatchEvent(new Event('totem-desktop-update'))
    off()
    window.dispatchEvent(new Event('totem-desktop-update'))
    expect(heard).toBe(1)
    expect(desktopUpdate()).toEqual({ state: 'ready', version: '0.2.6' })
  })
})
