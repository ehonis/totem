import React, { useId } from 'react'
// The small-size logo master (scripts/build-logo-assets.mjs renders the 32px favicon
// from it), so this mark can never drift from the brand.
import logoSvg from '../../assets-src/totem-logo-small.svg?raw'

// The Totems tab's icon: the Totem mascot in front, with a smaller one behind it
// at the top right, so the tab reads as "your totems" rather than
// repeating the logo next to itself. Built from the logo's own art, not drawn:
// the art is white-on-black, so it is a luminance mask over a currentColor fill,
// which keeps the cut-outs see-through and lets the rail tint it like any icon.
const ART = logoSvg.replace(/<svg[^>]*>/, '').replace('</svg>', '').replace(/<rect[^>]*\/>/, '').trim()
// The front mascot in solid black with its outline stroke widened, so it cuts a
// moat out of the one behind: the wide wings would otherwise run into it.
const KNOCKOUT = ART.replace(/(fill|stroke)="#fff"/g, '$1="#000"').replace(/stroke-width="6"/g, 'stroke-width="16"')
const MAIN = 'translate(-1.4 5) scale(0.8)'
const SMALL = 'translate(13 -0.2) scale(0.46)'

export default function TotemsIcon(props: React.SVGProps<SVGSVGElement>) {
  const id = useId().replace(/:/g, '')
  const art = (transform: string, html = ART) => <g transform={transform} dangerouslySetInnerHTML={{ __html: html }} />
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props} style={{ ...props.style, stroke: 'none' }}>
      <defs>
        <mask id={`tm-main-${id}`} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
          <rect x="-2" y="-2" width="28" height="28" fill="#000" />
          {art(MAIN)}
        </mask>
        {/* The small one stops short of the main one, so they read as two objects. */}
        <mask id={`tm-small-${id}`} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
          <rect x="-2" y="-2" width="28" height="28" fill="#000" />
          {art(SMALL)}
          {art(MAIN, KNOCKOUT)}
        </mask>
      </defs>
      <rect x="-2" y="-2" width="28" height="28" fill="currentColor" mask={`url(#tm-small-${id})`} />
      <rect x="-2" y="-2" width="28" height="28" fill="currentColor" mask={`url(#tm-main-${id})`} />
    </svg>
  )
}
