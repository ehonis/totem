import React, { useEffect, useRef } from 'react'
import TodosView from './TodosView'
import CalendarView from './CalendarView'
import HabitsView from './HabitsView'
import GoalsView from './GoalsView'
import JournalView from './JournalView'
import ListsView from './ListsView'
import todosIcon from '../assets/connection-icons/totem-todos.svg'
import googleCalendarIcon from '../assets/connection-icons/google-calendar.svg'
import habitsIcon from '../assets/connection-icons/habits.svg'
import goalsIcon from '../assets/connection-icons/goals.svg'
import journalIcon from '../assets/connection-icons/journal.svg'
import listsIcon from '../assets/connection-icons/lists.svg'

// The productivity apps surfaced as manila-folder / browser-style tabs. This is the
// single place that knows which apps exist - adding another todo or calendar
// provider later is just one more entry (id + label + brand icon + view).
const APPS = [
  { id: 'todos', label: 'Todos', icon: todosIcon, render: (p: any) => <TodosView {...p} /> },
  { id: 'habits', label: 'Habits', icon: habitsIcon, render: (p: any) => <HabitsView {...p} /> },
  { id: 'goals', label: 'Goals', icon: goalsIcon, render: (p: any) => <GoalsView {...p} /> },
  { id: 'lists', label: 'Lists', icon: listsIcon, render: (p: any) => <ListsView {...p} /> },
  { id: 'journal', label: 'Journal', icon: journalIcon, render: (p: any) => <JournalView {...p} /> },
  // Last, and just "Calendar": the provider is the icon's job, and the long label
  // was pushing the tabs the owner actually opens off the side of a phone.
  { id: 'calendar', label: 'Calendar', icon: googleCalendarIcon, render: (p: any) => <CalendarView {...p} /> },
]

interface ProductivityViewProps {
  app: string
  onApp: (id: string) => void
  onAuthError: () => void
}

export default function ProductivityView({ app, onApp, onAuthError }: ProductivityViewProps) {
  const active = APPS.find((a) => a.id === app) || APPS[0]
  // The strip scrolls once there are more apps than fit a phone, so landing on one
  // directly (a saved link, `g g`) has to bring its own tab into view - otherwise you
  // arrive on Goals looking at the Todos tab.
  const activeTab = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [active.id])

  return (
    <div className="productivity">
      <div className="app-tabs" role="tablist" aria-label="Productivity apps">
        {APPS.map((a) => (
          <button
            key={a.id}
            ref={active.id === a.id ? activeTab : undefined}
            role="tab"
            aria-selected={active.id === a.id}
            className={`app-tab ${active.id === a.id ? 'active' : ''}`}
            onClick={() => onApp(a.id)}
          >
            <img className="app-tab-ico" src={a.icon} alt="" aria-hidden="true" />
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      <div className="app-panel">
        {active.render({ onAuthError })}
      </div>
    </div>
  )
}
