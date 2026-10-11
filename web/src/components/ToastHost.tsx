import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useToasts, dismissToast, holdToasts, type Toast } from '../toast'
import { Hi, XMarkIcon, ArrowUturnLeftIcon, ExclamationTriangleIcon, CheckCircleIcon, InformationCircleIcon } from '../icons'

// Glyph per toast kind; errors default.
const ICONS: Record<string, any> = { error: ExclamationTriangleIcon, success: CheckCircleIcon, info: InformationCircleIcon }

// The whole toast is one colour that says what kind it is, with white text on
// top. Deeper shades of the theme's red, green and accent: white on these is
// about 5.4:1, where the theme's own shades fall under 3.5:1. Errors default.
const FILL: Record<string, string> = {
  error: 'bg-[#c42d4c]',
  success: 'bg-[#1f7a34]',
  info: 'bg-[#3463d6]',
}

// T3 Code's deck: the newest toast in front, up to two more peeking out behind
// it, smaller, cut to the front one's height. Hovering (or tapping, on a phone)
// spreads them into a column and holds every timer until the pointer leaves.
const SHOWN = 3
const PEEK = 10   // px each toast behind shows above the one in front
const SHRINK = 0.06
const GAP = 8

function Item({ t, index, open, offset, frontHeight, onHeight, top }: {
  t: Toast
  /** Anchored to the top of the screen (phones): the deck grows downward. */
  top: boolean
  index: number
  open: boolean
  offset: number
  frontHeight: number
  onHeight: (id: number, h: number) => void
}) {
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const measure = () => onHeight(t.id, el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [t.id, onHeight])
  const behind = index > 0 && !open
  const dir = top ? 1 : -1
  const transform = open
    ? `translateY(${dir * offset}px)`
    : `translateY(${dir * index * PEEK}px) scale(${1 - index * SHRINK})`
  return (
    <div
      className={`group absolute left-0 right-0 ${top ? 'top-0 origin-top' : 'bottom-0 origin-bottom'} overflow-hidden pointer-events-auto ${FILL[t.kind] || FILL.error} rounded-[10px] shadow-[0_8px_28px_rgba(0,0,0,0.45)] text-white text-[13px] leading-[1.45] transition-[transform,height,opacity] duration-500 ease-[cubic-bezier(.22,1,.36,1)] animate-toast-in`}
      style={{ transform, zIndex: SHOWN - index, height: behind ? frontHeight : undefined }}
      role="alert"
    >
      {/* Time left on screen, flush with the top edge; holds while the deck is open. */}
      {t.duration > 0 && (
        <span
          key={`${t.id}-${t.count}`}
          aria-hidden
          className="absolute top-0 left-0 right-0 h-[3px] bg-white/60 origin-left"
          style={{ animation: `toast-timer ${t.duration}ms linear forwards`, animationPlayState: open ? 'paused' : 'running' }}
        />
      )}
      <div ref={body} className={`flex items-start gap-2.5 pt-[13px] pr-3 pb-[11px] pl-[13px] transition-opacity duration-200 ${behind ? 'opacity-0' : 'opacity-100'}`}>
        <span className="flex-none mt-px">
          <Hi icon={ICONS[t.kind] || ICONS.error} size={16} />
        </span>
        <span className="flex-1 min-w-0 [overflow-wrap:anywhere]">
          {t.text}
          {t.count > 1 && <span className="ml-1.5 inline-block px-1.5 rounded-full bg-white/20 text-[11px] font-semibold align-[1px]">×{t.count}</span>}
        </span>
        {t.action && (
          <button
            className="flex-none inline-flex items-center gap-1 self-center px-2.5 py-1.5 min-h-[32px] bg-white/15 border-0 rounded-lg text-white text-[12px] font-semibold cursor-pointer hover:bg-white/25"
            onClick={() => { const run = t.action!.onClick; dismissToast(t.id); run() }}
          >
            {t.action.icon !== null && <Hi icon={t.action.icon || ArrowUturnLeftIcon} size={13} />} {t.action.label}
          </button>
        )}
        <button
          className="flex-none bg-transparent border-0 text-white/75 p-0.5 -mt-0.5 -mr-0.5 rounded-md leading-[0] hover:text-white hover:bg-white/15"
          onClick={() => dismissToast(t.id)}
          aria-label="Dismiss notification"
        >
          <Hi icon={XMarkIcon} size={14} />
        </button>
      </div>
    </div>
  )
}

const PHONE = '(max-width: 720px)'

// Mounted once at the app root; any view's pushToast lands here: bottom-left on
// a desktop, clear of the composer; under the top bar on a phone, where the
// composer fills the bottom.
export default function ToastHost() {
  const toasts = useToasts()
  const [top, setTop] = useState(() => window.matchMedia(PHONE).matches)
  useEffect(() => {
    const mq = window.matchMedia(PHONE)
    const on = () => setTop(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const [open, setOpen] = useState(false)
  const [heights, setHeights] = useState<Record<number, number>>({})
  const onHeight = useCallback((id: number, h: number) => {
    setHeights((m) => (m[id] === h ? m : { ...m, [id]: h }))
  }, [])
  const shown = toasts.slice(-SHOWN).reverse() // front first
  // One toast left: nothing to spread.
  useEffect(() => { if (shown.length < 2 && open) { setOpen(false); holdToasts(false) } }, [shown.length, open])
  if (!shown.length) return null

  const hOf = (t: Toast) => heights[t.id] || 48
  const frontHeight = hOf(shown[0])
  const offsets: number[] = []
  shown.reduce((y, t) => { offsets.push(y); return y + hOf(t) + GAP }, 0)
  const height = open
    ? offsets[shown.length - 1] + hOf(shown[shown.length - 1])
    : frontHeight + (shown.length - 1) * PEEK
  const spread = (on: boolean) => { if (shown.length > 1 || !on) { setOpen(on); holdToasts(on) } }

  return (
    <div
      className="fixed left-[18px] bottom-[18px] z-[1000] w-[min(380px,calc(100vw-36px))] max-[720px]:left-3 max-[720px]:right-3 max-[720px]:w-auto max-[720px]:bottom-auto max-[720px]:top-[calc(58px+env(safe-area-inset-top))] transition-[height] duration-500 ease-[cubic-bezier(.22,1,.36,1)]"
      style={{ height }}
      role="region"
      aria-label="Notifications"
      onMouseEnter={() => spread(true)}
      onMouseLeave={() => spread(false)}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) spread(!open) }}
    >
      {shown.map((t, i) => (
        <Item key={t.id} t={t} top={top} index={i} open={open} offset={offsets[i]} frontHeight={frontHeight} onHeight={onHeight} />
      ))}
    </div>
  )
}
