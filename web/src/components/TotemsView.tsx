import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, AuthError, getJobs, restoreJob } from '../api'
import { pushError, pushToast } from '../toast'
import { TI } from '../chat/ui'
import { useChat, syncThreads, setActive, adoptThread, threadTitle } from '../chat/store'
import { ago } from '../chat/settle'
import type { ChatThread } from '../chat/types'
import { IconArrowUp, IconChevronDown, IconChevronRight, IconDots, IconSettings, IconUsersGroup, IconX } from '../chat/icons'
import { Hi, AdjustmentsHorizontalIcon, ChatBubbleLeftIcon, PauseIcon, PlayIcon, TrashIcon } from '../icons'
import Menu, { type MenuEntry } from '../todos/Menu'
import { TimezoneContext } from '../totems/schedule'
import { TotemIcon, isBuiltIn, openTotemChat, setTotemEnabled, totemBrief, useTotemRun, type DraftRecord } from '../totems/shared'
import Builder, { MIN_DESCRIPTION } from '../totems/Builder'
import Detail from '../totems/Detail'
import TotemsIcon from './TotemsIcon'
import '../todos/todos.css'
import './settings/settings.css'
import './totems.css'

// Totems: standing agents that wake on a schedule or when something they watch
// changes, remember between runs, and tell the owner only what matters
// (totems/core.mjs and jobs/triggers.mjs on the bridge). Every scheduled job is
// one. This page is the list, laid out like a project's page: a composer to
// describe a new one, then drafts, group chats, the totems (his own and every
// built-in that is on) and, folded, the built-ins that are off. A row opens the totem's chat (its runs are posted
// there); the gear opens its settings (totems/Detail.tsx); a description opens
// the builder (totems/Builder.tsx).

const EXAMPLES = [
  { label: 'Restock alert', text: 'Watch a sold-out product page and tell me the moment it is back in stock.' },
  { label: 'Morning AI brief', text: 'Every weekday morning, research AI news and write me a one-page brief.' },
  { label: 'Weekly training review', text: 'Every Sunday evening, analyse my Strava week against my goals and tell me what to change.' },
]
const BUILT_IN_OPEN_KEY = 'totem.totems.builtInOpen'

