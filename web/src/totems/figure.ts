import * as THREE from 'three'
import { hash, hueFor, rng, type FigureSpec } from './lobbyModel'

// One totem, carved as a literal totem pole: a stone plinth, two or three stacked
// faces, sometimes wings, a headpiece that says what kind of work it does, and its
// own icon floating above. The carving is seeded by the totem's id, so it looks the
// same on every visit; its state (asleep, running, failing) shows in the eyes.

/** Geometry and textures shared by every figure in one lobby; disposed with it. */
export class Kit {
  private geos = new Map<string, THREE.BufferGeometry>()
  readonly pool: THREE.CanvasTexture
  readonly beam: THREE.CanvasTexture
  readonly z: THREE.CanvasTexture

  constructor() {
    this.pool = canvasTexture(128, 128, (g) => {
      const r = g.createRadialGradient(64, 64, 0, 64, 64, 64)
      r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,.45)'); r.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = r; g.fillRect(0, 0, 128, 128)
    })
    this.beam = canvasTexture(4, 128, (g) => {
      const l = g.createLinearGradient(0, 0, 0, 128)
      l.addColorStop(0, 'rgba(255,255,255,0)'); l.addColorStop(0.7, 'rgba(255,255,255,.55)'); l.addColorStop(1, 'rgba(255,255,255,.9)')
      g.fillStyle = l; g.fillRect(0, 0, 4, 128)
    })
    this.z = canvasTexture(64, 64, (g) => {
      g.fillStyle = '#fff'; g.font = '700 46px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('z', 32, 34)
    })
  }

  geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
    let g = this.geos.get(key)
    if (!g) { g = make(); this.geos.set(key, g) }
    return g as T
  }

  dispose() {
    this.geos.forEach((g) => g.dispose())
    this.geos.clear()
    this.pool.dispose(); this.beam.dispose(); this.z.dispose()
  }
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export interface Figure {
  spec: FigureSpec
  sig: string
  root: THREE.Group
  body: THREE.Group
  hit: THREE.Mesh
  emblem: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  eyes: THREE.Mesh[]
  eyeMat: THREE.MeshStandardMaterial
  skins: THREE.MeshStandardMaterial[]
  ring: THREE.MeshBasicMaterial
  pool: THREE.MeshBasicMaterial
  beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> | null
  look: THREE.Object3D | null
  spin: THREE.Object3D | null
  blink: THREE.MeshStandardMaterial | null
  zs: THREE.Sprite[]
  glow: THREE.Color
  /** Height of the label anchor above the floor. */
  top: number
  emblemY: number
  born: number
  phase: number
  hover: number
  focus: number
  owned: (THREE.Material | THREE.Texture)[]
}

const box = (w: number, h: number, d: number) => `box:${w}:${h}:${d}`
const PLINTH_H = 0.3
const SEG_H = 0.58
const COLLAR_H = 0.07

