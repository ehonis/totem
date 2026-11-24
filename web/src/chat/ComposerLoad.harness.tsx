import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import Composer from './Composer'

// Not part of the app: scripts/composer-load.test.mjs bundles this page with the
// editor on its own chunk, holds that chunk back, and types across the moment the
// editor replaces the plain box. `window.__value` is the composer's value; `#other`
// is a field elsewhere on the page, and `__bump()` re-renders the composer.

const w = window as unknown as { __value: string; __bump: () => void }

function Harness() {
  const [value, setValue] = useState('')
  const [, bump] = useState(0)
  w.__value = value
  w.__bump = () => bump((n) => n + 1)
  return (
    <div className="vc" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <input id="other" aria-label="Another field" />
      <div className="vc-dock">
        <Composer value={value} onChange={setValue} autoFocus onSend={() => {}} onStop={() => {}} busy={false} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
