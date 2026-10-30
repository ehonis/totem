// "Chat about this": what a card shows, as short text for the agent. Each card has
// a serializer here, so a card's own edit is one line; `contextMarkdown` adds the
// page, its route and the files that draw it (places.ts), and caps the length,
// because all of it lands in the prompt.
// mobile/src/lib/chat/about/context.ts is a byte-for-byte copy (places.test.ts checks).
import { PLACES, type Place, type PlaceId } from './places'
import { dueDiff } from '../../components/overview/time'

export interface ChatContext {
  place: PlaceId
  /** What the card is, e.g. "Goal: Run 30 miles". */
  title: string
  /** What it shows, one fact per line. */
  lines: string[]
  /** A more exact address than the place's own (a machine's /fleet#id). */
  route?: string
}

const MAX_LINES = 40
const MAX_CHARS = 3000
const MAX_LINE = 300

const clip = (s: string | null | undefined, n = 160) => {
  // Cut before collapsing whitespace: a megabyte line is never scanned whole.
  const t = String(s ?? '').slice(0, n * 2 + 64).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const num = (n: number | null | undefined, digits = 1) =>
  n == null || !Number.isFinite(n) ? '–' : String(Math.round(n * 10 ** digits) / 10 ** digits)
const pct = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n)}%`)
const pad2 = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`

/**
 * Tokens out of anything a card shows: a key pasted into a task note must not
 * reach the prompt or the saved upload. The bridge's redact() patterns, plus
 * Google's ya29. access tokens and fine-grained GitHub tokens.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[redacted github token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted github token]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted api key]')
    .replace(/\bya29\.[A-Za-z0-9._-]{20,}/g, '[redacted google token]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|AUTH|COOKIE|SESSION)[A-Z0-9_]*)=([^\s"'`&]+)/gi, '$1=[redacted]')
}

/** The attachment's text: where it came from, then what it shows. */
export function contextMarkdown(ctx: ChatContext, at = new Date()): string {
  const place: Place = PLACES[ctx.place]
  const head = [
    `# ${clip(ctx.title, 120)}`,
    '',
    `The owner started this chat from a card in Totem. What it showed at ${stamp(at)}:`,
    '',
  ]
  // Every line is clipped, so one long line costs at most MAX_LINE and the facts
  // after it still fit.
  const body: string[] = []
  let size = 0
  for (let i = 0; i < ctx.lines.length; i++) {
    const line = clip(ctx.lines[i], MAX_LINE)
    if (!line) continue
    if (body.length >= MAX_LINES || size + line.length > MAX_CHARS) {
      body.push(`… ${ctx.lines.length - i} more not shown`)
      break
    }
    body.push(line)
    size += line.length + 1
  }
  if (!body.length) body.push('(nothing on it)')
  const files = (list?: string[]) => (list || []).map((f) => `\`${f}\``).join(', ')
  const foot = [
    '',
    '## Where it lives',
    `- Page: ${place.label}, ${clip(ctx.route || place.route, 200)}`,
    `- Drawn by: ${files(place.web)}`,
    ...(place.app?.length ? [`- In the iPhone app: ${files(place.app)}`] : []),
    ...(place.data?.length ? [`- Data: ${files(place.data)}`] : []),
  ]
  return redact([...head, ...body, ...foot].join('\n')) + '\n'
}

