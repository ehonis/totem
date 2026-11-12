/**
 * Hooks for the desktop app (`desktop/`). Its global hotkeys fire while Totem is
 * in the background, so they can't go through the chord matcher; the wrapper
 * brings the window forward and calls `window.totemDesktop.run(id)` instead.
 *
 * Each entry navigates first and then runs the command, because the view that
 * owns the command may not be mounted yet: `runCommand` parks it until it is.
 */
import type { NavTarget } from './router'
import { COMMANDS, runCommand } from './shortcuts'

export const DESKTOP_ACTIONS: Record<string, { nav: NavTarget; command: string }> = {
  'chat.new': { nav: { tab: 'chat' }, command: COMMANDS.chatNew },
  'todo.new': { nav: { tab: 'productivity', app: 'todos' }, command: COMMANDS.todoNew },
}

declare global {
  interface Window {
    totemDesktop?: { run: (id: string) => boolean }
  }
}

/** Expose `window.totemDesktop`; returns the uninstall. */
export function installDesktopHooks(navigate: (target: NavTarget) => void): () => void {
  const hooks = {
    run(id: string) {
      const action = DESKTOP_ACTIONS[id]
      if (!action) return false
      navigate(action.nav)
      runCommand(action.command)
      return true
    },
  }
  window.totemDesktop = hooks
  return () => {
    if (window.totemDesktop === hooks) delete window.totemDesktop
  }
}

/**
 * The desktop app's window has no native title bar (`desktop/src-tauri`): on
 * Windows the page draws the minimize / maximize / close buttons top right, and
 * on macOS the traffic lights float over the page's top left. The app says so
 * by setting `window.__TOTEM_DESKTOP__ = { chrome }` before the page runs; in a
 * browser it is unset and none of this does anything.
 *
 * Window commands go through Tauri's IPC, which the app grants this server's
 * origin for those few window calls only (`window_capability` in lib.rs).
 */
export type DesktopChrome = 'windows' | 'macos'

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/** The desktop app's updater (`desktop/src-tauri/src/update.rs`), as it last told the page. */
export type DesktopUpdate =
  | { state: 'idle' | 'checking' | 'upToDate' }
  | { state: 'downloading'; version: string; percent: number | null }
  | { state: 'ready'; version: string }
  | { state: 'failed'; message: string }

declare global {
  interface Window {
    __TOTEM_DESKTOP__?: { chrome?: string; version?: string; update?: DesktopUpdate; downloads?: boolean }
    __TAURI_INTERNALS__?: { invoke: Invoke }
  }
}

export function desktopChrome(): DesktopChrome | null {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return null
  const chrome = window.__TOTEM_DESKTOP__?.chrome
  return chrome === 'windows' || chrome === 'macos' ? chrome : null
}

type WindowCmd = 'minimize' | 'toggle_maximize' | 'close' | 'is_maximized' | 'start_dragging' | 'internal_toggle_maximize' | 'set_decorations' | 'set_title_bar_style'

export function windowCommand(cmd: WindowCmd, args?: Record<string, unknown>): Promise<unknown> {
  const invoke = window.__TAURI_INTERNALS__?.invoke
  return invoke ? invoke(`plugin:window|${cmd}`, args).catch(() => undefined) : Promise.resolve(undefined)
}

/**
 * Where a press moves the window: the tops of the rail, the chats panel and each
 * page, the strip the page leaves above itself on Windows and the title strip
 * above everything on macOS. Anything you can click inside them (buttons,
 * links, fields) still clicks.
 */
const DRAG_REGIONS = '.sh-rail, .sh-panel-head, .sh-mbar, .vc-top, .vc-art-head, .app.shell > .main, .app.shell, .auth-shell'
const INTERACTIVE = 'button, a, input, select, textarea, label, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])'

/** The element a press lands on moves the window when it is a drag region itself or plain content inside one. */
function dragsWindow(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest(INTERACTIVE)) return false
  const region = target.closest(DRAG_REGIONS)
  if (!region) return false
  // The page, the shell and the sign-in screen are handles only where nothing
  // covers them: the strip above a page's content (Windows), the title strip
  // (macOS), the space around the sign-in card.
  if (region.matches('.app.shell > .main, .app.shell, .auth-shell')) return target === region
  return true
}

/**
 * Marks the document (`html[data-desktop]`, which the CSS and the app's
 * fallback both read), keeps `html.wc-maximized` in step with the window, and
 * moves the window when a drag region is pressed. Call once, before rendering.
 */
export function installWindowChrome(): void {
  const chrome = desktopChrome()
  if (!chrome) return
  const root = document.documentElement
  root.dataset.desktop = chrome
  // Take the title bar away ourselves. The app gives it back when a page
  // doesn't draw its own buttons (an older dashboard, during a deploy), and a
  // reload into this one keeps the window as it was: two sets of buttons.
  void (chrome === 'windows'
    ? windowCommand('set_decorations', { value: false })
    : windowCommand('set_title_bar_style', { value: 'overlay' }))

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !dragsWindow(e.target)) return
    if (chrome === 'macos' && e.detail === 2) return // macOS zooms on mouseup, below
    e.preventDefault()
    void windowCommand(e.detail === 2 ? 'internal_toggle_maximize' : 'start_dragging')
  })
  if (chrome === 'macos') {
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0 && e.detail === 2 && dragsWindow(e.target)) void windowCommand('internal_toggle_maximize')
    })
  }

  const syncMaximized = () => {
    void windowCommand('is_maximized').then((max) => root.classList.toggle('wc-maximized', max === true))
    // A full-screen Mac window has no traffic lights, so it needs no title strip.
    // The window then covers the whole screen, menu bar included, which a zoomed one never does.
    if (chrome === 'macos') root.classList.toggle('wc-fullscreen', window.outerHeight >= screen.height && window.outerWidth >= screen.width)
  }
  syncMaximized()
  window.addEventListener('resize', syncMaximized)
}

/** The desktop app's own version, or null in a browser. */
export function desktopVersion(): string | null {
  return (typeof window !== 'undefined' && window.__TOTEM_DESKTOP__?.version) || null
}

/** The updater's state now; null in a browser or an app too old to have one. */
export function desktopUpdate(): DesktopUpdate | null {
  return (typeof window !== 'undefined' && window.__TOTEM_DESKTOP__?.update) || null
}

/** Calls `fn` whenever the app reports a new updater state; returns the unsubscribe. */
export function onDesktopUpdate(fn: () => void): () => void {
  window.addEventListener('totem-desktop-update', fn)
  return () => window.removeEventListener('totem-desktop-update', fn)
}

/**
 * Restarts into the downloaded update (or checks, with `check`). A navigation
 * the app cancels and acts on, like its external links, so no IPC is involved.
 */
export function requestDesktopUpdate(what: 'install' | 'check' = 'install'): void {
  window.location.href = `totem-desktop://update/${what}`
}

/** The navigation that asks the desktop app to show a saved download (`reveal_download` in lib.rs), by the URL it knows it by; the page never sees a path. */
export const desktopRevealUrl = (download: string) => `totem-desktop://reveal?u=${encodeURIComponent(download)}`

export function revealDesktopDownload(download: string): void {
  window.location.href = desktopRevealUrl(download)
}

/** "Show in Finder" on a Mac, as the file manager is called there. */
export const desktopRevealLabel = () => /Mac/i.test(navigator.platform || navigator.userAgent) ? 'Show in Finder' : 'Show in folder'
