/**
 * The glyph on a goal card, worked out rather than stored.
 *
 * A goal could carry an icon column and a picker, the way a job or a skill does. It
 * deliberately doesn't. A job is configured once and run for months, so choosing its
 * glyph is a fair trade; a goal is written in fifteen seconds on a Sunday and lives for
 * a week, and a picker in that flow is one more field between an intention and the
 * button. So the icon is read off what the goal already says about itself — its Strava
 * sport first, because that is the one part of a goal that is structured data, then the
 * words in its title and the things it counts.
 *
 * Being derived, the icon is a hint and never information. Everything it could tell you
 * — the sport, the source, the unit — is written on the card in words as well. If a
 * match is wrong the card is still correct; it is just wearing the wrong hat.
 */
import type { ComponentType, SVGProps } from 'react'
import {
  AcademicCapIcon, BeakerIcon, BookOpenIcon, BriefcaseIcon, BanknotesIcon, CameraIcon,
  ChatBubbleLeftRightIcon, CodeBracketIcon, FireIcon, FlagIcon, HeartIcon, HomeIcon,
  MapIcon, MoonIcon, MusicalNoteIcon, PencilSquareIcon, RocketLaunchIcon, SunIcon,
  TrophyIcon, UserGroupIcon,
} from '../icons'
import {
  BallIcon, BarbellIcon, BikeIcon, ClimbIcon, HikeIcon, PaddleIcon, RunIcon, SnowIcon,
  SPORT_OPTIONS, SwimIcon, WalkIcon, YogaIcon,
} from './sportIcons'
import type { Goal, GoalMetric, SubGoal } from './types'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

/**
 * Word → glyph, in priority order.
 *
 * Order is the whole design here: "bike ride to work" is about the bike, not the work,
 * so the sports come before the desk. Within a row the patterns are alternatives, and
 * the first row that matches anywhere in the text wins — no scoring, because a goal
 * matching two rows equally well is a coin toss either way and a predictable rule beats
 * a clever one you can't reason about at the card.
 */
const RULES: [RegExp, IconComponent][] = [
  [/\b(bike|biked|biking|bicycle|cycl\w*|ride|rides|riding|peloton|zwift)\b/, BikeIcon],
  [/\b(run|ran|runs|running|jog\w*|marathon|half|5k|10k|couch to)\b/, RunIcon],
  [/\b(swim\w*|laps?|pool)\b/, SwimIcon],
  [/\b(hike|hiked|hiking|trail|trails|backpack\w*|summit)\b/, HikeIcon],
  [/\b(climb\w*|boulder\w*|crag|belay)\b/, ClimbIcon],
  [/\b(ski|skied|skiing|snowboard\w*|slopes?|powder)\b/, SnowIcon],
  [/\b(row|rowed|rowing|paddl\w*|kayak\w*|canoe\w*|surf\w*|sail\w*)\b/, PaddleIcon],
  [/\b(lift\w*|weights?|gym|squat\w*|bench|deadlift\w*|press|reps?|sets?|crossfit)\b/, BarbellIcon],
  [/\b(yoga|stretch\w*|mobility|pilates|meditat\w*|breathwork)\b/, YogaIcon],
  [/\b(walk\w*|steps?|stroll\w*)\b/, WalkIcon],
  [/\b(soccer|football|tennis|golf|pickleball|basketball|squash|badminton|game|games|match\w*)\b/, BallIcon],
  [/\b(sleep|sleeping|bed|bedtime|rest|nap\w*)\b/, MoonIcon],
  [/\b(water|hydrat\w*|drink\w*|glasses|liters?|litres?)\b/, BeakerIcon],
  [/\b(eat\w*|diet|food|meal\w*|calor\w*|protein|cook\w*|weigh\w*|pounds?|lbs)\b/, FireIcon],
  [/\b(read\w*|book|books|chapter\w*|pages?|novel\w*)\b/, BookOpenIcon],
  [/\b(learn\w*|study\w*|course\w*|lesson\w*|class\w*|tutorial\w*|certif\w*|exam)\b/, AcademicCapIcon],
  [/\b(writ\w*|blog\w*|article\w*|essay\w*|post|posts|journal\w*|draft\w*|newsletter)\b/, PencilSquareIcon],
  [/\b(ship\w*|launch\w*|releas\w*|deploy\w*|migrat\w*|cutover|rollout)\b/, RocketLaunchIcon],
  [/\b(code|coding|pr|prs|commit\w*|refactor\w*|bug\w*|issues?|repo\w*|build\w*|test\w*)\b/, CodeBracketIcon],
  [/\b(ticket\w*|client\w*|invoice\w*|billable|timesheet\w*|meeting\w*|standup|work)\b/, BriefcaseIcon],
  [/\b(save|saved|saving\w*|invest\w*|budget\w*|spend\w*|money|dollars?|revenue|sales?)\b/, BanknotesIcon],
  [/\b(call\w*|email\w*|reply|replies|outreach|network\w*|reach out|follow up)\b/, ChatBubbleLeftRightIcon],
  [/\b(friend\w*|family|parents?|team|people|1:1|mentor\w*|date night)\b/, UserGroupIcon],
  [/\b(photo\w*|camera|film|video\w*|edit\w*|shoot\w*)\b/, CameraIcon],
  [/\b(music|guitar|piano|drum\w*|sing\w*|practice|song\w*)\b/, MusicalNoteIcon],
  [/\b(clean\w*|tidy|declutter\w*|chore\w*|laundry|garage|house|home|garden\w*|yard)\b/, HomeIcon],
  [/\b(travel\w*|trip|trips|flight\w*|visit\w*|explore|abroad)\b/, MapIcon],
  [/\b(morning|wake|sunrise|early|routine)\b/, SunIcon],
  [/\b(health\w*|doctor|dentist|therapy|heart|blood|steps to|habit\w*)\b/, HeartIcon],
]