const plain = (s: string) => s.replace(/[*_`#>|]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()

/** The newest message in a chat, as one plain line. */
function lastLine(t: ChatThread | undefined): { text: string; at: number } | null {
  const m = t?.messages[t.messages.length - 1]
  if (!m) return null
  const text = plain(m.content || '') || (m.parts?.some((p) => p.type === 'tool') ? 'Worked on something' : '')
  return text ? { text: m.role === 'user' ? `You: ${text}` : text, at: m.createdAt || t!.updatedAt } : null
}

/** A built-in that is off: kept on the folded shelf. */
const onShelf = (j: any) => isBuiltIn(j) && !j.enabled

function readFlag(key: string) { try { return localStorage.getItem(key) === '1' } catch { return false } }
function writeFlag(key: string, on: boolean) { try { localStorage.setItem(key, on ? '1' : '0') } catch { /* private mode: it just won't be remembered */ } }

/** Describe a new totem, like starting a chat; Enter hands it to the builder. */
function NewTotem({ onBuild }: { onBuild: (text: string) => void }) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])
  const ok = text.trim().length >= MIN_DESCRIPTION
  const go = () => { if (ok) onBuild(text.trim()) }
  return (
    <div className="tm-compose">
      <textarea
        ref={box}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go() } }}
        placeholder="Describe a new totem: what it should do, and how often"
        aria-label="Describe a new totem"
      />
      <div className="tm-compose-bar">
        <div className="tm-compose-try">
          {!text && EXAMPLES.map((x) => <button key={x.label} type="button" className="tm-chip" onClick={() => { setText(x.text); box.current?.focus() }}>{x.label}</button>)}
          {text && <span className="tm-compose-hint">{ok ? 'The builder designs it and asks what it needs. Nothing is created until you confirm.' : 'Say a little more about what it should do.'}</span>}
        </div>
        <button type="button" className="tm-send" disabled={!ok} onClick={go} aria-label="Build this totem" title="Build this totem"><TI icon={IconArrowUp} size={17} stroke={2.25} /></button>
      </div>
    </div>
  )
}

function Row({ icon, title, meta, metaTone, sub, time, unread, off, onOpen, openLabel, actions }: {
  icon: React.ReactNode; title: string; meta?: React.ReactNode; metaTone?: 'bad' | 'live'; sub?: string; time?: string
  unread?: boolean; off?: boolean; onOpen: () => void; openLabel: string; actions?: React.ReactNode
}) {
  return (
    <div className={`tm-row${off ? ' off' : ''}`}>
      <button type="button" className="tm-row-main" onClick={onOpen} title={openLabel}>
        <span className="tm-icon">{icon}</span>
        <span className="tm-row-text">
          <span className="tm-row-top">
            <span className="tm-row-name">{title}</span>
            {meta && <span className={`tm-row-meta${metaTone ? ` ${metaTone}` : ''}`}>{meta}</span>}
          </span>
          {sub && <span className={`tm-row-sub${unread ? ' unread' : ''}`}>{sub}</span>}
        </span>
        {(time || unread) && (
          <span className="tm-row-end">
            {time && <span className="tm-row-time">{time}</span>}
            {unread && <span className="tm-unread" aria-label="Unread" />}
          </span>
        )}
      </button>
      {actions && <div className="tm-row-actions">{actions}</div>}
    </div>
  )
}

function TotemRow({ job, thread, live, onOpen, onSettings, onChanged }: { job: any; thread?: ChatThread; live: boolean; onOpen: () => void; onSettings: () => void; onChanged: (job: any) => void }) {
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const last = lastLine(thread)
  const { running, run } = useTotemRun(job, onChanged)
  const state = totemBrief(job, live || running)
  const toggle = async () => { const fresh = await setTotemEnabled(job, !job.enabled); if (fresh) onChanged(fresh) }
  const items: MenuEntry[] = [
    { key: 'chat', label: 'Open chat', icon: ChatBubbleLeftIcon, onSelect: onOpen },
    { key: 'run', label: state.tone === 'live' ? 'Running now' : 'Run now', icon: PlayIcon, disabled: state.tone === 'live', onSelect: run },
    { key: 'pause', label: job.enabled ? 'Pause' : 'Turn on', icon: job.enabled ? PauseIcon : PlayIcon, onSelect: toggle },
    'separator',
    { key: 'settings', label: 'Settings, memory and runs', icon: AdjustmentsHorizontalIcon, onSelect: onSettings },
  ]
  return (
    <Row
      icon={<TotemIcon name={job.iconName} size={18} />}
      title={job.name}
      // On the shelf every row is off, so "Paused" would only repeat the shelf's title.
      meta={onShelf(job) && state.tone === 'idle' ? undefined : <>{state.tone && <span className={`tm-dot ${state.tone}`} aria-hidden />}{state.text}</>}
      metaTone={state.tone === 'bad' ? 'bad' : state.tone === 'live' ? 'live' : undefined}
      sub={last ? last.text : job.description || 'No messages yet. Its runs are posted in its chat.'}
      time={last ? ago(last.at, Date.now()) : undefined}
      unread={thread?.needsReply}
      off={!job.enabled}
      onOpen={onOpen}
      openLabel={`Open ${job.name}'s chat`}
      actions={(
        <>
          <button type="button" className="tm-act" onClick={onSettings} aria-label={`${job.name} settings`} title="Settings, memory and runs"><TI icon={IconSettings} size={16} /></button>
          <button type="button" className="tm-act" onClick={(e) => { const el = e.currentTarget; setMenu((m) => (m ? null : el)) }} aria-label={`More for ${job.name}`} aria-haspopup="menu" aria-expanded={!!menu}><TI icon={IconDots} size={16} /></button>
          {menu && <Menu anchor={menu} label={job.name} items={items} onClose={() => setMenu(null)} width={240} />}
        </>
      )}
    />
  )
}

/** Up to three member icons, side by side. */
function MemberStack({ ids, jobs }: { ids: string[]; jobs: any[] }) {
  const shown = ids.map((id) => jobs.find((j) => j.id === id)).filter(Boolean).slice(0, 3)
  if (!shown.length) return <TI icon={IconUsersGroup} size={18} />
  return (
    <span className={`tm-stack n${shown.length}`} aria-hidden>
      {shown.map((j) => <span key={j.id}><TotemIcon name={j.iconName} size={shown.length > 1 ? 12 : 18} /></span>)}
    </span>
  )
}

