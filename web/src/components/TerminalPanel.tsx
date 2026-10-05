/**
 * The terminal side panel.
 *
 * A right-docked, width-resizable panel with one tab per shell — the same shape as
 * t3code's right panel, which hosts terminals as tabbed surfaces. It is mounted at
 * the app root rather than inside a view, so the toggle works from anywhere and
 * switching tabs in the sidebar never disturbs a running shell.
 *
 * Two things carry the "it survives" property:
 *   - The PTY lives on the bridge, not in this component. Closing the panel detaches;
 *     it does not kill. Reopening replays the scrollback and you are back where you were.
 *   - Every pane stays mounted while the panel is open and is hidden with CSS when its
 *     tab is inactive, so switching tabs keeps xterm's viewport and scroll position.
 *
 * Layout note: the panel is a real grid column on `.app`, not an overlay, so opening
 * it narrows the view rather than covering it.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {
  terminalClient,
  type ConnectionState,
  type ServerMessage,
  type TerminalSessionInfo,
} from '../terminal/client'
import { Hi, CommandLineIcon, PlusIcon, XMarkIcon, TrashIcon } from '../icons'

const WIDTH_STORAGE_KEY = 'totem.terminal.width'
const MIN_WIDTH = 340
const MAX_WIDTH_RATIO = 0.7

// Matches the dashboard's palette (see styles.css :root) so the terminal reads as
// part of the app rather than a pasted-in black box.
const XTERM_THEME = {
  background: '#0b0d12',
  foreground: '#e6e8ee',
  cursor: '#5b8cff',
  cursorAccent: '#0b0d12',
  selectionBackground: '#5b8cff44',
  black: '#161922',
  red: '#f0506e',
  green: '#22c55e',
  yellow: '#f59e0b',
  blue: '#5b8cff',
  magenta: '#7c5cff',
  cyan: '#38bdf8',
  white: '#e6e8ee',
  brightBlack: '#8a91a3',
  brightRed: '#ff7591',
  brightGreen: '#4ade80',
  brightYellow: '#fbbf24',
  brightBlue: '#7ca5ff',
  brightMagenta: '#a78bfa',
  brightCyan: '#67d3fb',
  brightWhite: '#ffffff',
}

function clampWidth(width: number): number {
  const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_WIDTH_RATIO))
  return Math.min(Math.max(Math.round(width), MIN_WIDTH), max)
}

function readStoredWidth(): number {
  const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY))
  return clampWidth(Number.isFinite(stored) && stored > 0 ? stored : 520)
}

/** Short, stable label for a tab. */
function tabLabel(session: TerminalSessionInfo, index: number): string {
  if (session.exited) return `exited ${index + 1}`
  const command = session.lastCommand?.trim()
  if (command) return command.length > 18 ? `${command.slice(0, 17)}…` : command
  return `shell ${index + 1}`
}

interface PaneProps {
  session: TerminalSessionInfo
  active: boolean
  /** Bumped by the parent to ask this pane to refit (panel resized or reopened). */
  fitToken: number
  onTitleData: (id: string) => void
}

/**
 * One xterm instance bound to one server session.
 *
 * Deliberately subscribes to the client directly instead of taking data through
 * props: output arrives far too often to route through React state without
 * re-rendering the whole panel on every chunk.
 */
function TerminalPane({ session, active, fitToken, onTitleData }: PaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const { id } = session

  // Set up xterm once per session id. Runs before paint so the first fit measures
  // a laid-out container.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: XTERM_THEME,
      // The bridge keeps its own scrollback for replay; letting xterm convert
      // pasted CRLF keeps multi-line pastes from double-submitting.
      convertEol: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    try {
      fit.fit()
    } catch {
      // Container not measurable yet; the fitToken effect below will retry.
    }

    term.onData((data) => terminalClient.sendInput(id, data))
    term.onResize(({ cols, rows }) => terminalClient.send({ t: 'resize', id, cols, rows }))

    const unsubscribe = terminalClient.onMessage((message: ServerMessage) => {
      // `attached` identifies its session through the session object; everything
      // else carries a top-level id. Getting this wrong silently costs the replay.
      const messageId = message.t === 'attached' ? message.session.id : 'id' in message ? message.id : null
      if (messageId !== id) return

      if (message.t === 'data') {
        term.write(message.data)
        onTitleData(id)
      } else if (message.t === 'attached') {
        // ESC c (full reset) before replay, so a reattach redraws from a clean
        // screen instead of stacking on whatever was already there.
        term.write('\u001bc')
        if (message.replay) term.write(message.replay)
        if (message.truncated) {
          term.write('\r\n\u001b[2m[earlier output trimmed]\u001b[0m\r\n')
        }
      } else if (message.t === 'exit') {
        const code = message.exitCode
        term.write(`\r\n\u001b[2m[process exited${code === null ? '' : ` with code ${code}`}]\u001b[0m\r\n`)
      } else if (message.t === 'error') {
        term.write(`\r\n\u001b[31m[terminal] ${message.message}\u001b[0m\r\n`)
      }
    })

    // `attached` also arrives for a session opened by this client, so the pane is
    // filled the same way whether it is new or reattached after a reload.
    terminalClient.send({ t: 'attach', id, cols: term.cols, rows: term.rows })

    return () => {
      unsubscribe()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [id, onTitleData])

  // Refit whenever the pane becomes visible or the panel changes size. A hidden
  // pane has no measurable box, so fitting it would compute nonsense dimensions.
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return

    const refit = () => {
      try {
        fit.fit()
      } catch {
        // Mid-layout; the ResizeObserver below fires again once it settles.
      }
    }
    const frame = requestAnimationFrame(() => {
      refit()
      term.focus()
    })

    const host = hostRef.current
    const observer = host ? new ResizeObserver(refit) : null
    if (host && observer) observer.observe(host)
    window.addEventListener('resize', refit)

    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', refit)
    }
  }, [active, fitToken])

  return <div ref={hostRef} className={`term-pane${active ? ' active' : ''}`} />
}

