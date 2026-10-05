import React from 'react'
import { useToasts, dismissToast } from '../toast'
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

// Renders the live toast stack in the bottom-left. Mounted once at the app root,
// it subscribes to the global toast store so any view's errors land here.
export default function ToastHost() {
  const toasts = useToasts()
  if (!toasts.length) return null
  // On phones the nav lives in a bottom bar, so toasts clear it and span the full
  // width - an "Undo" tucked under the nav bar is unhittable.
  return (
    <div
      className="fixed left-[18px] bottom-[18px] z-[1000] flex flex-col-reverse gap-2.5 max-w-[min(420px,calc(100vw-36px))] pointer-events-none max-[720px]:left-3 max-[720px]:right-3 max-[720px]:max-w-none max-[720px]:bottom-[calc(74px+env(safe-area-inset-bottom))]"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2.5 pt-[11px] pr-3 pb-[11px] pl-[13px] ${FILL[t.kind] || FILL.error} rounded-[10px] shadow-[0_8px_28px_rgba(0,0,0,0.45)] text-white text-[13px] leading-[1.45] animate-toast-in`}
          role="alert"
        >
          <span className="flex-none mt-px">
            <Hi icon={ICONS[t.kind] || ICONS.error} size={16} />
          </span>
          <span className="flex-1 min-w-0 [overflow-wrap:anywhere]">{t.text}</span>
          {t.action && (
            <button
              className="flex-none inline-flex items-center gap-1 self-center px-2.5 py-1.5 min-h-[32px] bg-white/15 border-0 rounded-lg text-white text-[12px] font-semibold cursor-pointer hover:bg-white/25"
              onClick={() => { const run = t.action!.onClick; dismissToast(t.id); run() }}
            >
              <Hi icon={ArrowUturnLeftIcon} size={13} /> {t.action.label}
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
      ))}
    </div>
  )
}
