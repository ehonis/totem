// Word-by-word streaming, the way ChatGPT's reply reads.
//
// The CLIs deliver text in uneven bursts — nothing for a second, then forty
// words. Rendering those as they land looks like stutter. This releases the
// text a few words per frame at a pace that adapts to the backlog: steady when
// the model is trickling, faster when it has run ahead, so the visible reply is
// never more than about half a second behind. When the stream ends it catches up
// at once.
import { useEffect, useRef, useState } from 'react'

const MIN_WPS = 28   // words per second when keeping pace
const CATCH_UP_S = 0.45 // aim to clear any backlog within this long

export function useSmoothText(target: string, live: boolean): string {
  const [shown, setShown] = useState(live ? '' : target)
  const shownRef = useRef(shown)
  const targetRef = useRef(target)
  const raf = useRef(0)
  const last = useRef(0)
  const credit = useRef(0)
  targetRef.current = target

  useEffect(() => {
    if (!live) {
      cancelAnimationFrame(raf.current)
      shownRef.current = target
      setShown(target)
      return
    }
    const tick = (t: number) => {
      const dt = last.current ? Math.min(0.1, (t - last.current) / 1000) : 0.016
      last.current = t
      const full = targetRef.current
      let cur = shownRef.current
      // A rewrite (rare: a provider replaced its text) restarts from the common prefix.
      if (!full.startsWith(cur)) cur = full.slice(0, commonPrefix(cur, full))
      const rest = full.slice(cur.length)
      if (rest) {
        const backlog = (rest.match(/\S+\s*/g) || []).length
        const wps = Math.max(MIN_WPS, backlog / CATCH_UP_S)
        credit.current += wps * dt
        let n = Math.floor(credit.current)
        if (n > 0) {
          credit.current -= n
          let i = 0
          const re = /\S+\s*|\s+/g
          let m: RegExpExecArray | null
          while (n > 0 && (m = re.exec(rest))) { i = re.lastIndex; n-- }
          cur += rest.slice(0, i || rest.length)
          shownRef.current = cur
          setShown(cur)
        }
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf.current); last.current = 0 }
  }, [live]) // eslint-disable-line react-hooks/exhaustive-deps

  // Finished: show everything immediately.
  useEffect(() => { if (!live) { shownRef.current = target; setShown(target) } }, [target, live])
  return shown
}

function commonPrefix(a: string, b: string) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}
