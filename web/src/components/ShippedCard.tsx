import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { getDevShipped, setDevShippedHidden, setDevShippedGroups, AuthError, type DevShipped, type DevShippedGroup, type DevShippedPull } from '../api'
import { ActivityChart, relTime } from '../usageMeta'
import { pushToast } from '../toast'
import { Hi, PlusIcon, TrashIcon, WarnIcon } from '../icons'
import { readDevCache, writeDevCache } from '../devCache'

// PRs per day: every PR the server's gh login authored and merged, in any repo,
// one column per day split by repo. The busiest eight repos in the range get a
// colour each and the rest share grey. A repo can be hidden (a public mirror that
// repeats a private repo's PRs, say); that is kept in data/dev.json. A click on a
// day lists its PRs. Repos can be put in named groups (Work, Side projects) and
// the chart split by repo, by group, or by repo shaded in its group's colour.
// docs/dev-tab.md → PRs per day.

const RANGES = [14, 30, 90]
// Eight categorical hues in a fixed order, checked for colour-blind separation on
// the card surface. A ninth repo is never a new hue; it joins Other.
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
const OTHER = '__other'
const OTHER_COLOR = '#5d6475'

type GroupBy = 'repo' | 'group' | 'both'
const GROUP_BY: { id: GroupBy; label: string; title: string }[] = [
  { id: 'repo', label: 'Repos', title: 'One colour per repo' },
  { id: 'group', label: 'Groups', title: 'One colour per group; ungrouped repos stand alone' },
  { id: 'both', label: 'Both', title: 'One shade per repo, in its group’s colour' },
]
const groupKey = (name: string) => `g:${name}` // ':' never appears in owner/name

