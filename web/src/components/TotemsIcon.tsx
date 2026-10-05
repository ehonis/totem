import React, { useId } from 'react'
// The logo master itself (scripts/build-logo-assets.mjs renders every logo asset
// from it), so this mark can never drift from the brand.
import logoSvg from '../../assets-src/totem-logo.svg?raw'

// The Totems tab's icon: the Totem mascot in front, with a smaller one behind it
// at the top right, so the tab reads as "your totems" rather than
// repeating the logo next to itself. Built from the logo's own path, not drawn:
// the art is white-on-black, so it is a luminance mask over a currentColor fill,
// which keeps the cut-outs see-through and lets the rail tint it like any icon.
const ART = logoSvg.replace(/<svg[^>]*>/, '').replace('</svg>', '').replace(/<rect[^>]*\/>/, '').trim()
const MAIN = 'translate(-0.6 4.2) scale(0.82)'
const SMALL = 'translate(12.2 -0.4) scale(0.5)'

export default function TotemsIcon(props: React.SVGProps<SVGSVGElement>) {
  const id = useId().replace(/:/g, '')
  const art = (transform: string, fill?: string) => (
    <g transform={transform} dangerouslySetInnerHTML={{ __html: fill ? ART.replace(/fill="#fff"/g, `fill="${fill}"`) : ART }} />
  )
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props} style={{ ...props.style, stroke: 'none' }}>
      <defs>
        <mask id={`tm-main-${id}`} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
          <rect x="-2" y="-2" width="28" height="28" fill="#000" />
          {art(MAIN)}
        </mask>
        {/* The small one stops where the main one starts, so they read as two objects. */}
        <mask id={`tm-small-${id}`} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
          <rect x="-2" y="-2" width="28" height="28" fill="#000" />
          {art(SMALL)}
          {art(MAIN, '#000')}
        </mask>
      </defs>
      <rect x="-2" y="-2" width="28" height="28" fill="currentColor" mask={`url(#tm-small-${id})`} />
      <rect x="-2" y="-2" width="28" height="28" fill="currentColor" mask={`url(#tm-main-${id})`} />
    </svg>
  )
}
