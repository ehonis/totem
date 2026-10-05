import React, { useEffect, useRef, useMemo } from 'react'

const COLORS: Record<string, string> = { folder: '#7c5cff', note: '#5b8cff', topic: '#3fb950', person: '#e3b341' }
const colorFor = (n: any) => COLORS[n.type] || '#8a91a3'

interface Layout {
  nodes: any[]
  links: any[]
}

// Run the same force layout as the full Brain view, but synchronously to a settled
// state - no animation, no interaction. Deterministic initial placement so the map
// looks the same each render.
function computeLayout(rawNodes: any[], rawLinks: any[]): Layout {
  const W = 600, H = 400
  const byId = new Map<any, any>()
  const nodes = rawNodes.map((n, i) => {
    const a = (i / Math.max(1, rawNodes.length)) * Math.PI * 2
    const r = 40 + (i % 9) * 26
    const node = { ...n, x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0 }
    byId.set(n.id, node)
    return node
  })
  const links = rawLinks
    .map((l) => ({ ...l, source: byId.get(l.source), target: byId.get(l.target) }))
    .filter((l) => l.source && l.target)

  for (let iter = 0; iter < 320; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      const A = nodes[i]
      for (let j = i + 1; j < nodes.length; j++) {
        const B = nodes[j]
        let dx = A.x - B.x, dy = A.y - B.y
        const d2 = dx * dx + dy * dy || 0.01
        const f = 1400 / d2
        const d = Math.sqrt(d2)
        const fx = (dx / d) * f, fy = (dy / d) * f
        A.vx += fx; A.vy += fy; B.vx -= fx; B.vy -= fy
      }
    }
    for (const l of links) {
      const len = l.kind === 'contains' ? 60 : 95
      let dx = l.target.x - l.source.x, dy = l.target.y - l.source.y
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const f = (d - len) * 0.03
      const fx = (dx / d) * f, fy = (dy / d) * f
      l.source.vx += fx; l.source.vy += fy
      l.target.vx -= fx; l.target.vy -= fy
    }
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.003
      n.vy += (H / 2 - n.y) * 0.003
      n.vx *= 0.86; n.vy *= 0.86
      n.x += n.vx; n.y += n.vy
    }
  }
  return { nodes, links }
}

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, layout: Layout) {
  ctx.clearRect(0, 0, w, h)
  if (!layout.nodes.length) return
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of layout.nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y)
  }
  const pad = 18
  const gw = maxX - minX || 1, gh = maxY - minY || 1
  const scale = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh)
  const ox = (w - gw * scale) / 2 - minX * scale
  const oy = (h - gh * scale) / 2 - minY * scale
  const tx = (x: number) => x * scale + ox
  const ty = (y: number) => y * scale + oy

  ctx.strokeStyle = '#ffffff16'
  ctx.lineWidth = 0.7
  for (const l of layout.links) {
    ctx.beginPath()
    ctx.moveTo(tx(l.source.x), ty(l.source.y))
    ctx.lineTo(tx(l.target.x), ty(l.target.y))
    ctx.stroke()
  }
  for (const n of layout.nodes) {
    const r = Math.max(2, 2 + (n.val || 3) * 0.45)
    ctx.fillStyle = colorFor(n)
    ctx.beginPath()
    ctx.arc(tx(n.x), ty(n.y), r, 0, Math.PI * 2)
    ctx.fill()
  }
}

interface BrainMiniMapProps {
  nodes?: any[]
  links?: any[]
  height?: number
}

export default function BrainMiniMap({ nodes = [], links = [], height = 170 }: BrainMiniMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layout = useMemo(() => computeLayout(nodes, links), [nodes, links])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const render = () => {
      const dpr = window.devicePixelRatio || 1
      const w = wrap.clientWidth, h = wrap.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paint(ctx, w, h, layout)
    }
    render()
    const ro = new ResizeObserver(render)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [layout])

  return (
    <div className="mini-map" ref={wrapRef} style={{ height }}>
      <canvas ref={canvasRef} />
    </div>
  )
}