/** A file name for the attachment chip. */
export function contextFileName(ctx: ChatContext): string {
  const slug = redact(ctx.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
  return `${slug || ctx.place.replace(/\W+/g, '-')}.md`
}

// ---------------------------------------------------------------------------
// Tasks

interface TaskLike {
  title?: string; content?: string; status?: string; priority?: number | null
  due?: string | null; dueDate?: string | null
}
const PRIORITY: Record<number, string> = { 4: 'P1', 3: 'P2', 2: 'P3' }

function dueText(due: string | null | undefined): string {
  if (!due) return ''
  const diff = dueDiff(due)
  return `due ${due.slice(0, 16)}${diff < 0 ? ', overdue' : diff === 0 ? ', today' : ''}`
}

export function taskLine(t: TaskLike): string {
  const bits = [PRIORITY[t.priority || 1], dueText(t.due ?? t.dueDate), t.status && t.status !== 'todo' ? t.status : '']
    .filter(Boolean)
  return `- ${clip(t.title ?? t.content, 120)}${bits.length ? ` (${bits.join('; ')})` : ''}`
}

/** Overview's Tasks card: what is due, or what is next. */
export function tasksContext(tasks: TaskLike[], { open, overdue }: { open: number; overdue: number }): ChatContext {
  return {
    place: 'overview.tasks',
    title: 'Overview: Tasks',
    lines: [`${open} open, ${overdue} overdue. Shown:`, ...tasks.map(taskLine)],
  }
}

interface TodoLike extends TaskLike {
  id: string; title: string; description?: string; area?: string; ventureTag?: string | null
  recurrence?: string | null; snoozedUntil?: string | null; outcome?: string | null
  tags?: { name: string }[]; notes?: { body: string; createdAt: string }[]
  lists?: { title: string }[]; externalLinks?: { connector: string; externalUrl: string | null }[]
}

/** One task on the board. */
export function todoContext(t: TodoLike): ChatContext {
  const where = t.area === 'Ventures' && t.ventureTag ? `Ventures · ${clip(t.ventureTag, 60)}` : clip(t.area, 60)
  return {
    place: 'todos',
    title: `Task: ${t.title}`,
    lines: [
      `Task id ${t.id}. Status ${t.status || 'todo'}${t.outcome ? ` (${t.outcome})` : ''}${where ? `, ${where}` : ''}${PRIORITY[t.priority || 1] ? `, ${PRIORITY[t.priority || 1]}` : ''}.`,
      ...(t.dueDate ? [`${dueText(t.dueDate).replace(/^due/, 'Due')}${t.recurrence ? `, repeats ${t.recurrence}` : ''}.`] : []),
      ...(t.snoozedUntil ? [`Snoozed until ${t.snoozedUntil}.`] : []),
      ...(t.tags?.length ? [`Tags: ${t.tags.map((x) => x.name).join(', ')}.`] : []),
      ...(t.description ? [`Description: ${clip(t.description, 600)}`] : []),
      ...(t.notes || []).slice(-3).map((n) => `Note (${n.createdAt.slice(0, 10)}): ${clip(n.body, 240)}`),
      ...(t.lists?.length ? [`On lists: ${t.lists.map((l) => l.title).join(', ')}.`] : []),
      ...(t.externalLinks || []).map((l) => `Linked: ${l.connector}${l.externalUrl ? ` ${l.externalUrl}` : ''}`),
    ],
  }
}

// ---------------------------------------------------------------------------
// Goals

interface MetricLike { label: string; unit: string | null; targetValue: number; value: number | null; available?: boolean; unavailableReason?: string | null }
interface GoalLike {
  id?: string; title: string; notes?: string; complete?: boolean; abandoned?: boolean
  period?: { label: string }; periodState?: string; daysLeft?: number; postponedCount?: number
  metrics?: MetricLike[]
  subGoals?: { title: string | null; complete: boolean; abandoned?: boolean; metrics?: MetricLike[] }[]
  links?: { label: string; url: string | null }[]
  progress?: { percent: number | null; subGoalsDone?: number; subGoalsTotal?: number }
}

const metricText = (m: MetricLike) => m.available === false || m.value == null
  ? `${m.label}: unreadable${m.unavailableReason ? ` (${clip(m.unavailableReason, 80)})` : ''}, target ${num(m.targetValue)}${m.unit ? ` ${m.unit}` : ''}`
  : `${m.label}: ${num(m.value)} of ${num(m.targetValue)}${m.unit ? ` ${m.unit}` : ''}`

const goalState = (g: GoalLike) => (g.complete ? 'done' : g.abandoned ? 'not doing' : pct(g.progress?.percent ?? 0))

/** Overview's Goals card. */
export function goalsContext(groups: { label: string; goals: GoalLike[] }[]): ChatContext {
  return {
    place: 'overview.goals',
    title: 'Overview: Goals',
    lines: groups.flatMap((g) => [
      `${g.label}:`,
      ...g.goals.map((x) => `- ${clip(x.title, 100)} (${goalState(x)}${x.progress?.subGoalsTotal ? `, ${x.progress.subGoalsDone} of ${x.progress.subGoalsTotal} steps` : ''})`),
    ]),
  }
}

/** One goal card. */
export function goalContext(g: GoalLike): ChatContext {
  return {
    place: 'goals',
    title: `Goal: ${g.title}`,
    lines: [
      `${g.id ? `Goal id ${g.id}. ` : ''}${g.period?.label || ''}${g.periodState && g.periodState !== 'active' ? ` (${g.periodState})` : ''}, ${goalState(g)}${g.daysLeft != null && !g.complete ? `, ${g.daysLeft} days left` : ''}.`,
      ...(g.postponedCount ? [`Postponed ${g.postponedCount} times.`] : []),
      ...(g.notes ? [`Notes: ${clip(g.notes, 400)}`] : []),
      ...(g.metrics || []).map((m) => `- ${metricText(m)}`),
      ...(g.subGoals || []).map((s) => `- [${s.complete ? 'x' : s.abandoned ? '-' : ' '}] ${clip(s.title || 'Untitled step', 100)}${s.metrics?.length ? ` (${s.metrics.map(metricText).join('; ')})` : ''}`),
      ...(g.links || []).map((l) => `Link: ${clip(l.label, 80)}${l.url ? ` ${l.url}` : ''}`),
    ],
  }
}

// ---------------------------------------------------------------------------
// Habits

interface HabitLike {
  id: string; name: string; description?: string; cadence: string; target: number
  linkedApp?: string | null; metric?: { label: string; unit?: string | null } | null
}
interface EntryLike { count?: number; note?: string; value?: number | null; skipped?: boolean }
type Entries = Record<string, Record<string, EntryLike | undefined> | undefined>

const isoDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
function daysBack(today: string, n: number): string[] {
  const [y, m, d] = today.split('-').map(Number)
  return Array.from({ length: n }, (_, i) => isoDay(new Date(y, m - 1, d - i)))
}
const cadenceNoun = (c: string) => (c === 'weekly' ? 'week' : c === 'monthly' ? 'month' : 'day')

/** Overview's Habits card: today's state of each. */
export function habitsContext(habits: HabitLike[], entries: Entries, day: string, periodCount: (h: HabitLike) => number): ChatContext {
  return {
    place: 'overview.habits',
    title: 'Overview: Habits',
    lines: [`Today is ${day}.`, ...habits.map((h) => {
      const e = entries[day]?.[h.id]
      const total = periodCount(h)
      return `- ${h.name}: ${total} of ${h.target} this ${cadenceNoun(h.cadence)}${total >= h.target ? ' (done)' : ''}${e?.value != null && h.metric ? `, ${h.metric.label} ${num(e.value)}` : ''}${e?.note ? `. Note: ${clip(e.note, 120)}` : ''}`
    })],
  }
}

/** One habit's card: its rule and its last two weeks. */
export function habitContext(h: HabitLike, entries: Entries, today: string, { streak, periodCount }: { streak?: number; periodCount?: number } = {}): ChatContext {
  const days = daysBack(today, 14).map((d) => {
    const e = entries[d]?.[h.id]
    const mark = e?.skipped ? 'no' : e?.count ? String(e.count) : '0'
    return `${d.slice(5)} ${mark}${e?.value != null && h.metric ? ` (${num(e.value)})` : ''}`
  })
  return {
    place: 'habits',
    title: `Habit: ${h.name}`,
    lines: [
      `Habit id ${h.id}. Target ${h.target} per ${cadenceNoun(h.cadence)}${periodCount != null ? `, ${periodCount} so far this ${cadenceNoun(h.cadence)}` : ''}${streak ? `, streak ${streak}` : ''}.`,
      ...(h.description ? [`Description: ${clip(h.description, 300)}`] : []),
      ...(h.linkedApp ? [`Logged by ${h.linkedApp}, not by hand.`] : []),
      ...(h.metric ? [`Tracks ${h.metric.label}${h.metric.unit ? ` (${h.metric.unit})` : ''}.`] : []),
      `Last 14 days, newest first: ${days.join(', ')}.`,
      ...daysBack(today, 14).flatMap((d) => (entries[d]?.[h.id]?.note ? [`Note ${d}: ${clip(entries[d]![h.id]!.note, 160)}`] : [])).slice(0, 5),
    ],
  }
}

/** A pinned number on the Overview: its last month of values. */
export function habitMetricContext(h: HabitLike, entries: Entries, today: string): ChatContext {
  const values = daysBack(today, 30).flatMap((d) => {
    const v = entries[d]?.[h.id]?.value
    return v == null ? [] : [`${d.slice(5)} ${num(v)}`]
  })
  return {
    place: 'overview.metric',
    title: `${h.metric?.label || h.name} (from ${h.name})`,
    lines: [
      `Unit: ${h.metric?.unit || 'none'}. Last 30 days, newest first:`,
      values.length ? values.join(', ') : '(no values logged)',
    ],
  }
}

// ---------------------------------------------------------------------------
// Fleet

interface DeviceLike {
  id: string; name: string; os: string | null; online: boolean; lastSeen: number | null; bootedAt: number | null
  cpuModel?: string | null; cores?: number | null
  uptime: { pct24h: number | null; pct7d: number | null; pct30d: number | null }
  health: { level: string; issues: { text: string }[] }
  now: null | { cpu: number; load: number[]; mem: { used: number; total: number }; temps: Record<string, number | undefined>; watts: number | null; measured: string }
  energy: { todayCost: number | null; monthCost: number | null; projectedMonthCost: number | null }
  detail?: null | {
    disks: { mount: string; size: number; used: number }[]
    gpu: null | { name: string; usage: number; watts: number }
    processes: { name: string; cpu: number; mem: number }[] | null
  }
}
const gb = (b: number) => `${num(b / 1e9)} GB`
const money = (n: number | null | undefined) => (n == null ? '–' : `$${n.toFixed(2)}`)
const hoursAgo = (ts: number, now: number) => `${num((now - ts) / 3600000)} h ago`

/** A machine's card, and with `detail` its whole page. */
export function fleetDeviceContext(d: DeviceLike, now = Date.now()): ChatContext {
  const n = d.now
  const temps = n ? Object.entries(n.temps).filter(([, v]) => v != null).map(([k, v]) => `${k} ${num(v)}°C`) : []
  const x = d.detail
  return {
    place: d.detail !== undefined ? 'fleet.device' : 'fleet',
    route: `/fleet#${encodeURIComponent(d.id)}`,
    title: `Machine: ${d.name}`,
    lines: [
      `${d.os || 'Unknown OS'}${d.cpuModel ? `, ${d.cpuModel}` : ''}${d.cores ? `, ${d.cores} cores` : ''}. Health ${d.health.level}.`,
      d.online
        ? `Online${d.bootedAt ? `, booted ${hoursAgo(d.bootedAt, now)}` : ''}.`
        : `Offline, last seen ${d.lastSeen ? hoursAgo(d.lastSeen, now) : 'never'}.`,
      `Uptime ${pct(d.uptime.pct24h)} 24h, ${pct(d.uptime.pct7d)} 7d, ${pct(d.uptime.pct30d)} 30d.`,
      ...(n ? [
        `CPU ${pct(n.cpu)}, load ${n.load.map((l) => num(l, 2)).join(' ')}; memory ${gb(n.mem.used)} of ${gb(n.mem.total)}.`,
        `Power ${n.watts == null ? '–' : `${num(n.watts)} W`} (${n.measured})${temps.length ? `; ${temps.join(', ')}` : ''}.`,
      ] : []),
      `Energy cost ${money(d.energy.todayCost)} today, ${money(d.energy.monthCost)} this month, ${money(d.energy.projectedMonthCost)} projected.`,
      ...d.health.issues.map((i) => `Issue: ${clip(i.text, 160)}`),
      ...(x?.disks || []).map((k) => `Disk ${k.mount}: ${gb(k.used)} of ${gb(k.size)} (${pct(k.size ? (k.used / k.size) * 100 : null)}).`),
      ...(x?.gpu ? [`GPU ${x.gpu.name}: ${pct(x.gpu.usage)}, ${num(x.gpu.watts)} W.`] : []),
      ...(x?.processes?.length ? [`Top processes: ${[...x.processes].sort((a, b) => b.cpu - a.cpu).slice(0, 5).map((p) => `${p.name} ${pct(p.cpu)} CPU`).join(', ')}.`] : []),
    ],
  }
}

// ---------------------------------------------------------------------------
// Dev

interface RepoLike {
  repo: string; defaultBranch?: string; aiReview: string | null; error?: string; runnersError?: string
  ci: { workflow: string; state: string; conclusion: string | null; url: string }[]
  prs: { number: number; title: string; draft: boolean; checks: string; claude: string; url: string }[]
  runners: { name: string; status: string; busy: boolean }[]
}

/** One repository's card on the Dev tab. */
export function devRepoContext(r: RepoLike): ChatContext {
  return {
    place: 'dev.repo',
    title: `Repository: ${r.repo}`,
    lines: [
      `github.com/${r.repo}, default branch ${r.defaultBranch || 'main'}, AI review ${r.aiReview || 'not set up'}.`,
      ...(r.error ? [`Error: ${clip(r.error, 200)}`] : []),
      ...r.ci.map((c) => `CI ${c.workflow}: ${c.conclusion || c.state} ${c.url}`),
      ...(r.prs.length ? ['Open pull requests:'] : ['No open pull requests.']),
      ...r.prs.map((p) => `- #${p.number} ${clip(p.title, 100)}${p.draft ? ' (draft)' : ''}: checks ${p.checks}, AI review ${p.claude} ${p.url}`),
      ...r.runners.map((x) => `Runner ${x.name}: ${x.status}${x.busy ? ', busy' : ''}`),
      ...(r.runnersError ? [`Runners: ${clip(r.runnersError, 160)}`] : []),
    ],
  }
}

/** The Dev tab's "PRs per day" card. */
export function shippedContext(data: { days: number; pulls: { repo: string; number: number; title: string; mergedAt: string }[]; hidden?: string[] }): ChatContext {
  const shown = data.pulls.filter((p) => !data.hidden?.includes(p.repo))
  const byRepo = new Map<string, number>()
  for (const p of shown) byRepo.set(p.repo, (byRepo.get(p.repo) || 0) + 1)
  return {
    place: 'dev.shipped',
    title: `Shipped: last ${data.days} days`,
    lines: [
      `${shown.length} merged pull requests in the last ${data.days} days.`,
      `By repository: ${[...byRepo].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ') || 'none'}.`,
      'Latest:',
      ...[...shown].sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1)).slice(0, 15)
        .map((p) => `- ${p.mergedAt.slice(0, 10)} ${p.repo}#${p.number} ${clip(p.title, 90)}`),
    ],
  }
}