// The nth repo of a group, lightened a step so stacked repos stay apart.
const shade = (hex: string, i: number) => {
  if (!i) return hex
  const t = Math.min(0.6, i * 0.2)
  const n = parseInt(hex.slice(1), 16)
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, '0')).join('')
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const repoName = (repo: string) => repo.split('/')[1] || repo
const fmtDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function ShippedCard({ onAuthError }: { onAuthError: () => void }) {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<DevShipped | null>(() => readDevCache<DevShipped>('shipped:30'))
  const [hidden, setHidden] = useState<string[]>(() => data?.hidden || [])
  const [groups, setGroups] = useState<DevShippedGroup[]>(() => data?.groups || [])
  const [groupBy, setGroupByState] = useState<GroupBy>(() => readDevCache<GroupBy>('shippedGroupBy') || 'repo')
  const [draft, setDraft] = useState<DevShippedGroup[] | null>(null)
  const [newGroup, setNewGroup] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<number | null>(null)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    setError(null)
    // A range seen before paints from the last answer while GitHub is asked.
    const cached = refresh ? null : readDevCache<DevShipped>(`shipped:${days}`)
    if (cached) setData(cached)
    try {
      const res = await getDevShipped(days, refresh)
      setData(res)
      setHidden(res.hidden)
      setGroups(res.groups || [])
      writeDevCache(`shipped:${days}`, res)
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError(); else setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [days, onAuthError])

  useEffect(() => { setPicked(null); load() }, [load])

  const view = useMemo(() => {
    if (!data) return null
    const today = new Date()
    const keys: string[] = []
    for (let i = days - 1; i >= 0; i--) keys.push(dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)))
    const inRange = new Set(keys)
    const pulls = data.pulls
      .map((p) => ({ ...p, day: dayKey(new Date(p.mergedAt)) }))
      .filter((p) => inRange.has(p.day))

    const totals = new Map<string, number>()
    for (const p of pulls) totals.set(p.repo, (totals.get(p.repo) || 0) + 1)
    const repos = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)! || a.localeCompare(b))
    const shown = repos.filter((r) => !hidden.includes(r))

    // A unit is what gets a hue: a repo, or in the group views a group (an
    // ungrouped repo is its own unit). The busiest eight units get one each.
    const groupOf = new Map<string, string>()
    for (const g of groups) for (const r of g.repos) groupOf.set(r, g.name)
    const by: GroupBy = groups.length ? groupBy : 'repo'
    const unitOf = (repo: string) => (by !== 'repo' && groupOf.has(repo) ? groupKey(groupOf.get(repo)!) : repo)
    const unitTotals = new Map<string, number>()
    for (const r of shown) unitTotals.set(unitOf(r), (unitTotals.get(unitOf(r)) || 0) + totals.get(r)!)
    const units = [...unitTotals.keys()].sort((a, b) => unitTotals.get(b)! - unitTotals.get(a)! || a.localeCompare(b))
    const ranked = new Set(units.slice(0, PALETTE.length))
    const unitColor = new Map(units.map((u, i) => [u, PALETTE[i] || OTHER_COLOR]))
    const unitLabel = (u: string) => (u.startsWith('g:') ? u.slice(2) : repoName(u))

    const order: string[] = []
    const meta: Record<string, { label: string; color: string }> = {}
    const colorOf = new Map<string, string>()
    for (const u of units) {
      if (!ranked.has(u)) continue
      const members = shown.filter((r) => unitOf(r) === u)
      if (by === 'both') {
        members.forEach((r, i) => {
          order.push(r)
          meta[r] = { label: u === r ? repoName(r) : `${unitLabel(u)} · ${repoName(r)}`, color: shade(unitColor.get(u)!, i) }
          colorOf.set(r, meta[r].color)
        })
      } else {
        order.push(u)
        meta[u] = { label: unitLabel(u), color: unitColor.get(u)! }
        for (const r of members) colorOf.set(r, unitColor.get(u)!)
      }
    }
    const overflow = shown.filter((r) => !ranked.has(unitOf(r)))
    if (overflow.length) {
      order.push(OTHER)
      meta[OTHER] = { label: `${overflow.length} other repo${overflow.length === 1 ? '' : 's'}`, color: OTHER_COLOR }
    }
    const seriesOf = (repo: string) => (!ranked.has(unitOf(repo)) ? OTHER : by === 'both' ? repo : unitOf(repo))

    const visible = pulls.filter((p) => !hidden.includes(p.repo))
    const daily = keys.map((date) => ({ date, count: 0, channels: {} as Record<string, number>, pulls: [] as typeof visible }))
    const index = new Map(keys.map((k, i) => [k, i]))
    for (const p of visible) {
      const d = daily[index.get(p.day)!]
      const id = seriesOf(p.repo)
      d.count++
      d.channels[id] = (d.channels[id] || 0) + 1
      d.pulls.push(p)
    }
    const busiest = daily.reduce((best, d) => (d.count > best.count ? d : best), daily[0])
    const activeDays = daily.filter((d) => d.count).length

    // The legend: in the group views, each group with a PR in range heads its own repos.
    const sections = by === 'repo' ? [] : groups
      .map((g) => ({
        name: g.name,
        repos: repos.filter((r) => groupOf.get(r) === g.name),
        count: unitTotals.get(groupKey(g.name)) || 0,
        color: unitColor.get(groupKey(g.name)) || OTHER_COLOR,
      }))
      .filter((sec) => sec.repos.length)
      .sort((a, b) => b.count - a.count)
    const loose = by === 'repo' ? repos : repos.filter((r) => !groupOf.has(r))
    return { daily, order, meta, repos, totals, colorOf, groupOf, by, sections, loose, total: visible.length, busiest, activeDays }
  }, [data, days, hidden, groups, groupBy])

  const setGroupBy = (next: GroupBy) => { setGroupByState(next); writeDevCache('shippedGroupBy', next) }

  // Optimistic, like the watch toggle; the file write catches up behind it.
  const toggleHidden = async (repo: string) => {
    const before = hidden
    const hide = !before.includes(repo)
    setHidden(hide ? [...before, repo] : before.filter((r) => r !== repo))
    try {
      setHidden((await setDevShippedHidden(repo, hide)).shippedHidden)
    } catch (e: any) {
      setHidden(before)
      if (e instanceof AuthError) onAuthError(); else pushToast(`Could not ${hide ? 'hide' : 'show'} ${repo}: ${e.message}`)
    }
  }

  // The editor works on a copy; Save replaces the whole list on the server.
  const editRepos = draft
    ? [...new Set([...(view?.repos || []), ...draft.flatMap((g) => g.repos)])].sort((a, b) => repoName(a).localeCompare(repoName(b)))
    : []
  const assign = (repo: string, to: number) => setDraft((d) => d && d.map((g, i) => ({
    ...g,
    repos: i === to ? [...g.repos.filter((r) => r !== repo), repo] : g.repos.filter((r) => r !== repo),
  })))
  const addGroup = () => {
    const name = newGroup.trim()
    if (!name || draft?.some((g) => g.name.toLowerCase() === name.toLowerCase())) return
    setDraft((d) => d && [...d, { name, repos: [] }])
    setNewGroup('')
  }
  const saveGroups = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const saved = (await setDevShippedGroups(draft.filter((g) => g.name.trim()))).shippedGroups
      setGroups(saved)
      if (saved.length && !groups.length && groupBy === 'repo') setGroupBy('group')
      setDraft(null)
    } catch (e: any) {
      if (e instanceof AuthError) onAuthError(); else pushToast(`Could not save the groups: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const repoKey = (r: string) => {
    const off = hidden.includes(r)
    const color = view?.colorOf.get(r) || OTHER_COLOR
    return (
      <button
        key={r}
        type="button"
        className={`shipped-key${off ? ' off' : ''}`}
        onClick={() => toggleHidden(r)}
        title={off ? `${r} is hidden. Click to show it.` : `${r}. Click to hide it from the chart.`}
      >
        <span className="activity-tip-dot" style={{ background: off ? 'transparent' : color, borderColor: color }} />
        {repoName(r)}
        <span className="muted">{view?.totals.get(r)}</span>
      </button>
    )
  }

  const day = view && picked != null ? view.daily[picked] : null

  return (
    <section className="card dev-card shipped">
      <div className="dev-card-head">
        <div>
          <h2 style={{ margin: 0 }}>PRs per day</h2>
          <div className="muted shipped-sub">
            {view
              ? <>
                  <b>{view.total}</b> merged in {days} days · {(view.total / days).toFixed(1)} a day · {view.activeDays} active days
                  {view.busiest.count > 0 && <> · busiest {fmtDay(view.busiest.date)} ({view.busiest.count})</>}
                </>
              : 'Pull requests you merged, in every repo'}
          </div>
        </div>
        <span className="dev-card-actions">
          {groups.length > 0 && (
            <span className="cal-viewswitch" aria-label="Split the chart by">
              {GROUP_BY.map((g) => (
                <button key={g.id} type="button" className={`seg${g.id === groupBy ? ' active' : ''}`} title={g.title} onClick={() => setGroupBy(g.id)}>{g.label}</button>
              ))}
            </span>
          )}
          <button type="button" className={`btn compact${draft ? ' active' : ''}`} onClick={() => setDraft(draft ? null : groups.map((g) => ({ ...g, repos: [...g.repos] })))}>
            Edit groups
          </button>
          <span className="cal-viewswitch">
            {RANGES.map((n) => (
              <button key={n} type="button" className={`seg${n === days ? ' active' : ''}`} onClick={() => setDays(n)}>{n}d</button>
            ))}
          </span>
          <button type="button" className="btn compact" onClick={() => load(true)} disabled={loading} title={data ? `Fetched ${relTime(new Date(data.fetchedAt).getTime())}` : undefined}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </span>
      </div>

      {error && <div className="muted inline-warn"><WarnIcon /> {error}</div>}
      {error && !view ? null : !view ? (
        <div className="spinner">Searching GitHub…</div>
      ) : (
        <>
          <ActivityChart
            daily={view.daily}
            order={view.order}
            meta={view.meta}
            unit="PR"
            height={140}
            picked={picked}
            onPick={(i) => setPicked((p) => (p === i ? null : i))}
          />
          <div className="shipped-axis muted">
            <span>{fmtDay(view.daily[0].date)}</span>
            <span>Today</span>
          </div>

          <div className="shipped-legend">
            {view.sections.map((sec) => (
              <div className="shipped-group" key={sec.name}>
                <span className="shipped-group-name">
                  <span className="activity-tip-dot" style={{ background: sec.color }} />
                  {sec.name}
                  <span className="muted">{sec.count}</span>
                </span>
                {sec.repos.map(repoKey)}
              </div>
            ))}
            {view.sections.length > 0 && view.loose.length > 0
              ? <div className="shipped-group"><span className="shipped-group-name muted">Ungrouped</span>{view.loose.map(repoKey)}</div>
              : view.loose.map(repoKey)}
          </div>

          {draft && (
            <div className="shipped-groups-edit">
              <div className="shipped-groups-list">
                {draft.map((g, i) => (
                  <span className="shipped-groups-item" key={i}>
                    <input
                      className="model-select"
                      value={g.name}
                      maxLength={40}
                      aria-label="Group name"
                      onChange={(e) => setDraft((d) => d && d.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                    <button type="button" className="btn compact" title={`Delete ${g.name || 'group'}`} onClick={() => setDraft((d) => d && d.filter((_, j) => j !== i))}>
                      <Hi icon={TrashIcon} size={13} />
                    </button>
                  </span>
                ))}
                <form className="shipped-groups-item" onSubmit={(e) => { e.preventDefault(); addGroup() }}>
                  <input className="model-select" value={newGroup} maxLength={40} placeholder="New group" onChange={(e) => setNewGroup(e.target.value)} />
                  <button type="submit" className="btn compact" title="Add group" disabled={!newGroup.trim()}><Hi icon={PlusIcon} size={13} /></button>
                </form>
              </div>
              {draft.length > 0 && (
                <div className="shipped-groups-repos">
                  {editRepos.map((r) => (
                    <label className="dev-row" key={r}>
                      <span className="dev-grow">{r}</span>
                      <select className="model-select" value={draft.findIndex((g) => g.repos.includes(r))} onChange={(e) => assign(r, Number(e.target.value))}>
                        <option value={-1}>Ungrouped</option>
                        {draft.map((g, i) => <option key={i} value={i}>{g.name || 'Untitled'}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              )}
              <div className="shipped-groups-actions">
                <button type="button" className="btn compact" onClick={() => setDraft(null)}>Cancel</button>
                <button type="button" className="btn compact primary" onClick={saveGroups} disabled={saving}>{saving ? 'Saving…' : 'Save groups'}</button>
              </div>
            </div>
          )}

          {day ? (
            <div className="shipped-day">
              <h3>{fmtDay(day.date)} · {day.count} PR{day.count === 1 ? '' : 's'}</h3>
              {day.pulls.length === 0 ? <div className="muted dev-none">Nothing merged.</div> : day.pulls.map((p: DevShippedPull) => (
                <div className="dev-row" key={p.url}>
                  <span className="activity-tip-dot" style={{ background: view.colorOf.get(p.repo) || OTHER_COLOR }} />
                  <a href={p.url} target="_blank" rel="noreferrer" className="dev-grow">{p.title}</a>
                  <span className="muted">{view.by !== 'repo' && view.groupOf.has(p.repo) ? `${view.groupOf.get(p.repo)} · ` : ''}{repoName(p.repo)} #{p.number}</span>
                  <span className="muted dev-time">{new Date(p.mergedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                </div>
              ))}
            </div>
          ) : view.total > 0 && (
            <div className="muted shipped-hint">Click a day to list its PRs. Click a repo to hide it.{groups.length ? '' : ' Edit groups puts repos together (Work, Side projects).'}</div>
          )}
        </>
      )}
    </section>
  )
}
