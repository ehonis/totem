import React, { useEffect, useRef, useState, useCallback } from 'react'
import { getBrain, getNote, AuthError } from '../api'
import { useErrorToast } from '../toast'
import Markdown from './Markdown'

const COLORS: Record<string, string> = { folder: '#7c5cff', note: '#5b8cff', topic: '#3fb950', person: '#e3b341' }
const colorFor = (n: any) => COLORS[n.type] || '#8a91a3'
const radius = (n: any) => 4 + (n.val || 3) * 0.9

interface BrainViewProps {
  onAuthError: () => void
}

export default function BrainView({ onAuthError }: BrainViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sim = useRef<any>({ nodes: [], links: [], view: { x: 0, y: 0, scale: 1 }, hover: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<any>(null)
  useErrorToast(error)
  const [stats, setStats] = useState({ notes: 0, links: 0 })
  const [note, setNote] = useState<any>(null) // { path, markdown }

  const openNote = useCallback(async (path: string) => {
    try {
      setNote({ path, markdown: 'Loading…' })
      const n = await getNote(path)
      setNote(n)
    } catch (e: any) {
      if (e instanceof AuthError) return onAuthError()
      setNote({ path, markdown: `Could not load note: ${e.message}` })
    }
  }, [onAuthError])

  // Load graph data.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const data = await getBrain()
        if (!alive) return
        const byId = new Map()
        const w = wrapRef.current?.clientWidth || 800
        const h = wrapRef.current?.clientHeight || 600
        const nodes = data.nodes.map((n: any, i: number) => {
          const a = (i / data.nodes.length) * Math.PI * 2
          const r = 40 + (i % 9) * 26
          const node = { ...n, x: w / 2 + Math.cos(a) * r, y: h / 2 + Math.sin(a) * r, vx: 0, vy: 0 }
          byId.set(n.id, node)
          return node
        })
        const links = data.links
          .map((l: any) => ({ ...l, source: byId.get(l.source), target: byId.get(l.target) }))
          .filter((l: any) => l.source && l.target)
        sim.current.nodes = nodes
        sim.current.links = links
        setStats({ notes: nodes.filter((n: any) => n.type === 'note').length, links: links.length })
        setLoading(false)
      } catch (e: any) {
        if (!alive) return
        if (e instanceof AuthError) return onAuthError()
        setError(e.message)
        setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [onAuthError])

  // Simulation + rendering + interaction.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    let raf: number
    let dpr = window.devicePixelRatio || 1

    function resize() {
      dpr = window.devicePixelRatio || 1
      canvas.width = wrap.clientWidth * dpr
      canvas.height = wrap.clientHeight * dpr
      canvas.style.width = wrap.clientWidth + 'px'
      canvas.style.height = wrap.clientHeight + 'px'
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    function step() {
      const { nodes, links } = sim.current
      // repulsion
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          let dx = a.x - b.x, dy = a.y - b.y
          let d2 = dx * dx + dy * dy || 0.01
          const f = 1400 / d2
          const d = Math.sqrt(d2)
          const fx = (dx / d) * f, fy = (dy / d) * f
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
        }
      }
      // springs
      for (const l of links) {
        const len = l.kind === 'contains' ? 60 : 95
        let dx = l.target.x - l.source.x, dy = l.target.y - l.source.y
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01
        const f = (d - len) * 0.03
        const fx = (dx / d) * f, fy = (dy / d) * f
        l.source.vx += fx; l.source.vy += fy
        l.target.vx -= fx; l.target.vy -= fy
      }
      // gravity to center + integrate
      const cx = wrap.clientWidth / 2, cy = wrap.clientHeight / 2
      for (const n of nodes) {
        if (n.fixed) { n.vx = 0; n.vy = 0; continue }
        n.vx += (cx - n.x) * 0.003
        n.vy += (cy - n.y) * 0.003
        n.vx *= 0.86; n.vy *= 0.86
        n.x += n.vx; n.y += n.vy
      }
    }

    function draw() {
      const { nodes, links, view, hover } = sim.current
      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight)
      ctx.translate(view.x, view.y)
      ctx.scale(view.scale, view.scale)

      const neighbors = new Set()
      if (hover) {
        neighbors.add(hover.id)
        for (const l of links) {
          if (l.source === hover) neighbors.add(l.target.id)
          if (l.target === hover) neighbors.add(l.source.id)
        }
      }
      // edges
      for (const l of links) {
        const active = hover && (l.source === hover || l.target === hover)
        ctx.strokeStyle = active ? '#5b8cff99' : '#ffffff12'
        ctx.lineWidth = (active ? 1.4 : 0.6) / view.scale
        ctx.beginPath()
        ctx.moveTo(l.source.x, l.source.y)
        ctx.lineTo(l.target.x, l.target.y)
        ctx.stroke()
      }
      // nodes
      for (const n of nodes) {
        const dim = hover && !neighbors.has(n.id)
        ctx.globalAlpha = dim ? 0.25 : 1
        ctx.fillStyle = colorFor(n)
        ctx.beginPath()
        ctx.arc(n.x, n.y, radius(n), 0, Math.PI * 2)
        ctx.fill()
        if (n === hover) {
          ctx.lineWidth = 2 / view.scale
          ctx.strokeStyle = '#fff'
          ctx.stroke()
        }
        const showLabel = n.type === 'folder' || n.type === 'person' || n === hover || (view.scale > 1.3 && !dim)
        if (showLabel) {
          ctx.globalAlpha = dim ? 0.3 : 1
          ctx.fillStyle = '#cdd2de'
          ctx.font = `${(n.type === 'folder' ? 12 : 11) / view.scale}px -apple-system, sans-serif`
          ctx.fillText(n.label, n.x + radius(n) + 3 / view.scale, n.y + 3 / view.scale)
        }
        ctx.globalAlpha = 1
      }
      ctx.restore()
    }

    function loop() { step(); draw(); raf = requestAnimationFrame(loop) }
    loop()

    // ---- interaction ----
    const view = sim.current.view
    const toWorld = (mx: number, my: number) => ({ x: (mx - view.x) / view.scale, y: (my - view.y) / view.scale })
    const pick = (mx: number, my: number) => {
      const p = toWorld(mx, my)
      const { nodes } = sim.current
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        const r = radius(n) + 4
        if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= r * r) return n
      }
      return null
    }
    const rel = (e: MouseEvent) => {
      const b = canvas.getBoundingClientRect()
      return { mx: e.clientX - b.left, my: e.clientY - b.top }
    }

    let drag: any = null // { node?, lastX, lastY, moved }
    function onDown(e: MouseEvent) {
      const { mx, my } = rel(e)
      const node = pick(mx, my)
      drag = { node, lastX: mx, lastY: my, moved: 0 }
      if (node) node.fixed = true
    }
    function onMove(e: MouseEvent) {
      const { mx, my } = rel(e)
      if (!drag) { sim.current.hover = pick(mx, my); canvas.style.cursor = sim.current.hover ? 'pointer' : 'grab'; return }
      const dx = mx - drag.lastX, dy = my - drag.lastY
      drag.moved += Math.abs(dx) + Math.abs(dy)
      drag.lastX = mx; drag.lastY = my
      if (drag.node) { const p = toWorld(mx, my); drag.node.x = p.x; drag.node.y = p.y }
      else { view.x += dx; view.y += dy }
    }
    function onUp() {
      if (drag) {
        if (drag.node) {
          drag.node.fixed = false
          if (drag.moved < 5 && drag.node.type === 'note') openNote(drag.node.path)
        }
      }
      drag = null
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const { mx, my } = rel(e)
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      const ns = Math.max(0.25, Math.min(4, view.scale * factor))
      view.x = mx - (mx - view.x) * (ns / view.scale)
      view.y = my - (my - view.y) * (ns / view.scale)
      view.scale = ns
    }

    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [loading, openNote])

  return (
    <div className="brain-wrap" ref={wrapRef}>
      {error ? (
        <div className="empty">Couldn’t load your brain graph.</div>
      ) : loading ? (
        <div className="empty">Building your brain graph…</div>
      ) : (
        <>
          <canvas className="brain-canvas" ref={canvasRef} />
          <div className="brain-legend">
            <span><span className="dot" style={{ background: COLORS.folder }} />folder</span>
            <span><span className="dot" style={{ background: COLORS.note }} />note</span>
            <span><span className="dot" style={{ background: COLORS.topic }} />topic</span>
            <span><span className="dot" style={{ background: COLORS.person }} />person</span>
          </div>
          <div className="brain-hint">{stats.notes} notes · {stats.links} links · drag to pan · scroll to zoom · click a note to read</div>
          {note && (
            <div className="note-drawer">
              <button className="btn close" onClick={() => setNote(null)}>✕</button>
              <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{note.path}</div>
              <Markdown text={note.markdown} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