// ---------------------------------------------------------------------------
// Overview: schedule and the system tiles

interface EventLike { title: string; start: string; end?: string | null; allDay?: boolean; location?: string | null }
const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

function eventLine(ev: EventLike, now: Date): string {
  if (ev.allDay) return `- All day: ${clip(ev.title, 120)}`
  const start = new Date(ev.start), end = new Date(ev.end || ev.start)
  const when = end <= now ? ' (over)' : start <= now ? ' (now)' : ''
  return `- ${hm(start)}–${hm(end)} ${clip(ev.title, 120)}${ev.location ? ` @ ${clip(ev.location, 80)}` : ''}${when}`
}

/** Overview's Schedule card: today, and tomorrow when it shows. */
export function scheduleContext({ allDay, timed, tomorrow }: { allDay: EventLike[]; timed: EventLike[]; tomorrow: EventLike[] }, now = new Date()): ChatContext {
  return {
    place: 'overview.schedule',
    title: 'Overview: Schedule',
    lines: [
      `Today, ${isoDay(now)}, at ${hm(now)}:`,
      ...[...allDay, ...timed].map((ev) => eventLine(ev, now)),
      ...(!allDay.length && !timed.length ? ['Nothing on the calendar today.'] : []),
      ...(tomorrow.length ? ['Tomorrow:', ...tomorrow.map((ev) => eventLine(ev, now))] : []),
    ],
  }
}