// Taken from the picker's own list rather than restated, so the glyph on a card is
// always the one that was chosen in the composer. The "any sport" row has an empty
// value and drops out here, which is what makes `SPORT_ICONS['']` a miss.
const SPORT_ICONS: Record<string, IconComponent> = Object.fromEntries(
  SPORT_OPTIONS.filter((option) => option.value).map((option) => [option.value, option.icon]),
)

const sportOf = (metric: GoalMetric): string => {
  if (metric.sourceKind === 'strava_gear_odometer') return 'ride'
  if (metric.sourceKind !== 'strava_distance') return ''
  const sport = (metric.sourceConfig as { sport?: unknown } | null)?.sport
  return typeof sport === 'string' ? sport.trim().toLowerCase() : ''
}

/**
 * Pick the glyph for a goal.
 *
 * `fallback` is what an unrecognised goal gets — a flag on the card, since a goal with
 * no obvious subject is still a thing you have planted somewhere ahead of you.
 */
export function goalIconFor(
  goal: Pick<Goal, 'title' | 'notes' | 'metrics'> & { subGoals?: SubGoal[] },
  fallback: IconComponent = FlagIcon,
): IconComponent {
  // A configured sport is a fact, not a guess, so it outranks every keyword below —
  // including a title that happens to name a different one ("Ride to the running club").
  const metrics = [...goal.metrics, ...(goal.subGoals ?? []).flatMap((s) => s.metrics)]
  for (const metric of metrics) {
    const icon = SPORT_ICONS[sportOf(metric)]
    if (icon) return icon
  }

  // Notes are searched last and separately: they are freeform and long enough that a
  // stray word in them would otherwise outvote the title the goal is actually named for.
  const title = [goal.title, ...goal.metrics.map((m) => `${m.label} ${m.unit ?? ''}`)].join(' ').toLowerCase()
  for (const [pattern, icon] of RULES) if (pattern.test(title)) return icon

  const notes = String(goal.notes ?? '').toLowerCase()
  if (notes) for (const [pattern, icon] of RULES) if (pattern.test(notes)) return icon

  return fallback
}

/** A finished goal wears a trophy whatever it was about — the card already says done. */
export const GOAL_DONE_ICON = TrophyIcon