export function buildFigure(kit: Kit, spec: FigureSpec, sig: string, now: number): Figure {
  const r = rng(hash(spec.id))
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length) % xs.length]
  const h = hueFor(spec) / 360
  const ghost = spec.kind === 'draft' || spec.kind === 'new'
  const asleep = spec.status === 'off'
  const builtin = spec.kind === 'builtin'
  const owned: (THREE.Material | THREE.Texture)[] = []
  const own = <M extends THREE.Material>(m: M) => { owned.push(m); return m }

  const glow = spec.status === 'error' ? new THREE.Color('#ff4d6d')
    : asleep ? new THREE.Color().setHSL(h, 0.25, 0.55)
      : new THREE.Color().setHSL(h, builtin ? 0.55 : 0.95, 0.6)
  const tone = (dh: number, s: number, l: number) =>
    new THREE.Color().setHSL((h + dh + 1) % 1, asleep ? s * 0.16 : builtin ? s * 0.35 : s, asleep ? l * 0.78 : l)

  const skins: THREE.MeshStandardMaterial[] = []
  const skin = (c: THREE.Color) => {
    const m = own(ghost
      ? new THREE.MeshStandardMaterial({ color: glow, emissive: glow, emissiveIntensity: 0.28, transparent: true, opacity: 0.18, depthWrite: false, flatShading: true })
      : new THREE.MeshStandardMaterial({ color: c, emissive: glow, emissiveIntensity: 0, roughness: builtin ? 0.42 : 0.66, metalness: builtin ? 0.55 : 0.04, flatShading: true }))
    skins.push(m)
    return m
  }
  const main = skin(tone(0, 0.5, 0.46))
  const alt = skin(tone(r() > 0.5 ? 0.08 : -0.08, 0.46, 0.34))
  const trim = skin(tone(0.5, 0.42, 0.52))
  const ink = ghost ? main : own(new THREE.MeshStandardMaterial({ color: tone(0, 0.3, 0.07), roughness: 0.9, flatShading: true }))
  const bone = ghost ? main : own(new THREE.MeshStandardMaterial({ color: '#efe9dc', roughness: 0.5, flatShading: true }))
  const stone = own(new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(h, 0.1, 0.13), roughness: 0.85, metalness: 0.15, flatShading: true }))
  const eyeMat = own(new THREE.MeshStandardMaterial({ color: '#0b0d12', emissive: glow, emissiveIntensity: 1.6, roughness: 0.3 }))

  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)
  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x, y, z)
    m.rotation.set(rx, ry, rz)
    m.castShadow = !ghost
    m.receiveShadow = !ghost
    parent.add(m)
    return m
  }

  // Plinth, its glowing rim, and the pool of light it stands in.
  add(root, kit.geo('plinth', () => new THREE.CylinderGeometry(0.86, 0.98, PLINTH_H, 6)), stone, 0, PLINTH_H / 2, 0, 0, Math.PI / 6)
  const ring = own(new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.8, toneMapped: false }))
  add(root, kit.geo('rim', () => new THREE.TorusGeometry(0.82, 0.025, 6, 6)), ring, 0, PLINTH_H + 0.005, 0, Math.PI / 2, 0, Math.PI / 6).castShadow = false
  const pool = own(new THREE.MeshBasicMaterial({ map: kit.pool, color: glow, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }))
  const poolMesh = add(root, kit.geo('pool', () => new THREE.PlaneGeometry(3.4, 3.4)), pool, 0, 0.012, 0, -Math.PI / 2)
  poolMesh.castShadow = false; poolMesh.receiveShadow = false

  const eyes: THREE.Mesh[] = []
  let y = PLINTH_H + 0.02

  // A carved face on the front of a segment centred at cy, its front at fz.
  const face = (cy: number, fz: number, s: number) => {
    const eyeStyle = Math.floor(r() * 3)
    const eyeGeo = eyeStyle === 0 ? kit.geo('eye-sq', () => new THREE.BoxGeometry(0.16, 0.12, 0.05))
      : eyeStyle === 1 ? kit.geo('eye-rd', () => new THREE.CylinderGeometry(0.075, 0.075, 0.05, 12).rotateX(Math.PI / 2))
        : kit.geo('eye-sl', () => new THREE.BoxGeometry(0.22, 0.055, 0.05))
    for (const sx of [-1, 1]) {
      const e = add(body, eyeGeo, eyeMat, sx * 0.19 * s, cy + 0.07 * s, fz + 0.012)
      e.scale.setScalar(s)
      eyes.push(e)
      const tilt = pick([0, 0.28, -0.22])
      add(body, kit.geo(box(0.25, 0.05, 0.06), () => new THREE.BoxGeometry(0.25, 0.05, 0.06)), ink, sx * 0.19 * s, cy + 0.19 * s, fz + 0.01, 0, 0, -sx * tilt).scale.setScalar(s)
    }
    const mouth = Math.floor(r() * 3)
    if (mouth === 0) add(body, kit.geo(box(0.38, 0.05, 0.05), () => new THREE.BoxGeometry(0.38, 0.05, 0.05)), ink, 0, cy - 0.15 * s, fz + 0.01).scale.setScalar(s)
    else if (mouth === 1) {
      add(body, kit.geo(box(0.34, 0.14, 0.05), () => new THREE.BoxGeometry(0.34, 0.14, 0.05)), ink, 0, cy - 0.15 * s, fz + 0.005).scale.setScalar(s)
      for (const tx of [-0.1, 0, 0.1]) add(body, kit.geo(box(0.06, 0.05, 0.03), () => new THREE.BoxGeometry(0.06, 0.05, 0.03)), bone, tx * s, cy - 0.11 * s, fz + 0.03)
    } else {
      // The bird's beak of a carved pole.
      add(body, kit.geo('beak', () => new THREE.ConeGeometry(0.1, 0.34, 4).rotateX(Math.PI / 2)), trim, 0, cy - 0.06 * s, fz + 0.17 * s).scale.setScalar(s)
    }
  }

  // Stacked segments, then the head.
  const segments = spec.kind === 'new' ? 0 : 2 + (r() > 0.55 ? 1 : 0)
  const wingAt = segments >= 2 && r() < 0.62 ? segments - 1 : -1
  for (let i = 0; i < segments; i++) {
    const shape = pick(['box', 'cyl', 'hex'] as const)
    const mat = i % 2 ? alt : main
    const cy = y + SEG_H / 2
    let fz: number
    if (shape === 'box') {
      const w = 0.84 + r() * 0.1
      add(body, kit.geo(box(+w.toFixed(2), SEG_H, 0.84), () => new THREE.BoxGeometry(+w.toFixed(2), SEG_H, 0.84)), mat, 0, cy, 0)
      fz = 0.42
    } else {
      const n = shape === 'cyl' ? 8 : 6
      add(body, kit.geo(`seg${n}`, () => new THREE.CylinderGeometry(0.5, 0.54, SEG_H, n).rotateY(Math.PI / n)), mat, 0, cy, 0)
      fz = 0.52 * Math.cos(Math.PI / n)
    }
    face(cy, fz, 0.92)
    if (i === wingAt) {
      for (const sx of [-1, 1]) {
        add(body, kit.geo(box(0.72, 0.26, 0.07), () => new THREE.BoxGeometry(0.72, 0.26, 0.07)), trim, sx * 0.8, cy + 0.08, 0, 0, 0, sx * 0.42)
        add(body, kit.geo(box(0.5, 0.18, 0.07), () => new THREE.BoxGeometry(0.5, 0.18, 0.07)), alt, sx * 0.72, cy - 0.14, 0.02, 0, 0, sx * 0.16)
      }
    }
    y += SEG_H
    add(body, kit.geo('collar', () => new THREE.CylinderGeometry(0.4, 0.4, COLLAR_H, 8)), ink === main ? main : stone, 0, y + COLLAR_H / 2, 0)
    y += COLLAR_H
  }

  let look: THREE.Object3D | null = null
  let spin: THREE.Object3D | null = null
  let blink: THREE.MeshStandardMaterial | null = null
  if (spec.kind !== 'new') {
    const headH = 0.72
    add(body, kit.geo(box(1, headH, 0.9), () => new THREE.BoxGeometry(1, headH, 0.9)), main, 0, y + headH / 2, 0)
    face(y + headH / 2, 0.45, 1.12)
    y += headH

    // The headpiece: what kind of work it does.
    const crown = new THREE.Group()
    crown.position.y = y
    body.add(crown)
    const type = spec.kind === 'builtin' ? 'builtin' : spec.watcher ? 'watcher' : spec.kind === 'draft' ? 'draft' : spec.type
    if (type === 'watcher') {
      const eye = new THREE.Group()
      eye.position.y = 0.3
      crown.add(eye)
      const white = ghost ? main : own(new THREE.MeshStandardMaterial({ color: '#b9bcc6', roughness: 0.7, flatShading: true }))
      add(eye, kit.geo('eyeball', () => new THREE.IcosahedronGeometry(0.26, 2)), white)
      add(eye, kit.geo('iris', () => new THREE.CylinderGeometry(0.13, 0.13, 0.04, 16).rotateX(Math.PI / 2)), eyeMat, 0, 0, 0.235)
      eyes.push(add(eye, kit.geo('pupil', () => new THREE.CylinderGeometry(0.055, 0.055, 0.03, 12).rotateX(Math.PI / 2)), ink, 0, 0, 0.26))
      add(crown, kit.geo('stalk', () => new THREE.CylinderGeometry(0.06, 0.1, 0.12, 6)), alt, 0, 0.05, 0)
      look = eye
      y += 0.6
    } else if (type === 'researcher') {
      add(crown, kit.geo('antenna', () => new THREE.CylinderGeometry(0.025, 0.035, 0.55, 6)), ink, 0.22, 0.27, 0, 0, 0, -0.18)
      blink = own(new THREE.MeshStandardMaterial({ color: '#0b0d12', emissive: glow, emissiveIntensity: 2 }))
      add(crown, kit.geo('bulb', () => new THREE.IcosahedronGeometry(0.08, 1)), blink, 0.32, 0.56, 0)
      add(crown, kit.geo('dish', () => new THREE.ConeGeometry(0.22, 0.14, 10, 1, true)), trim, -0.18, 0.12, 0, Math.PI, 0, 0.3)
      y += 0.65
    } else if (type === 'analyst') {
      ;[0.22, 0.38, 0.56].forEach((bh, i) => add(crown, kit.geo(box(0.15, bh, 0.15), () => new THREE.BoxGeometry(0.15, bh, 0.15)), i === 2 ? trim : alt, (i - 1) * 0.22, bh / 2, 0))
      y += 0.6
    } else if (type === 'writer') {
      add(crown, kit.geo('quill', () => new THREE.ConeGeometry(0.06, 0.9, 6)), bone, 0.08, 0.42, 0, 0, 0, -0.42)
      add(crown, kit.geo(box(0.08, 0.5, 0.2), () => new THREE.BoxGeometry(0.08, 0.5, 0.2)), trim, 0.18, 0.6, 0, 0, 0, -0.42)
      y += 0.85
    } else if (type === 'organiser') {
      ;[0, 1, 2].forEach((i) => add(crown, kit.geo('cube', () => new THREE.BoxGeometry(0.24, 0.24, 0.24)), i % 2 ? trim : alt, (i - 1) * 0.06, 0.12 + i * 0.24, 0, 0, i * 0.4, 0))
      y += 0.75
    } else if (type === 'coach') {
      for (const sx of [-1, 1]) add(crown, kit.geo('horn', () => new THREE.ConeGeometry(0.09, 0.5, 6)), bone, sx * 0.34, 0.2, 0, 0, 0, -sx * 0.55)
      add(crown, kit.geo('band', () => new THREE.CylinderGeometry(0.46, 0.46, 0.08, 8).rotateY(Math.PI / 8)), trim, 0, 0.04, 0)
      y += 0.5
    } else if (type === 'coder') {
      const chip = new THREE.Group()
      chip.position.y = 0.42
      crown.add(chip)
      add(chip, kit.geo('chip', () => new THREE.BoxGeometry(0.3, 0.3, 0.3)), alt)
      const edges = own(new THREE.LineBasicMaterial({ color: glow, toneMapped: false }))
      chip.add(new THREE.LineSegments(kit.geo('chip-edge', () => new THREE.EdgesGeometry(new THREE.BoxGeometry(0.38, 0.38, 0.38))), edges))
      spin = chip
      y += 0.7
    } else if (type === 'builtin') {
      const gear = new THREE.Group()
      gear.position.y = 0.36
      crown.add(gear)
      add(gear, kit.geo('gear', () => new THREE.TorusGeometry(0.22, 0.07, 6, 18)), trim)
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2
        add(gear, kit.geo(box(0.09, 0.1, 0.1), () => new THREE.BoxGeometry(0.09, 0.1, 0.1)), trim, Math.cos(a) * 0.32, Math.sin(a) * 0.32, 0, 0, 0, a)
      }
      spin = gear
      y += 0.72
    } else if (type !== 'draft') {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + Math.PI / 2
        add(crown, kit.geo('spike', () => new THREE.ConeGeometry(0.07, 0.32, 5)), i % 2 ? alt : trim, Math.cos(a) * 0.3, 0.16, Math.sin(a) * 0.26)
      }
      y += 0.4
    }
  } else {
    // The empty slot: a column of light waiting for someone to stand in it.
    const holo = own(new THREE.MeshBasicMaterial({ map: kit.beam, color: glow, transparent: true, opacity: 0.35, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }))
    const col = add(root, kit.geo('holo', () => new THREE.CylinderGeometry(0.62, 0.7, 2.2, 24, 1, true)), holo, 0, PLINTH_H + 1.1, 0)
    col.castShadow = false
    y = 2.1
  }

  // Its icon, floating above.
  const emblemY = y + 0.62
  const emblemMat = own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }))
  const emblem = new THREE.Mesh(kit.geo('emblem', () => new THREE.PlaneGeometry(0.82, 0.82)), emblemMat)
  emblem.position.y = emblemY
  root.add(emblem)

  // A shaft of light while it runs.
  let beam: Figure['beam'] = null
  if (spec.status === 'running') {
    const m = own(new THREE.MeshBasicMaterial({ map: kit.beam, color: glow, transparent: true, opacity: 0.4, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }))
    beam = new THREE.Mesh(kit.geo('beam', () => new THREE.CylinderGeometry(0.75, 0.95, 9, 24, 1, true)), m)
    beam.position.y = 4.5
    root.add(beam)
  }

  // Asleep: z's drift up from its head.
  const zs: THREE.Sprite[] = []
  if (asleep) {
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: kit.z, color: '#c9d2ea', transparent: true, depthWrite: false })))
      root.add(s)
      zs.push(s)
    }
  }

  const hit = new THREE.Mesh(kit.geo(`hit:${Math.round(emblemY * 10)}`, () => new THREE.CylinderGeometry(0.85, 0.85, emblemY + 0.5, 8)), own(new THREE.MeshBasicMaterial({ visible: false })))
  hit.position.y = (emblemY + 0.5) / 2
  hit.userData.id = spec.id
  root.add(hit)

  return {
    spec, sig, root, body, hit, emblem, eyes, eyeMat, skins, ring, pool, beam, look, spin, blink, zs, glow,
    top: emblemY + 0.5, emblemY, born: now, phase: r() * Math.PI * 2, hover: 0, focus: 0, owned,
  }
}

