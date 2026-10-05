/**
 * Sport glyphs, from Tabler.
 *
 * Heroicons — the dashboard's icon set everywhere else (see `icons.tsx`) — stops at UI
 * chrome: no bicycle, no runner, no barbell. Tabler ships all of them and draws in the
 * same language (24×24, no fill, `currentColor`, round caps), so the only adjustment is
 * pulling its 2px stroke down to Heroicons' 1.5 in `sportIcon` below. A sport sitting
 * next to a clock or a flag then looks like it belongs.
 *
 * Do NOT hand-draw these. The first version of this file was eleven SVGs written out by
 * hand; they cost a great deal to produce and were worse than what a library gives for
 * free. Go looking for an icon set before drawing anything — see AGENTS.md § Gotchas.
 *
 * Imports are deep and per-icon, which is what keeps a 6,000-icon package out of the
 * bundle and out of Vite's cold-start pre-bundling. Those files are default exports —
 * only the package root re-exports the icons by name.
 *
 * The values are the sport *families* from `strava/shape.mjs`, not `sport_type` values:
 * a goal counting rides should count the gravel ride and the trainer session too, and
 * that grouping already exists on the connector side.
 */
import React from 'react'
import { BoltIcon, SparklesIcon } from '../icons'
import IconBallFootball from '@tabler/icons-react/dist/esm/icons/IconBallFootball.mjs'
import IconBarbell from '@tabler/icons-react/dist/esm/icons/IconBarbell.mjs'
import IconBike from '@tabler/icons-react/dist/esm/icons/IconBike.mjs'
import IconKayak from '@tabler/icons-react/dist/esm/icons/IconKayak.mjs'
import IconMountain from '@tabler/icons-react/dist/esm/icons/IconMountain.mjs'
import IconRun from '@tabler/icons-react/dist/esm/icons/IconRun.mjs'
import IconSnowflake from '@tabler/icons-react/dist/esm/icons/IconSnowflake.mjs'
import IconSwimming from '@tabler/icons-react/dist/esm/icons/IconSwimming.mjs'
import IconTrekking from '@tabler/icons-react/dist/esm/icons/IconTrekking.mjs'
import IconWalk from '@tabler/icons-react/dist/esm/icons/IconWalk.mjs'
import IconYoga from '@tabler/icons-react/dist/esm/icons/IconYoga.mjs'

type SvgProps = React.SVGProps<SVGSVGElement>
type IconComponent = React.ComponentType<SvgProps>

/**
 * Wrap a Tabler icon so it renders like a Heroicon.
 *
 * Tabler's `size` prop only sets width/height attributes, which `Hi` overrides with
 * inline styles anyway — so the stroke is the one thing that actually has to change.
 */
const sportIcon = (Icon: IconComponent): IconComponent =>
  (props: SvgProps) => <Icon strokeWidth={1.5} {...props} />

export const BikeIcon = sportIcon(IconBike)
export const RunIcon = sportIcon(IconRun)
export const WalkIcon = sportIcon(IconWalk)
export const HikeIcon = sportIcon(IconTrekking)
export const SwimIcon = sportIcon(IconSwimming)
export const BarbellIcon = sportIcon(IconBarbell)
export const ClimbIcon = sportIcon(IconMountain)
export const YogaIcon = sportIcon(IconYoga)
export const SnowIcon = sportIcon(IconSnowflake)
export const PaddleIcon = sportIcon(IconKayak)
export const BallIcon = sportIcon(IconBallFootball)

export interface SportOption {
  /** What goes into `sourceConfig.sport`. Empty string means "don't filter". */
  value: string
  label: string
  icon: IconComponent
}

/**
 * The picker's list, in the order a person is likely to want them.
 *
 * "Any sport" is first and is the default, because a goal that says "50 miles" usually
 * means 50 miles of the thing you already do, and making the filter mandatory would turn
 * the common case into two decisions.
 */
export const SPORT_OPTIONS: SportOption[] = [
  { value: '', label: 'Any sport', icon: SparklesIcon },
  { value: 'ride', label: 'Cycling', icon: BikeIcon },
  { value: 'run', label: 'Running', icon: RunIcon },
  { value: 'walk', label: 'Walking', icon: WalkIcon },
  { value: 'hike', label: 'Hiking', icon: HikeIcon },
  { value: 'swim', label: 'Swimming', icon: SwimIcon },
  { value: 'lift', label: 'Lifting', icon: BarbellIcon },
  { value: 'climbing', label: 'Climbing', icon: ClimbIcon },
  { value: 'mobility', label: 'Yoga & mobility', icon: YogaIcon },
  { value: 'ski', label: 'Snow sports', icon: SnowIcon },
  { value: 'water', label: 'Water sports', icon: PaddleIcon },
  { value: 'sport', label: 'Ball sports', icon: BallIcon },
  { value: 'other', label: 'Other workouts', icon: BoltIcon },
]
