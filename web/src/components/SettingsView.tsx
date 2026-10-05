import React, { useEffect, useState } from 'react'
import { Hi, Cog6ToothIcon, AdjustmentsHorizontalIcon, ArrowRightOnRectangleIcon, CommandLineIcon, BellAlertIcon, MicrophoneIcon, ChatBubbleLeftRightIcon, SparklesIcon, BoltIcon, CircleStackIcon, ShieldCheckIcon, LinkIcon, CheckCircleIcon } from '../icons'
import { ApiError, changePassword, clearSecret, getAuthStatus, logout } from '../api'
import type { AuthStatus } from '../api'
import AiSettings from './AiSettings'
import IntegrationsSettings from './IntegrationsSettings'
import TaskSettings from './TaskSettings'
import { useSettings, setSetting } from '../settings'
import ProvidersView from './ProvidersView'
import ShortcutsSettings from './ShortcutsSettings'
import NotificationsSettings from './NotificationsSettings'
import VoiceSettings from './VoiceSettings'
import ChatSettings from './ChatSettings'
import SkillsView from './SkillsView'
import JobsView from './JobsView'
import McpSettingsView from './McpSettingsView'
import LogsView from './LogsView'

// Connections (MCP) moved to the Studio tab - Settings now covers app
// preferences and AI providers only.
const SUB_TABS = [
  { id: 'general', label: 'General', icon: Cog6ToothIcon },
  { id: 'chat', label: 'Chat', icon: ChatBubbleLeftRightIcon },
  { id: 'ai', label: 'AI', icon: SparklesIcon },
  { id: 'integrations', label: 'Integrations', icon: LinkIcon },
  { id: 'tasks', label: 'Tasks', icon: CheckCircleIcon },
  { id: 'providers', label: 'Providers', icon: AdjustmentsHorizontalIcon },
  { id: 'shortcuts', label: 'Shortcuts', icon: CommandLineIcon },
  { id: 'notifications', label: 'Notifications', icon: BellAlertIcon },
  { id: 'voice', label: 'Voice', icon: MicrophoneIcon },
  // The AI workshop, formerly Studio and Logs in the side nav.
  { id: 'skills', label: 'Skills', icon: SparklesIcon },
  { id: 'jobs', label: 'Jobs', icon: BoltIcon },
  { id: 'connections', label: 'Connections', icon: CircleStackIcon },
  { id: 'logs', label: 'Logs', icon: ShieldCheckIcon },
]

interface ToggleProps {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  label: string
}