/** Paint the totem's own icon (an SVG string, drawn white) onto its floating emblem. */
export function setEmblem(fig: Figure, svg: string | null, cache: Map<string, THREE.Texture>) {
  if (!svg) return
  const css = `#${fig.glow.getHexString()}`
  const key = `${css}|${svg}`
  const hit = cache.get(key)
  if (hit) { fig.emblem.material.map = hit; fig.emblem.material.needsUpdate = true; return }
  const img = new Image()
  img.onload = () => {
    const c = document.createElement('canvas')
    c.width = c.height = 256
    const g = c.getContext('2d')!
    const halo = g.createRadialGradient(128, 128, 40, 128, 128, 128)
    halo.addColorStop(0, `${css}88`); halo.addColorStop(1, `${css}00`)
    g.fillStyle = halo; g.fillRect(0, 0, 256, 256)
    g.beginPath(); g.arc(128, 128, 88, 0, Math.PI * 2)
    g.fillStyle = 'rgba(8,10,18,.72)'; g.fill()
    g.lineWidth = 7; g.strokeStyle = css; g.stroke()
    g.drawImage(img, 68, 68, 120, 120)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    cache.set(key, tex)
    fig.emblem.material.map = tex
    fig.emblem.material.needsUpdate = true
  }
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const easeOutBack = (k: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2) }

