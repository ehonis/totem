import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'

// The cards pinned at a chat's top right (T3 Code's thread card): the folder's
// card on its page (ProjectCard) and the chat's task (work/TaskCard). ChatView
// stacks them in one column, `.vc-pins`; each folds to its title row on its own.

export const PHONE = '(max-width: 720px)'
/** Below this chat column width a pinned card starts folded, until the owner unfolds it. */
export const PIN_ROOM = 1000

/** Phone width: nothing is pinned there; the task opens as a sheet and the folder's card sits in the page. */
export function usePhone() {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.(PHONE).matches))
  useEffect(() => {
    const media = window.matchMedia?.(PHONE)
    if (!media) return
    const update = () => setPhone(media.matches)
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return phone
}

function readFold(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key)
    return v === '1' ? true : v === '0' ? false : null
  } catch { return null }
}

/**
 * Whether a pinned card is folded. The owner's own choice is kept on this device
 * under `key`; with none, it folds while the chat column (the `.vc` around `ref`)
 * is under PIN_ROOM. `reveal()` unfolds it for now without changing that choice.
 */
export function usePinFold(key: string, ref: RefObject<HTMLElement>) {
  const [pref, setPref] = useState<boolean | null>(() => readFold(key))
  const [revealed, setRevealed] = useState(false)
  const [narrow, setNarrow] = useState(false)

  useLayoutEffect(() => {
    const column = ref.current?.closest<HTMLElement>('.vc')
    if (!column) return
    const measure = () => setNarrow(column.clientWidth < PIN_ROOM)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(column)
    return () => ro.disconnect()
  }, [ref])

  const folded = !revealed && (pref ?? narrow)
  const setFolded = (next: boolean) => {
    setRevealed(false)
    setPref(next)
    try { localStorage.setItem(key, next ? '1' : '0') } catch { /* private window: this visit only */ }
  }
  return { folded, setFolded, reveal: () => setRevealed(true) }
}
