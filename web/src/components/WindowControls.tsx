import { useEffect, useState } from 'react'
import { desktopChrome, windowCommand } from '../desktop'
import { TI } from '../chat/ui'
import { IconMinus, IconSquare, IconSquares, IconX } from '../chat/icons'

/**
 * Minimize, maximize and close for the Windows desktop app, whose window has no
 * title bar of its own. They sit in the page's top-right corner with nothing
 * behind them, so the page runs right up to the window's edge (desktop.ts). On
 * macOS the system's traffic lights do this, and in a browser nothing renders.
 */
export default function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  const show = desktopChrome() === 'windows'

  useEffect(() => {
    if (!show) return
    const root = document.documentElement
    const sync = () => setMaximized(root.classList.contains('wc-maximized'))
    sync()
    const watch = new MutationObserver(sync)
    watch.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => watch.disconnect()
  }, [show])

  if (!show) return null
  return (
    <div className="wc" role="group" aria-label="Window">
      <button type="button" className="wc-btn" onClick={() => void windowCommand('minimize')} aria-label="Minimize" title="Minimize">
        <TI icon={IconMinus} size={16} stroke={1.25} />
      </button>
      <button type="button" className="wc-btn" onClick={() => void windowCommand('toggle_maximize')} aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore down' : 'Maximize'}>
        <TI icon={maximized ? IconSquares : IconSquare} size={maximized ? 15 : 14} stroke={1.25} />
      </button>
      <button type="button" className="wc-btn wc-close" onClick={() => void windowCommand('close')} aria-label="Close" title="Close">
        <TI icon={IconX} size={17} stroke={1.25} />
      </button>
    </div>
  )
}
