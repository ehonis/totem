import React, { useEffect, useState } from 'react'
import { Hi, SparklesIcon, BoltIcon, CircleStackIcon } from '../icons'
import SkillsView from './SkillsView'
import JobsView from './JobsView'
import McpSettingsView from './McpSettingsView'

// Studio is where you shape what Totem can do: its skills, the workflows that run
// them automatically, and the app connections they reach. Connections moved here
// out of Settings so everything about Totem's capabilities lives in one place.
const SUB_TABS = [
  { id: 'skills', label: 'Skills', icon: SparklesIcon },
  // Route id stays 'workflows' so existing deep links and the remembered last
  // sub-tab keep working; the label is what changed.
  { id: 'workflows', label: 'Jobs', icon: BoltIcon },
  { id: 'connections', label: 'Connections', icon: CircleStackIcon },
]

const VALID_SUBTABS = SUB_TABS.map((t) => t.id)

interface StudioViewProps {
  onAuthError: () => void
  subTab?: string
  onSubTab: (id: string) => void
}

export default function StudioView({ onAuthError, subTab, onSubTab }: StudioViewProps) {
  const [sub, setSub] = useState(() => (VALID_SUBTABS.includes(subTab) ? subTab : 'skills'))

  // Follow the URL when it changes underneath us (Back/Forward, or a deep link).
  useEffect(() => {
    if (subTab && VALID_SUBTABS.includes(subTab) && subTab !== sub) setSub(subTab)
  }, [subTab])

  function setSubTab(id: string) {
    setSub(id)
    onSubTab?.(id)
  }

  return (
    <div className="view studio-view">
      <div className="settings-layout">
        <aside className="settings-subnav">
          <div className="settings-subnav-title">Studio</div>
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
          {sub === 'skills' && <SkillsView onAuthError={onAuthError} />}
          {sub === 'workflows' && <JobsView onAuthError={onAuthError} />}
          {sub === 'connections' && <McpSettingsView onAuthError={onAuthError} />}
        </div>
      </div>
    </div>
  )
}