// Accessible on/off switch - used for the boolean app preferences below.
function Toggle({ checked, onChange, disabled, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

interface SettingRowProps {
  title: string
  desc?: string
  children?: React.ReactNode
}

function SettingRow({ title, desc, children }: SettingRowProps) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <strong>{title}</strong>
        {desc && <span>{desc}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

// Client-side app preferences. Each control is wired to the shared settings store,
// so flipping one takes effect live across the app (see settings.js / App.jsx).
function GeneralPane({ onDisconnect }: { onDisconnect: () => void }) {
  const s = useSettings()
  return (
    <div className="settings-pane">
      <header className="settings-pane-head">
        <h2>General</h2>
        <p>Preferences for how the dashboard looks and behaves on this device.</p>
      </header>

      <div className="settings-section-title"><span /><strong>Appearance</strong></div>
      <div className="setting-list">
        <SettingRow title="Reduce motion" desc="Turn off animations and transitions across the app.">
          <Toggle label="Reduce motion" checked={s.reduceMotion} onChange={(v) => setSetting('reduceMotion', v)} />
        </SettingRow>
        <SettingRow title="Compact density" desc="Tighten spacing and padding to fit more on screen.">
          <Toggle label="Compact density" checked={s.compact} onChange={(v) => setSetting('compact', v)} />
        </SettingRow>
      </div>

      <div className="settings-section-title"><span /><strong>Behavior</strong></div>
      <div className="setting-list">
        <SettingRow title="Auto-refresh data" desc="Poll live views like Usage in the background while open.">
          <Toggle label="Auto-refresh data" checked={s.autoRefresh} onChange={(v) => setSetting('autoRefresh', v)} />
        </SettingRow>
        <SettingRow title="Default tab" desc="Which tab opens when you first load the dashboard.">
          <select className="model-select" value={s.landingTab} onChange={(e) => setSetting('landingTab', e.target.value)}>
            <option value="overview">Overview</option>
            <option value="productivity">Productivity</option>
            <option value="code">Code</option>
            <option value="inbox">Inbox</option>
            <option value="chat">Chat</option>
            <option value="todos">Productivity · Todos</option>
            <option value="calendar">Productivity · Calendar</option>
            <option value="habits">Productivity · Habits</option>
            <option value="lists">Productivity · Lists</option>
            <option value="brain">Brain</option>
            <option value="studio">Studio</option>
          </select>
        </SettingRow>
      </div>

      <AccountSection onSignedOut={onDisconnect} />
    </div>
  )
}

// Sign out, and change the owner password. In proxy mode there is no password
// here to change: the auth proxy in front owns sign-in.
function AccountSection({ onSignedOut }: { onSignedOut: () => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { getAuthStatus().then(setStatus).catch(() => {}) }, [])

  async function signOut() {
    await logout().catch(() => {})
    clearSecret()
    onSignedOut()
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setNote('')
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setNote('Password changed. Other signed-in devices have been signed out.')
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="settings-section-title"><span /><strong>Account</strong></div>
      <div className="setting-list">
        {status?.mode === 'password' && (
          <SettingRow title="Change password" desc="Signs out every other device.">
            <form className="flex gap-2 flex-wrap" onSubmit={savePassword}>
              <input className="model-select" type="password" autoComplete="current-password" placeholder="Current"
                value={current} onChange={(e) => setCurrent(e.target.value)} />
              <input className="model-select" type="password" autoComplete="new-password" placeholder="New (8+ characters)"
                value={next} onChange={(e) => setNext(e.target.value)} />
              <button className="btn" type="submit" disabled={busy || !current || !next}>Change</button>
            </form>
          </SettingRow>
        )}
        {note && <p className="text-muted m-0 px-1">{note}</p>}
        <SettingRow
          title="Sign out"
          desc={status?.mode === 'proxy'
            ? 'Sign-in is handled by the auth proxy in front of Totem (TOTEM_AUTH=proxy). This forgets any saved bridge secret on this device.'
            : 'End this session and forget any saved bridge secret on this device.'}
        >
          <button className="btn danger" onClick={signOut}>
            <Hi icon={ArrowRightOnRectangleIcon} size={15} /> Sign out
          </button>
        </SettingRow>
      </div>
    </>
  )
}

const VALID_SUBTABS = SUB_TABS.map((t) => t.id)

interface SettingsViewProps {
  onAuthError: () => void
  subTab?: string
  onSubTab: (id: string) => void
  /** Section to scroll into view once the pane is up (from the URL hash). */
  scrollTo?: string
}

export default function SettingsView({ onAuthError, subTab, onSubTab, scrollTo }: SettingsViewProps) {
  const [sub, setSub] = useState(() =>
    VALID_SUBTABS.includes(subTab) ? subTab : 'general'
  )

  // Follow the URL when it changes underneath us — Back/Forward, or a deep link
  // from elsewhere in the app (Overview's "Usage" button lands on providers).
  useEffect(() => {
    if (subTab && VALID_SUBTABS.includes(subTab) && subTab !== sub) setSub(subTab)
  }, [subTab])

  function setSubTab(id: string) {
    setSub(id)
    onSubTab?.(id)
  }
  return (
    <div className="view settings-view">
      <div className="settings-layout">
        <aside className="settings-subnav">
          <div className="settings-subnav-title">Settings</div>
          {SUB_TABS.map((t) => (
            <button
              key={t.id}
              className={`subnav-item ${sub === t.id ? 'active' : ''}`}
              onClick={() => setSubTab(t.id)}
            >
              <span className="ico"><Hi icon={t.icon} size={16} /></span>
              {t.label}
            </button>
          ))}
        </aside>
        <div className="settings-content">
          {sub === 'general' && <GeneralPane onDisconnect={onAuthError} />}
          {sub === 'ai' && <AiSettings onAuthError={onAuthError} />}
          {sub === 'integrations' && <IntegrationsSettings onAuthError={onAuthError} />}
          {sub === 'tasks' && <TaskSettings onAuthError={onAuthError} />}
          {sub === 'providers' && <ProvidersView onAuthError={onAuthError} scrollTo={scrollTo} />}
          {sub === 'shortcuts' && <ShortcutsSettings />}
          {sub === 'notifications' && <NotificationsSettings />}
          {sub === 'voice' && <VoiceSettings />}
          {sub === 'chat' && <ChatSettings />}
          {sub === 'skills' && <SkillsView onAuthError={onAuthError} />}
          {sub === 'jobs' && <JobsView onAuthError={onAuthError} />}
          {sub === 'connections' && <McpSettingsView onAuthError={onAuthError} />}
          {sub === 'logs' && <LogsView onAuthError={onAuthError} />}
        </div>
      </div>
    </div>
  )
}