export interface FrameState { t: number; dt: number; hover: boolean; focus: boolean; front: number; reduced: boolean; lookAt: THREE.Vector3; eye: THREE.Vector3 }

export function animateFigure(f: Figure, s: FrameState) {
  const { t, dt } = s
  const k = 1 - Math.exp(-dt * 10)
  f.hover += ((s.hover ? 1 : 0) - f.hover) * k
  f.focus += ((s.focus ? 1 : 0) - f.focus) * k
  const asleep = f.spec.status === 'off'
  const motion = s.reduced ? 0 : 1

  const born = Math.min(1, (t - f.born) / 0.7)
  const pop = s.reduced ? 1 : 0.55 + 0.45 * easeOutBack(born)
  f.root.scale.setScalar(pop * (1 + f.hover * 0.05 + f.focus * 0.08))

  const bob = asleep ? 0 : Math.sin(t * 1.6 + f.phase) * 0.045 * motion
  f.body.position.y = bob + f.hover * 0.1
  f.body.rotation.y = (asleep ? 0 : Math.sin(t * 0.7 + f.phase) * 0.07 * motion) + (asleep ? Math.sin(t * 0.5 + f.phase) * 0.02 * motion : 0)
  f.body.rotation.z = asleep ? 0.06 + Math.sin(t * 0.8 + f.phase) * 0.012 * motion : 0

  // Eyes: closed when asleep, a blink now and then, a flicker when failing.
  const blinking = !s.reduced && ((t + f.phase * 3) % 4.6) < 0.12
  const open = asleep ? 0.18 : blinking ? 0.12 : 1
  for (const e of f.eyes) e.scale.y = e.scale.x * open
  f.eyeMat.emissiveIntensity = asleep ? 0.25
    : f.spec.status === 'error' ? 0.9 + (Math.sin(t * 21) > 0.55 ? 2.2 : 0) * motion
      : 1.7 + f.hover * 1.6 + f.focus * 0.5
  for (const m of f.skins) if (!m.transparent) m.emissiveIntensity = f.hover * 0.22

  f.ring.opacity = (asleep ? 0.25 : 0.55) + f.hover * 0.45
  f.pool.opacity = (asleep ? 0.12 : 0.3) + f.focus * 0.25 + f.hover * 0.35

  const running = f.spec.status === 'running'
  f.emblem.position.y = f.emblemY + Math.sin(t * 2 + f.phase) * 0.07 * motion + f.hover * 0.12
  // Seen from above, an upright icon would be edge-on: it faces the camera.
  f.emblem.lookAt(s.eye)
  f.emblem.rotateY(running ? t * 3.2 * motion : Math.sin(t * 0.6 + f.phase) * 0.25 * motion)
  const emblemTarget = f.emblem.material.map ? (asleep ? 0.45 : 0.96) * (0.45 + 0.55 * Math.max(0, s.front)) : 0
  f.emblem.material.opacity += (emblemTarget - f.emblem.material.opacity) * k

  if (f.look) {
    f.look.lookAt(s.lookAt)
    if (asleep) f.look.rotation.x = 0.5
  }
  if (f.spin && !asleep) { f.spin.rotation.z += dt * 0.9 * motion; if (f.spec.type === 'coder') f.spin.rotation.y += dt * 1.1 * motion }
  if (f.blink) f.blink.emissiveIntensity = asleep ? 0.1 : Math.sin(t * 4 + f.phase) > 0 ? 2.4 : 0.3
  if (f.beam) {
    f.beam.material.opacity = 0.28 + Math.sin(t * 6) * 0.1
    f.beam.rotation.y = t * 0.6
  }
  f.zs.forEach((z, i) => {
    const p = s.reduced ? i / 3 : (t * 0.32 + i / 3) % 1
    z.position.set(0.3 + p * 0.45 + Math.sin(p * 6 + i) * 0.06, f.top - 0.9 + p * 1.1, 0.25)
    z.scale.setScalar(0.16 + p * 0.2)
    z.material.opacity = Math.sin(p * Math.PI) * 0.85
  })
}

export function disposeFigure(f: Figure) {
  f.root.removeFromParent()
  for (const o of f.owned) o.dispose()
}
