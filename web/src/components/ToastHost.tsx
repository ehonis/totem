import React from 'react'
import { useToasts, dismissToast } from '../toast'
import { Hi, XMarkIcon, ArrowUturnLeftIcon, ExclamationTriangleIcon, CheckCircleIcon, InformationCircleIcon } from '../icons'

// Glyph per toast kind; errors default.
const ICONS: Record<string, any> = { error: ExclamationTriangleIcon, success: CheckCircleIcon, info: InformationCircleIcon }

// Left accent border + icon tint per kind; falls back to the error/red treatment.
const ACCENT: Record<string, string> = {
  error: 'border-l-red',
  success: 'border-l-green',
  info: 'border-l-accent',
}
const ICON_TINT: Record<string, string> = {
  error: 'text-red',
  success: 'text-green',
  info: 'text-accent',
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
          className={`pointer-events-auto flex items-start gap-2.5 pt-[11px] pr-3 pb-[11px] pl-[13px] bg-bg-3 border border-solid border-line border-l-[3px] ${ACCENT[t.kind] || ACCENT.error} rounded-[10px] shadow-[0_8px_28px_rgba(0,0,0,0.45)] text-text text-[13px] leading-[1.45] animate-toast-in`}
          role="alert"
        >
          <span className={`flex-none mt-px ${ICON_TINT[t.kind] || ICON_TINT.error}`}>
            <Hi icon={ICONS[t.kind] || ICONS.error} size={16} />
          </span>
          <span className="flex-1 min-w-0 [overflow-wrap:anywhere]">{t.text}</span>
          {t.action && (
            <button
              className="flex-none inline-flex items-center gap-1 self-center px-2.5 py-1.5 min-h-[32px] bg-bg-2 border border-solid border-line rounded-lg text-text text-[12px] font-semibold cursor-pointer hover:border-accent hover:text-accent"
              onClick={() => { const run = t.action!.onClick; dismissToast(t.id); run() }}
            >
              <Hi icon={ArrowUturnLeftIcon} size={13} /> {t.action.label}
            </button>
          )}
          <button
            className="flex-none bg-transparent border-0 text-muted p-0.5 -mt-0.5 -mr-0.5 rounded-md leading-[0] hover:text-text hover:bg-bg-2"
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
