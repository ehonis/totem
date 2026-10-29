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
