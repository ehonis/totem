// The Tasks page's glyphs that Heroicons lacks, from Tabler, imported deep and per
// icon so the package tree-shakes (AGENTS.md § Gotchas: icons are found, never drawn).
// Tabler draws at a 2px stroke; 1.5 matches the Heroicons beside them.
import React from 'react'
import IconZzz from '@tabler/icons-react/dist/esm/icons/IconZzz.mjs'
import IconRepeat from '@tabler/icons-react/dist/esm/icons/IconRepeat.mjs'
import IconCircleDot from '@tabler/icons-react/dist/esm/icons/IconCircleDot.mjs'
import IconCircleCheck from '@tabler/icons-react/dist/esm/icons/IconCircleCheck.mjs'
import IconTable from '@tabler/icons-react/dist/esm/icons/IconTable.mjs'
import IconFlagFilled from '@tabler/icons-react/dist/esm/icons/IconFlagFilled.mjs'

type SvgProps = React.SVGProps<SVGSVGElement>
type IconComponent = React.ComponentType<SvgProps>

const tabler = (Icon: IconComponent, strokeWidth = 1.5): IconComponent =>
  (props: SvgProps) => <Icon strokeWidth={strokeWidth} {...props} />

export const SnoozeIcon = tabler(IconZzz)
export const RepeatIcon = tabler(IconRepeat)
export const IssueOpenIcon = tabler(IconCircleDot, 1.75)
export const IssueClosedIcon = tabler(IconCircleCheck, 1.75)
export const SheetIcon = tabler(IconTable)
export const FlagSolidIcon = tabler(IconFlagFilled)