/** Overview's AI limits, Jobs and Activity tiles. */
export function systemContext(sys: {
  quotas: { name: string; label?: string | null; remainingPct?: number | null }[]
  jobsOn: number; jobsTotal: number
  failing: { name: string; error?: string | null }[]
  nextJob?: { name: string; nextRunAt: number } | null
  requestsToday?: number | null
}): ChatContext {
  return {
    place: 'overview.system',
    title: 'Overview: AI limits, jobs and activity',
    lines: [
      ...(sys.quotas.length ? ['AI limits, tightest window per account:'] : ['AI limits: unavailable.']),
      ...sys.quotas.map((q) => `- ${clip(q.name, 60)}: ${q.remainingPct == null ? 'no reading' : `${pct(q.remainingPct)} of ${clip(q.label || 'its window', 40).toLowerCase()} left`}`),
      `Jobs: ${sys.jobsOn} of ${sys.jobsTotal} on, ${sys.failing.length} failing.`,
      ...sys.failing.map((j) => `- Failing: ${clip(j.name, 80)}${j.error ? `: ${clip(j.error, 160)}` : ''}`),
      ...(sys.nextJob ? [`Next job: ${clip(sys.nextJob.name, 80)} at ${stamp(new Date(sys.nextJob.nextRunAt))}.`] : []),
      ...(sys.requestsToday != null ? [`AI requests today: ${sys.requestsToday}.`] : []),
    ],
  }
}

// ---------------------------------------------------------------------------
// Settings

/**
 * The Settings panes "Chat about this" is offered on. Logs, Connections, Skills
 * and Jobs are left out: they show tool output, server addresses, sign-in links
 * and prompts, none of which belongs in a chat by accident.
 */
export const SETTINGS_ABOUT = ['general', 'chat', 'ai', 'integrations', 'tasks', 'providers', 'shortcuts', 'notifications', 'voice'] as const

/** A pane as its headings and setting labels with their on/off or picked state; never a field's value. */
export interface SettingsOutline {
  items: ({ heading: string } | { label: string; state?: string | null })[]
}

export function settingsContext(sub: string, outline: SettingsOutline): ChatContext | null {
  if (!(SETTINGS_ABOUT as readonly string[]).includes(sub)) return null
  const place = `settings.${sub}` as PlaceId
  return {
    place,
    title: PLACES[place].label,
    lines: outline.items.map((it) => ('heading' in it
      ? `${clip(it.heading, 100)}:`
      : `- ${clip(it.label, 100)}${it.state ? `: ${clip(it.state, 60)}` : ''}`)),
  }
}