/** Pick totems for a group chat. Only agent totems can talk. */
export function GroupPicker({ jobs, initial = [], title: heading = 'New group chat', action = 'Start group chat', named = false, allowEmpty = false, onCancel, onDone }: { jobs: any[]; initial?: string[]; title?: string; action?: string; named?: boolean; allowEmpty?: boolean; onCancel: () => void; onDone: (ids: string[], name: string) => Promise<void> | void }) {
  const askable = jobs.filter((j) => !j.runner && !j.skillId && String(j.prompt || '').trim())
  const [picked, setPicked] = useState<string[]>(initial)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  return (
    <div className="tm-group-pick">
      <div className="tm-group-pick-head">
        <strong>{heading}</strong>
        <span>The chat’s agent hosts it: it asks the totems you pick and pulls their answers together. Say “@name” to talk to one directly.</span>
      </div>
      {!askable.length && <p className="tm-empty-line">No agent totems yet. Make one first; built-in jobs can’t talk.</p>}
      {askable.length > 0 && (
        <div className="tm-group-list">
          {askable.map((j) => (
            <label key={j.id} className={`tm-group-opt${picked.includes(j.id) ? ' on' : ''}`}>
              <input type="checkbox" checked={picked.includes(j.id)} onChange={() => toggle(j.id)} />
              <span className="tm-icon sm"><TotemIcon name={j.iconName} size={14} /></span>
              <span className="tm-group-opt-text"><span>{j.name}</span>{j.description && <span>{j.description}</span>}</span>
            </label>
          ))}
        </div>
      )}
      {named && askable.length > 0 && <input className="tm-group-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional), e.g. Weekly planning" aria-label="Group chat name" />}
      <div className="tm-group-actions">
        <button type="button" className="btn compact ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn compact primary" disabled={(!picked.length && !allowEmpty) || busy} onClick={async () => { setBusy(true); try { await onDone(picked, name.trim()) } finally { setBusy(false) } }}>{busy ? 'Working…' : action}</button>
      </div>
    </div>
  )
}

