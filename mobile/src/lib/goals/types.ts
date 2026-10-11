// Typed mirror of the goal DTO the bridge returns (goals/service.mjs). Dates stay
// date-only strings, exactly as `todos/types.ts` keeps due dates.

export type GoalPeriodType = 'week' | 'month' | 'quarter' | 'year' | 'custom'
export type GoalPeriodShortcut =
  | 'last_week' | 'this_week' | 'next_week'
  | 'last_month' | 'this_month' | 'next_month'
  | 'last_quarter' | 'this_quarter' | 'next_quarter'
  | 'last_year' | 'this_year' | 'next_year'
/**
 * What a list read may ask for: a shortcut the server resolves from its clock, or the
 * period of a type containing a given day. The second form is how the ‹ › arrows walk
 * to an older week: they hand back the day just outside the window they are showing,
 * so the client never has to know where a week starts.
 */
export type GoalPeriodQuery = GoalPeriodShortcut | { type: GoalPeriodType; start: string }
export type GoalPeriodState = 'upcoming' | 'active' | 'expired'
export type GoalMetricSource = 'manual' | 'strava_distance' | 'strava_gear_odometer'
export type GoalLinkKind = 'todo' | 'url'

export interface GoalPeriod {
  type: GoalPeriodType
  start: string
  end: string
  key: string
  label: string
}

export interface GoalMetric {
  id: string
  goalId: string
  label: string
  unit: string | null
  targetValue: number
  /** What was logged against this metric directly. Null when its source cannot be read. */
  ownValue: number | null
  /** Everything rolling up into it. Null when unreadable. */
  rolledUpValue: number | null
  /** `ownValue + rolledUpValue` — the number to show. Null when unreadable. */
  value: number | null
  fraction: number | null
  percent: number | null
  rollsUpToMetricId: string | null
  feederCount: number
  unreadableFeederCount: number
  sourceKind: GoalMetricSource
  sourceConfig: Record<string, unknown>
  sourceLabel: string
  /**
   * False when a connector-fed number could not be read. The UI must say so rather
   * than draw a zero bar — zero looks exactly like data and isn't.
   */
  available: boolean
  unavailableReason: string | null
  readAt: string | null
  position: number
}

export interface GoalLinkTodo {
  id: string
  title: string
  status: string
  dueDate: string | null
  completedAt: string | null
}

export interface GoalLink {
  id: string
  kind: GoalLinkKind
  label: string
  url: string | null
  todoId: string | null
  /** Read live from the task table, so a renamed task renders renamed. */
  todo: GoalLinkTodo | null
  position: number
}

export interface SubGoal {
  id: string
  parentId: string
  title: string | null
  notes: string
  completedAt: string | null
  complete: boolean
  /**
   * Decided against on its own — the add-on to a goal he knows he is not getting to,
   * while the goal itself still happened. It leaves the steps fraction rather than
   * holding the goal under 100%, and reads crossed off rather than disappearing.
   */
  abandonedAt: string | null
  abandoned: boolean
  position: number
  metrics: GoalMetric[]
  progress: { fraction: number | null; percent: number | null }
}

export interface Goal {
  id: string
  clientKey: string | null
  title: string
  notes: string
  period: GoalPeriod
  periodState: GoalPeriodState
  daysLeft: number
  completedAt: string | null
  complete: boolean
  /** Resolved by decision rather than by doing it; reversible. */
  abandonedAt: string | null
  abandoned: boolean
  /** Never reset. Three or more is the sign of something quietly abandoned. */
  postponedCount: number
  position: number
  createdAt: string
  updatedAt: string
  metrics: GoalMetric[]
  subGoals: SubGoal[]
  links: GoalLink[]
  progress: {
    fraction: number | null
    percent: number | null
    /** Steps still in play — an abandoned one is not in this total. */
    subGoalsDone: number
    subGoalsTotal: number
    subGoalsAbandoned: number
    complete: boolean
  }
}

export interface GoalReview {
  period: GoalPeriod
  today: string
  daysLeft: number
  total: number
  completed: number
  open: number
  expiring: Goal[]
  expired: Goal[]
  repeatedlyPostponed: Goal[]
  goals: Goal[]
}

export interface GoalOptions {
  periods: GoalPeriodShortcut[]
  units: Record<string, string[]>
  allUnits: string[]
  sources: GoalMetricSource[]
  measures: string[]
  /** The sport families a `strava_distance` metric may filter by. */
  sports?: string[]
  /**
   * Which `sport_type` values each family covers — "run" is the trail run and the
   * treadmill run too. Sent so the editor can show a metric stored against an exact
   * sport type under the right family instead of as "Any sport".
   */
  sportFamilies?: Record<string, string[]>
}

export interface NewMetricInput {
  label: string
  unit?: string | null
  targetValue: number
  currentValue?: number
  sourceKind?: GoalMetricSource
  sourceConfig?: Record<string, unknown>
  /** On a step's number only, and only inside a `POST /api/goals` payload: the exact
   *  label of the parent number it feeds. */
  rollsUpTo?: string
  /** On a step's number only: the id of the parent goal's metric it feeds. */
  rollsUpToMetricId?: string
}

/** What `PATCH /api/goals/metrics` accepts beyond a value or a delta. */
export interface GoalMetricPatch {
  label?: string
  unit?: string | null
  targetValue?: number
  sourceKind?: GoalMetricSource
  sourceConfig?: Record<string, unknown>
  /** Feed a number on the parent goal, or null to let it stand alone. Steps only. */
  rollsUpToMetricId?: string | null
}

/**
 * A round of metric edits, as a diff rather than a form.
 *
 * Each list maps onto one endpoint, and anything left untouched appears in none of
 * them — see `GoalNumbers` for why sending the whole form back would be wrong.
 */
export interface GoalMetricChanges {
  added: NewMetricInput[]
  updated: { id: string; patch: GoalMetricPatch }[]
  removed: string[]
}

export interface NewGoalInput {
  title: string
  notes?: string
  period?: GoalPeriodShortcut
  metrics?: NewMetricInput[]
  subGoals?: { title?: string; metrics?: NewMetricInput[] }[]
}

/** "12 / 40 miles", matching goals/units.mjs so both sides round the same way. */
export function formatAmount(value: number, unit: string | null): string {
  const text = String(Math.round(value * 100) / 100)
  return unit ? `${text} ${unit}` : text
}

export const PERIOD_LABELS: Record<GoalPeriodShortcut, string> = {
  last_week: 'Last week',
  last_month: 'Last month',
  last_quarter: 'Last quarter',
  last_year: 'Last year',
  this_week: 'This week',
  next_week: 'Next week',
  this_month: 'This month',
  next_month: 'Next month',
  this_quarter: 'This quarter',
  next_quarter: 'Next quarter',
  this_year: 'This year',
  next_year: 'Next year',
}
