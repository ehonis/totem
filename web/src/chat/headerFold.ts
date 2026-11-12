import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

// How the chat header makes room as the chat column narrows. A side panel can
// leave the column any width, and what is in the header varies (breadcrumbs, a
// project's switch, a group chat's avatars, up to three panel chips, one to three
// usage pills, Keep), so no fixed width can say when to fold. The header measures
// instead: it gives things up in this order, one step at a time, until the title
// keeps its floor and nothing runs past the header's edge.
//
// Each step is a word in `data-fold` on .vc-top (chat.css has one rule set per
// word). The attribute is set here, never by React, so a re-render cannot wipe it.
// The menu steps move controls into "…" (chat/HeaderPanels.tsx): every control in
// the header stays reachable at any width, down to the ~180px a column can reach
// beside three side panels.
export const FOLD_STEPS = [
  'host', // the browser chip drops its host
  'labels', // chips keep their icon and count
  'crumbs', // breadcrumbs keep their icons (a project's home keeps its name), avatars become a count, the hover-only retitle button goes
  'pills', // the usage pills fold into the tightest provider, "+N" for the rest
  'menu', // into "…": the panel chips, the add-totems button, the project switch, a totem's run and settings, Keep, Temporary, and the parent-project and Totems crumbs
  'plus', // the folded pill drops its "+N"
  'tight', // smaller padding and gaps
  'start', // into "…": Show chats and New chat (the chats panel is hidden)
  'usage', // into "…": the usage pill
  'project', // into "…": the project's crumb, leaving the chat's own icon and title
] as const
export type FoldStep = (typeof FOLD_STEPS)[number]

/**
 * How much of the title must show before anything else may stay: all of it, up to
 * 55% of the header and at most 300px. The title is what the header is for, so
 * chips, pills and buttons fold before it is cut to a stub ("New chat" stays whole
 * at 180px). It must rise smoothly with the width: a floor that jumps lets a header
 * unfold as it narrows, and flicker while a side panel is dragged.
 */
export const titleFloor = (natural: number, header: number) => Math.min(natural, header * 0.55, 300)

/** The steps taken at `level` (0 = nothing folded). */
export const foldWords = (level: number) => FOLD_STEPS.slice(0, Math.max(0, Math.min(level, FOLD_STEPS.length))).join(' ')

/** The title, or on a project's home (no title yet) the project's name. */
function titleOf(top: HTMLElement): HTMLElement | null {
  return top.querySelector<HTMLElement>('.vc-top-title') || top.querySelector<HTMLElement>('.vc-top-crumb.last .vc-top-project > span')
}

/** Everything fits: the right side ends inside the header and the title keeps its floor. */
export function headerFits(top: HTMLElement): boolean {
  const cs = getComputedStyle(top)
  const box = top.getBoundingClientRect()
  const left = box.left + parseFloat(cs.paddingLeft)
  const right = box.right - parseFloat(cs.paddingRight)
  const side = top.querySelector<HTMLElement>('.vc-top-right')
  if (side && side.getBoundingClientRect().right > right + 0.5) return false
  const title = titleOf(top)
  if (!title) return true
  return title.clientWidth + 0.5 >= titleFloor(title.scrollWidth, right - left)
}

/**
 * Folds the header to fit, starting from where it is (`from`): with room to spare
 * it gives steps back while it still fits, and when it does not fit it takes more,
 * so a frame of a drag costs a measurement or two, not one per step. Each step only
 * frees room, so this lands where a search from nothing would. Returns the level.
 */
export function refold(top: HTMLElement, from = 0): number {
  const set = (level: number) => { const words = foldWords(level); if (top.dataset.fold !== words) top.dataset.fold = words }
  let level = Math.max(0, Math.min(from, FOLD_STEPS.length))
  set(level)
  if (headerFits(top)) {
    while (level > 0) {
      set(level - 1)
      if (!headerFits(top)) { set(level); break }
      level--
    }
    return level
  }
  while (level < FOLD_STEPS.length) {
    set(++level)
    if (headerFits(top)) break
  }
  return level
}

/**
 * Keeps `ref`'s header folded to fit, and returns how far it is folded: before the
 * first paint, when its width changes (the window, the chats panel, a side panel
 * being dragged), when what is in it changes (a chip appears, the title is
 * rewritten), and when fonts load.
 */
export function useHeaderFold(ref: RefObject<HTMLElement>): number {
  const [level, setLevel] = useState(0)
  const current = useRef(0)
  useLayoutEffect(() => {
    const top = ref.current
    if (!top) return
    const run = () => {
      current.current = refold(top, current.current)
      setLevel(current.current)
    }
    run()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(run) : null
    ro?.observe(top)
    // Only what React renders: data-fold is an attribute, so folding never re-triggers this.
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(run) : null
    mo?.observe(top, { childList: true, subtree: true, characterData: true })
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    fonts?.addEventListener?.('loadingdone', run)
    let live = true
    fonts?.ready.then(() => { if (live) run() }, () => {})
    return () => { live = false; ro?.disconnect(); mo?.disconnect(); fonts?.removeEventListener?.('loadingdone', run) }
  }, [ref])
  return level
}
