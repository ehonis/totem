import { useEffect, useRef, useSyncExternalStore } from 'react'
import { desktopUpdate, desktopVersion, onDesktopUpdate, requestDesktopUpdate } from '../desktop'
import { pushToast } from '../toast'
import { TI } from '../chat/ui'
import { IconCircleArrowDown, IconRefresh } from '../chat/icons'

function useDesktopUpdate() {
  return useSyncExternalStore(onDesktopUpdate, desktopUpdate, () => null)
}

/**
 * The desktop app's "Restart to update", T3 Code style: the app downloads a new
 * version on its own, then this button appears at the foot of the rail, and a
 * toast says so once. Nothing shows while there's nothing to do, or in a browser.
 */
export default function DesktopUpdate() {
  const update = useDesktopUpdate()
  const told = useRef<string | null>(null)
  const ready = update?.state === 'ready' ? update.version : null

  useEffect(() => {
    if (!ready || told.current === ready) return
    told.current = ready
    pushToast(`Totem ${ready} is ready to install.`, 'info', {
      duration: 0,
      action: { label: 'Restart', icon: IconRefresh, onClick: () => requestDesktopUpdate('install') },
    })
  }, [ready])

  if (!update || (update.state !== 'ready' && update.state !== 'downloading')) return null
  const current = desktopVersion()
  const label = update.state === 'ready'
    ? `Restart to update to ${update.version}`
    : `Downloading ${update.version}${update.percent != null ? ` (${update.percent}%)` : ''}`
  const title = current ? `${label}. You have ${current}.` : label
  return (
    <button
      type="button"
      className={`sh-rail-btn sh-update ${update.state}`}
      onClick={() => { if (update.state === 'ready') requestDesktopUpdate('install') }}
      disabled={update.state !== 'ready'}
      title={title}
      aria-label={label}
    >
      <TI icon={IconCircleArrowDown} size={21} />
      <span className="sh-tip">{label}</span>
    </button>
  )
}
