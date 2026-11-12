import { useEffect, useRef } from 'react'

// Escape beside the chat's side panels. A side panel (Files, Agents, Browser, the
// canvas) closes on an Escape pressed anywhere, so anything that opens over or
// beside it (the header's "…", the totem picker, the usage panel, the Lightbox, a
// message being edited, any popover using useDismiss) keeps the Escape it handles:
// it calls preventDefault, and the panel only closes on an Escape nobody has handled.

/** While `open`, close the side panel on an Escape nothing else has handled. */
export function usePanelEscape(open: boolean, close: () => void) {
  const latest = useRef(close)
  latest.current = close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) latest.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
}