interface TerminalPanelProps {
  open: boolean
  onClose: () => void
}

export default function TerminalPanel({ open, onClose }: TerminalPanelProps) {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('idle')
  const [detail, setDetail] = useState('')
  const [maxSessions, setMaxSessions] = useState(8)
  const [width, setWidth] = useState(readStoredWidth)
  const [fitToken, setFitToken] = useState(0)
  const [error, setError] = useState('')

  // Whether we have already reconciled with the server's session list. Without
  // this, the reconnect that follows a dropped tunnel would open a second shell.
  const adoptedRef = useRef(false)

  // Connect while the panel is open and leave the shells running when it closes.
  useEffect(() => {
    if (!open) return
    adoptedRef.current = false
    terminalClient.connect()
    return () => {
      terminalClient.disconnect()
    }
  }, [open])

  useEffect(() => {
    const unsubscribe = terminalClient.onStateChange((state, stateDetail) => {
      setConnection(state)
      setDetail(stateDetail)
    })
    const current = terminalClient.getState()
    setConnection(current.state)
    setDetail(current.detail)
    return unsubscribe
  }, [])

  useEffect(() => {
    return terminalClient.onMessage((message: ServerMessage) => {
      switch (message.t) {
        case 'ready': {
          setMaxSessions(message.maxSessions)
          setSessions(message.sessions)
          // Adopt whatever is already running (a reload, or a second browser), and
          // only open a shell when the box genuinely has none.
          if (!adoptedRef.current) {
            adoptedRef.current = true
            const live = message.sessions.filter((s) => !s.exited)
            if (live.length === 0) terminalClient.send({ t: 'open', cols: 80, rows: 24 })
            else setActiveId((prev) => (prev && live.some((s) => s.id === prev) ? prev : live[0].id))
          }
          return
        }
        case 'sessions':
          return setSessions(message.sessions)
        case 'opened':
          setError('')
          setSessions((prev) => (prev.some((s) => s.id === message.session.id) ? prev : [...prev, message.session]))
          return setActiveId(message.session.id)
        case 'attached':
          return setSessions((prev) =>
            prev.some((s) => s.id === message.session.id)
              ? prev.map((s) => (s.id === message.session.id ? message.session : s))
              : [...prev, message.session],
          )
        case 'exit':
          return setSessions((prev) =>
            prev.map((s) => (s.id === message.id ? { ...s, exited: true, exitCode: message.exitCode } : s)),
          )
        case 'closed':
          return setSessions((prev) => prev.filter((s) => s.id !== message.id))
        case 'error':
          return setError(message.message)
        default:
          return
      }
    })
  }, [])

  // Keep a valid tab selected as sessions come and go.
  useEffect(() => {
    if (sessions.length === 0) {
      if (activeId !== null) setActiveId(null)
      return
    }
    if (!activeId || !sessions.some((s) => s.id === activeId)) setActiveId(sessions[0].id)
  }, [sessions, activeId])

  const openTerminal = useCallback(() => {
    setError('')
    terminalClient.send({ t: 'open', cols: 80, rows: 24 })
  }, [])

  const closeTerminal = useCallback((id: string) => {
    terminalClient.send({ t: 'close', id })
    setSessions((prev) => prev.filter((s) => s.id !== id))
  }, [])

  // A tab label tracks the last command, which the bridge reports on the session
  // rather than in the data stream — refresh the list when output settles.
  const refreshTimer = useRef<number | null>(null)
  const onTitleData = useCallback(() => {
    if (refreshTimer.current !== null) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      terminalClient.send({ t: 'list' })
    }, 1500)
  }, [])
  useEffect(() => () => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
  }, [])

  // --- width drag ---
  const draggingRef = useRef(false)
  const startDrag = useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    draggingRef.current = true
    const onMove = (moveEvent: PointerEvent) => {
      if (!draggingRef.current) return
      // The panel is docked right, so width grows as the pointer moves left.
      setWidth(clampWidth(window.innerWidth - moveEvent.clientX))
    }
    const onUp = () => {
      draggingRef.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('term-resizing')
      setFitToken((n) => n + 1)
    }
    document.body.classList.add('term-resizing')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  useEffect(() => {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(width))
    setFitToken((n) => n + 1)
    // Published so the app's fixed-position affordances (the quick-chat pill and
    // panel) can shift clear of the dock instead of sitting on top of it.
    document.documentElement.style.setProperty('--term-width', `${width}px`)
  }, [width])

  useEffect(() => () => {
    document.documentElement.style.removeProperty('--term-width')
  }, [])

  if (!open) return null

  const liveCount = sessions.filter((s) => !s.exited).length
  const commandTotal = sessions.reduce((sum, s) => sum + s.commandCount, 0)
  const atCap = liveCount >= maxSessions

  return (
    // Keystrokes inside the terminal belong to the shell, never to the leader key.
    <aside className="term-panel" style={{ width }} data-shortcuts-off>
      <div
        className="term-resize-handle"
        onPointerDown={startDrag}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize terminal panel"
      />

      <div className="term-tabs">
        <div className="term-tabs-scroll">
          {sessions.map((session, index) => (
            <button
              key={session.id}
              type="button"
              className={`term-tab${session.id === activeId ? ' active' : ''}${session.exited ? ' exited' : ''}`}
              onClick={() => {
                setActiveId(session.id)
                setFitToken((n) => n + 1)
              }}
              title={session.exited ? `Exited (code ${session.exitCode ?? '?'})` : session.cwd}
            >
              <Hi icon={CommandLineIcon} size={13} />
              <span className="term-tab-label">{tabLabel(session, index)}</span>
              <span
                className="term-tab-close"
                role="button"
                tabIndex={-1}
                aria-label="Close terminal"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTerminal(session.id)
                }}
              >
                <Hi icon={XMarkIcon} size={12} />
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="term-icon-btn"
          onClick={openTerminal}
          disabled={atCap}
          title={atCap ? `Session limit reached (${maxSessions})` : 'New terminal'}
        >
          <Hi icon={PlusIcon} size={15} />
        </button>
        <button type="button" className="term-icon-btn" onClick={onClose} title="Hide terminal (Ctrl+`)">
          <Hi icon={XMarkIcon} size={15} />
        </button>
      </div>

      {error && (
        <div className="term-banner error">
          {error}
          <button type="button" className="term-banner-dismiss" onClick={() => setError('')}>
            <Hi icon={XMarkIcon} size={12} />
          </button>
        </div>
      )}
      {connection !== 'open' && (
        <div className="term-banner">
          {connection === 'connecting' ? 'Connecting…' : `Disconnected${detail ? ` — ${detail}` : ''}`}
        </div>
      )}

      <div className="term-body">
        {sessions.length === 0 && connection === 'open' && (
          <div className="term-empty">
            <p>No terminal sessions.</p>
            <button type="button" className="btn" onClick={openTerminal}>
              <Hi icon={PlusIcon} size={14} /> New terminal
            </button>
          </div>
        )}
        {sessions.map((session) => (
          <TerminalPane
            key={session.id}
            session={session}
            active={session.id === activeId}
            fitToken={fitToken}
            onTitleData={onTitleData}
          />
        ))}
      </div>

      <div className="term-foot">
        <span>
          {liveCount}/{maxSessions} session{liveCount === 1 ? '' : 's'}
        </span>
        {/* Confirms the metric is live: these are the same events the Overview's
            Totem activity card counts under "Terminal command". */}
        <span title="Commands run in these sessions — tracked on the Totem activity card">
          {commandTotal} command{commandTotal === 1 ? '' : 's'}
        </span>
        {activeId && sessions.find((s) => s.id === activeId)?.exited && (
          <button type="button" className="term-foot-btn" onClick={() => closeTerminal(activeId)}>
            <Hi icon={TrashIcon} size={12} /> Remove
          </button>
        )}
      </div>
    </aside>
  )
}