/** Make a group chat and open it. */
export async function startGroupChat(ids: string[], title: string, onOpenChat: () => void) {
  try {
    const { thread } = await api<{ thread: ChatThread }>('/api/totems/groups', { method: 'POST', body: JSON.stringify({ members: ids, title }) })
    adoptThread(thread)
    setActive(thread.id)
    onOpenChat()
  } catch (e: any) { pushError(`Couldn't start the group chat: ${e.message}`) }
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="tm-sec">
      <div className="tm-sec-head">
        <h2>{title}{count != null && <span>{count}</span>}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export default function TotemsView({ onAuthError, onOpenChat }: { onAuthError: () => void; onOpenChat: () => void }) {
  const [jobs, setJobs] = useState<any[] | null>(null)
  const [loadError, setLoadError] = useState('')
  // Built-in totems the owner deleted, which can be brought back.
  const [restorable, setRestorable] = useState<{ id: string; name: string; description?: string }[]>([])
  const [timezone, setTimezone] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<DraftRecord[]>([])
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get('totem'))
  // false: the list; otherwise the builder, on a saved draft or a new description.
  const [building, setBuilding] = useState<false | { draft: DraftRecord | null; start?: string }>(false)
  const [grouping, setGrouping] = useState(false)
  const [builtInOpen, setBuiltInOpen] = useState(() => readFlag(BUILT_IN_OPEN_KEY))
  const threads = useChat((s) => s.threads)
  const runs = useChat((s) => s.runs)

  // The chat header's totem link lands here with ?totem=<id>.
  useEffect(() => {
    const onPop = () => setOpen(new URLSearchParams(window.location.search).get('totem'))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const openSettings = (id: string | null) => {
    setOpen(id)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('totem', id)
    else url.searchParams.delete('totem')
    window.history.replaceState(window.history.state, '', url.pathname + url.search)
    document.querySelector('.tm-view')?.scrollTo(0, 0)
  }

  const loadDrafts = useCallback(() => {
    api<{ drafts: DraftRecord[] }>('/api/totems/drafts').then((r) => setDrafts(r.drafts || [])).catch(() => {})
  }, [])
  const load = useCallback(() => {
    getJobs().then((p: any) => { setJobs(p.jobs || []); setRestorable(p.restorable || []); setTimezone(p.timezone || null); setLoadError('') })
      .catch((e) => { if (e instanceof AuthError) onAuthError(); else setLoadError(e.message) })
    loadDrafts()
  }, [onAuthError, loadDrafts])
  useEffect(() => {
    load()
    syncThreads()
    const t = setInterval(() => { load(); syncThreads() }, 30_000)
    return () => clearInterval(t)
  }, [load])

  const replace = (job: any) => setJobs((list) => (list || []).map((j) => (j.id === job.id ? job : j)))
  const ownChat = useMemo(() => new Map(threads.filter((t) => t.totemId).map((t) => [t.totemId!, t])), [threads])
  // His own totems and every built-in that is on, the ones that are on first,
  // then whichever spoke last. Built-ins that are off wait on the shelf.
  const order = useCallback((a: any, b: any) => Number(b.enabled) - Number(a.enabled)
    || (ownChat.get(b.id)?.updatedAt || 0) - (ownChat.get(a.id)?.updatedAt || 0) || a.name.localeCompare(b.name), [ownChat])
  const listed = useMemo(() => (jobs || []).filter((j) => !onShelf(j)).sort(order), [jobs, order])
  const builtInOff = useMemo(() => (jobs || []).filter(onShelf).sort((a, b) => a.name.localeCompare(b.name)), [jobs])
  const groups = useMemo(() => threads.filter((t) => t.members?.length).sort((a, b) => b.updatedAt - a.updatedAt), [threads])
  const job = open ? jobs?.find((j) => j.id === open) : null

  const closeBuilder = () => { setBuilding(false); loadDrafts() }
  async function discardDraft(d: DraftRecord) {
    if (!window.confirm(`Discard the draft${d.draft?.name ? ` “${d.draft.name}”` : ''}?`)) return
    try { await api(`/api/totems/drafts/${d.id}`, { method: 'DELETE' }); setDrafts((l) => l.filter((x) => x.id !== d.id)) } catch (e: any) { pushError(e.message) }
  }
  const toggleBuiltIn = () => setBuiltInOpen((v) => { writeFlag(BUILT_IN_OPEN_KEY, !v); return !v })
  const totemRow = (j: any) => {
    const chat = ownChat.get(j.id)
    return (
      <TotemRow key={j.id} job={j} thread={chat} live={!!(chat && runs[chat.id])}
        onOpen={() => openTotemChat(j, onOpenChat)} onSettings={() => openSettings(j.id)} onChanged={replace} />
    )
  }

  if (building !== false) {
    return (
      <div className="view tm-view">
        <Builder
          key={building.draft?.id || 'new'}
          initial={building.draft}
          start={building.start}
          onClose={closeBuilder}
          onDiscarded={closeBuilder}
          onCreated={(j) => { closeBuilder(); setJobs((l) => [...(l || []), j]); openTotemChat(j, onOpenChat) }}
        />
      </div>
    )
  }
  if (job) {
    return (
      <TimezoneContext.Provider value={timezone}>
        <div className="view tm-view">
          <Detail job={job} onBack={() => openSettings(null)} onChanged={replace} onDeleted={() => { openSettings(null); load() }} onOpenChat={onOpenChat} />
        </div>
      </TimezoneContext.Provider>
    )
  }

  return (
    <div className="view tm-view">
      <div className="tm-page">
        <header className="tm-list-hero">
          <h1><TotemsIcon width={26} height={26} aria-hidden />Totems</h1>
          <p>Standing agents that work on their own schedule, remember what they’ve seen, and only tell you what matters.</p>
        </header>
        <NewTotem onBuild={(text) => setBuilding({ draft: null, start: text })} />

        {loadError && (
          <p className="tm-empty-line bad" role="alert">Couldn’t {jobs ? 'refresh' : 'load'} your totems: {loadError} <button type="button" className="tm-link" onClick={load}>Try again</button></p>
        )}
        {!jobs && !loadError && <p className="tm-empty-line">Loading…</p>}

        {drafts.length > 0 && (
          <Section title="Drafts" count={drafts.length}>
            {drafts.map((d) => {
              const asks = !d.pending && !!d.messages[d.messages.length - 1]?.questions?.length
              return (
                <Row
                  key={d.id}
                  icon={<TotemIcon name={d.draft?.icon || 'sparkles'} size={18} />}
                  title={d.draft?.name || 'Untitled totem'}
                  meta={d.pending ? <><span className="tm-dot live" aria-hidden />Builder at work</> : asks ? <><span className="tm-dot accent" aria-hidden />Has questions for you</> : !d.draft ? 'Not designed yet' : undefined}
                  metaTone={d.pending ? 'live' : undefined}
                  sub={d.draft?.summary || d.description}
                  time={ago(d.updatedAt, Date.now())}
                  onOpen={() => setBuilding({ draft: d })}
                  openLabel={`Continue the draft ${d.draft?.name || ''}`.trim()}
                  actions={<button type="button" className="tm-act" onClick={() => discardDraft(d)} aria-label={`Discard ${d.draft?.name || 'draft'}`} title="Discard draft"><TI icon={IconX} size={16} /></button>}
                />
              )
            })}
          </Section>
        )}

        {jobs && (
          <Section
            title="Group chats"
            count={groups.length || undefined}
            action={!grouping && <button type="button" className="btn compact ghost" onClick={() => setGrouping(true)}><TI icon={IconUsersGroup} size={15} />New group chat</button>}
          >
            {grouping && (
              <GroupPicker jobs={jobs} named onCancel={() => setGrouping(false)} onDone={async (ids, name) => { await startGroupChat(ids, name, onOpenChat); setGrouping(false) }} />
            )}
            {groups.map((t) => {
              const last = lastLine(t)
              const names = (t.members || []).map((id) => jobs.find((j) => j.id === id)?.name).filter(Boolean)
              return (
                <Row
                  key={t.id}
                  icon={<MemberStack ids={t.members || []} jobs={jobs} />}
                  title={threadTitle(t)}
                  meta={runs[t.id] ? <><span className="tm-dot live" aria-hidden />Answering</> : undefined}
                  metaTone={runs[t.id] ? 'live' : undefined}
                  sub={last ? last.text : `You${names.length ? `, ${names.join(', ')}` : ''}`}
                  time={last ? ago(last.at, Date.now()) : undefined}
                  unread={t.needsReply}
                  onOpen={() => { setActive(t.id); onOpenChat() }}
                  openLabel={`Open the group chat ${threadTitle(t)}`}
                />
              )
            })}
            {!groups.length && !grouping && <p className="tm-empty-line">Put several totems in one chat and its agent asks each of them in turn.</p>}
          </Section>
        )}

        {jobs && (
          <Section title="Totems" count={listed.length || undefined}>
            {listed.map(totemRow)}
            {!listed.length && <p className="tm-empty-line">None yet. Describe one above, such as watching a listing or writing a weekly review, and the builder sets it up.</p>}
          </Section>
        )}

        {jobs && (builtInOff.length > 0 || restorable.length > 0) && (
          <section className="tm-sec">
            <button type="button" className="tm-shelf" aria-expanded={builtInOpen} onClick={toggleBuiltIn}>
              <TI icon={builtInOpen ? IconChevronDown : IconChevronRight} size={15} />
              <h2>More built in<span>{builtInOff.length + restorable.length}</span></h2>
              <span className="tm-shelf-note">{builtInOff.length && restorable.length ? `${builtInOff.length} off, ${restorable.length} deleted · ` : ''}Switched off: briefings, syncs and housekeeping that ship with Totem</span>
            </button>
            {builtInOpen && (
              <>
                {builtInOff.map(totemRow)}
                {restorable.map((r) => (
                  <div key={r.id} className="tm-row off">
                    <div className="tm-row-main static">
                      <span className="tm-icon"><Hi icon={TrashIcon} size={16} /></span>
                      <span className="tm-row-text">
                        <span className="tm-row-top"><span className="tm-row-name">{r.name}</span><span className="tm-row-meta">Deleted</span></span>
                        {r.description && <span className="tm-row-sub">{r.description}</span>}
                      </span>
                    </div>
                    <div className="tm-row-actions shown">
                      <button type="button" className="btn compact" onClick={async () => {
                        try { await restoreJob(r.id); pushToast(`${r.name} restored`, 'info'); load() } catch (e: any) { pushError(e.message) }
                      }}>Restore</button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
