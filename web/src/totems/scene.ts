import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { Kit, animateFigure, buildFigure, disposeFigure, setEmblem, type Figure } from './figure'
import { frontIndex, ringFor, rotationFor, type FigureSpec, type Ring } from './lobbyModel'

// The Totems lobby: every totem standing on a ring under a night sky, the one in
// front lit by a spotlight. The ring turns to bring a totem forward; the React
// overlay (TotemLobby.tsx) owns which one that is and shows its details.

export interface LobbyItem { spec: FigureSpec; sig: string; icon: string | null }

export interface LobbyHooks {
  onHover: (id: string | null) => void
  /** A click on a figure. */
  onClick: (id: string) => void
  /** The ring was dragged and settled with this one in front. */
  onSettle: (id: string) => void
  /** A wheel notch: -1 or 1. */
  onStep: (dir: number) => void
  /** The DOM name tag that floats over a figure. */
  label: (id: string) => HTMLElement | null
}

export interface Lobby {
  setItems: (items: LobbyItem[]) => void
  focus: (id: string | null) => void
  /** Pixels on the right covered by the details panel and at the bottom by the roster. */
  setInsets: (right: number, bottom: number) => void
  dispose: () => void
}

const SKY_TOP = '#05060c'
const SKY_HORIZON = '#1b1640'
const FOG = new THREE.Color('#120f2a')

export function createLobby(host: HTMLElement, hooks: LobbyHooks, opts: { reduced: boolean }): Lobby {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.domElement.className = 'tl-gl'
  host.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const kit = new Kit()
  const icons = new Map<string, THREE.Texture>()
  const disposables: { dispose: () => void }[] = []
  const track = <T extends { dispose: () => void }>(x: T) => { disposables.push(x); return x }

  // Sky: a vertical gradient with a band of light on the horizon.
  {
    const c = document.createElement('canvas')
    c.width = 2; c.height = 512
    const g = c.getContext('2d')!
    const l = g.createLinearGradient(0, 0, 0, 512)
    l.addColorStop(0, SKY_TOP); l.addColorStop(0.55, '#0e0c22'); l.addColorStop(0.78, SKY_HORIZON); l.addColorStop(1, '#0c0a1c')
    g.fillStyle = l; g.fillRect(0, 0, 2, 512)
    const t = track(new THREE.CanvasTexture(c))
    t.colorSpace = THREE.SRGBColorSpace
    scene.background = t
  }
  scene.fog = new THREE.Fog(FOG, 30, 80)

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200)

  // Light: a cool sky fill, a warm key that casts the shadows, colour on the rims,
  // and the spotlight on whoever stands in front.
  scene.add(new THREE.HemisphereLight('#8ea2ff', '#1a1026', 1.1))
  const key = new THREE.DirectionalLight('#ffe6cc', 2.1)
  key.position.set(6, 12, 8)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.02
  scene.add(key, key.target)
  const rimL = new THREE.PointLight('#7c5cff', 1.2, 0, 0)
  const rimR = new THREE.PointLight('#22d3ee', 0.9, 0, 0)
  scene.add(rimL, rimR)
  const spot = new THREE.SpotLight('#ffffff', 2.2, 0, 0.3, 0.75, 0)
  spot.castShadow = true
  spot.shadow.mapSize.set(1024, 1024)
  scene.add(spot, spot.target)

  // The stage: a disc carved with rings and spokes, glowing faintly.
  const stage = new THREE.Group()
  scene.add(stage)
  let floorMat: THREE.MeshStandardMaterial
  {
    const c = document.createElement('canvas')
    c.width = c.height = 1024
    const g = c.getContext('2d')!
    const base = g.createRadialGradient(512, 512, 0, 512, 512, 512)
    base.addColorStop(0, '#1d1c33'); base.addColorStop(0.6, '#13121f'); base.addColorStop(1, '#0a0912')
    g.fillStyle = base; g.fillRect(0, 0, 1024, 1024)
    g.strokeStyle = 'rgba(140,150,255,.13)'
    for (let i = 1; i <= 14; i++) { g.lineWidth = i % 4 === 0 ? 3 : 1.2; g.beginPath(); g.arc(512, 512, i * 36, 0, Math.PI * 2); g.stroke() }
    g.lineWidth = 1
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2
      g.beginPath(); g.moveTo(512 + Math.cos(a) * 72, 512 + Math.sin(a) * 72); g.lineTo(512 + Math.cos(a) * 510, 512 + Math.sin(a) * 510); g.stroke()
    }
    const t = track(new THREE.CanvasTexture(c))
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = renderer.capabilities.getMaxAnisotropy()
    floorMat = track(new THREE.MeshStandardMaterial({ map: t, roughness: 0.55, metalness: 0.25 }))
    const floor = new THREE.Mesh(track(new THREE.CircleGeometry(1, 96)), floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    stage.add(floor)
    const edge = new THREE.Mesh(track(new THREE.TorusGeometry(1, 0.004, 6, 160)), track(new THREE.MeshBasicMaterial({ color: '#7c8cff', toneMapped: false })))
    edge.rotation.x = -Math.PI / 2
    edge.position.y = 0.01
    stage.add(edge)
  }

  // Far away: a slow halo in the sky and drifting rocks, for depth. They follow
  // the front of the ring, so a bigger ring doesn't push them into the fog.
  const far = new THREE.Group()
  scene.add(far)
  const halo = new THREE.Mesh(track(new THREE.TorusGeometry(16, 0.12, 8, 160)), track(new THREE.MeshBasicMaterial({ color: '#6d5cff', transparent: true, opacity: 0.55, toneMapped: false, fog: false })))
  halo.position.set(0, 9, -24)
  far.add(halo)
  const halo2 = new THREE.Mesh(track(new THREE.TorusGeometry(11, 0.05, 6, 160)), track(new THREE.MeshBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.35, toneMapped: false, fog: false })))
  halo2.position.copy(halo.position)
  far.add(halo2)
  const rockMat = track(new THREE.MeshStandardMaterial({ color: '#2a2540', roughness: 0.9, flatShading: true }))
  const rocks: { m: THREE.Mesh; y: number; p: number; s: number }[] = []
  {
    const r = (() => { let a = 7; return () => ((a = (a * 16807) % 2147483647) / 2147483647) })()
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(track(new THREE.IcosahedronGeometry(0.8 + r() * 2.2, 0)), rockMat)
      const a = -Math.PI * 0.85 + r() * Math.PI * 1.7
      const d = 26 + r() * 18
      const y = 2 + r() * 10
      m.position.set(Math.sin(a) * d, y, -Math.cos(a) * d * 0.6 - 2)
      m.rotation.set(r() * 3, r() * 3, r() * 3)
      far.add(m)
      rocks.push({ m, y, p: r() * 6, s: 0.1 + r() * 0.25 })
    }
  }

  // Motes of light drifting up through the front of the stage.
  const MOTES = 320
  const motePos = new Float32Array(MOTES * 3)
  const moteSpeed = new Float32Array(MOTES)
  const motes = new THREE.Points(
    track(new THREE.BufferGeometry()),
    track(new THREE.PointsMaterial({ color: '#a9b4ff', size: 0.06, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })),
  )
  motes.geometry.setAttribute('position', new THREE.BufferAttribute(motePos, 3))
  for (let i = 0; i < MOTES; i++) {
    motePos[i * 3] = (Math.random() - 0.5) * 30
    motePos[i * 3 + 1] = Math.random() * 10
    motePos[i * 3 + 2] = (Math.random() - 0.5) * 30
    moteSpeed[i] = 0.12 + Math.random() * 0.35
  }
  scene.add(motes)

  const ring = new THREE.Group()
  scene.add(ring)

  // Bloom makes the eyes and rims glow like a game rather than a diagram.
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.5, 0.8)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  // --- state --------------------------------------------------------------------
  let figures: Figure[] = []
  const byId = new Map<string, Figure>()
  let layout: Ring = ringFor(1)
  let radius = layout.radius
  let rot = 0
  let targetRot = 0
  let focusId: string | null = null
  let hoverId: string | null = null
  let insetR = 0
  let insetB = 0
  let width = 1
  let height = 1
  const pointer = new THREE.Vector2(0, 0)
  let pointerIn = false
  const lookAt = new THREE.Vector3()
  const camPos = new THREE.Vector3()
  const camLook = new THREE.Vector3()
  const clock = new THREE.Clock()
  let drag: { x: number; base: number; moved: boolean; id: string | null } | null = null

  const raycaster = new THREE.Raycaster()
  const pickAt = (cx: number, cy: number): string | null => {
    const rect = renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    const hit = raycaster.intersectObjects(figures.map((f) => f.hit), false)[0]
    return (hit?.object.userData.id as string) || null
  }

  function setHover(id: string | null) {
    if (id === hoverId) return
    hoverId = id
    renderer.domElement.style.cursor = id ? 'pointer' : drag?.moved ? 'grabbing' : 'grab'
    hooks.onHover(id)
  }

  // --- input ----------------------------------------------------------------------
  const el = renderer.domElement
  el.style.cursor = 'grab'
  const onMove = (e: PointerEvent) => {
    const rect = el.getBoundingClientRect()
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    pointerIn = true
    if (drag) {
      const dx = e.clientX - drag.x
      if (Math.abs(dx) > 6) drag.moved = true
      if (drag.moved) {
        rot = targetRot = drag.base + (dx / Math.max(320, width * 0.5)) * layout.step * 2.2
        if (!layout.full) {
          const lo = -(figures.length - 1) * layout.step - layout.step * 0.6
          targetRot = rot = Math.min(layout.step * 0.6, Math.max(lo, rot))
        }
        el.style.cursor = 'grabbing'
        setHover(null)
        return
      }
    }
    setHover(pickAt(e.clientX, e.clientY))
  }
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    drag = { x: e.clientX, base: rot, moved: false, id: pickAt(e.clientX, e.clientY) }
    el.setPointerCapture(e.pointerId)
  }
  const onUp = (e: PointerEvent) => {
    if (!drag) return
    const d = drag
    drag = null
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    el.style.cursor = hoverId ? 'pointer' : 'grab'
    if (d.moved) {
      const i = frontIndex(rot, layout, figures.length)
      if (i >= 0) {
        targetRot = rotationFor(i, layout, rot)
        hooks.onSettle(figures[i].spec.id)
      }
    } else if (d.id) hooks.onClick(d.id)
  }
  const onLeave = () => { pointerIn = false; if (!drag) setHover(null) }
  let wheelAt = 0
  let wheelSum = 0
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    wheelSum += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    const now = performance.now()
    if (Math.abs(wheelSum) > 40 && now - wheelAt > 160) {
      hooks.onStep(Math.sign(wheelSum))
      wheelSum = 0
      wheelAt = now
    }
  }
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onUp)
  el.addEventListener('pointerleave', onLeave)
  el.addEventListener('wheel', onWheel, { passive: false })

  // --- size -----------------------------------------------------------------------
  function applyView() {
    camera.aspect = width / height
    // Shift the picture left so the ring sits in the space the panel leaves free.
    // Seen from above the front row already clears the roster, and the back row
    // needs room under the title, so it moves down a little rather than up.
    camera.setViewOffset(width, height, insetR / 2, -insetB * 0.3, width, height)
    camera.updateProjectionMatrix()
  }
  function resize() {
    width = Math.max(1, host.clientWidth)
    height = Math.max(1, host.clientHeight)
    renderer.setSize(width, height, false)
    composer.setSize(width, height)
    bloom.resolution.set(width / 2, height / 2)
    applyView()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(host)
  resize()

  // --- frame ----------------------------------------------------------------------
  const v = new THREE.Vector3()
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  let raf = 0
  let placed = false
  function frame() {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime
    const reduced = opts.reduced

    if (!drag) rot += (targetRot - rot) * (reduced ? 1 : 1 - Math.exp(-dt * 5.5))
    radius += (layout.radius - radius) * (1 - Math.exp(-dt * 4))
    stage.scale.setScalar(radius + 7)

    // Camera: high above the front of the ring, looking down across it like a
    // board, swaying a little with the pointer.
    const px = pointerIn && !reduced ? pointer.x : 0
    const py = pointerIn && !reduced ? pointer.y : 0
    camPos.set(px * 1.2, radius * 2.1 + 7 + py * 0.6, radius * 1.6 + 10)
    camLook.set(px * 0.4, 0, radius * 0.02)
    camera.position.lerp(camPos, reduced || !placed ? 1 : 1 - Math.exp(-dt * 3))
    placed = true
    camera.lookAt(camLook)

    spot.position.set(0.6, 8.5, radius + 3.2)
    spot.target.position.set(0, 0.8, radius)
    key.target.position.set(0, 0, radius - 2)
    rimL.position.set(-6, 4, radius - 3)
    rimR.position.set(6, 3, radius - 2)

    // Where the watchers look: the pointer, else the camera.
    if (pointerIn) {
      raycaster.setFromCamera(pointer, camera)
      plane.constant = -(radius + 3)
      if (!raycaster.ray.intersectPlane(plane, lookAt)) lookAt.copy(camera.position)
    } else lookAt.copy(camera.position)

    figures.forEach((f, i) => {
      const a = i * layout.step + rot
      f.root.position.set(Math.sin(a) * radius, 0, Math.cos(a) * radius)
      // Everyone turns to face the camera, so from above every face can be read.
      f.root.rotation.y = Math.atan2(camera.position.x - f.root.position.x, camera.position.z - f.root.position.z)
      const front = Math.cos(a)
      animateFigure(f, { t, dt, hover: hoverId === f.spec.id, focus: focusId === f.spec.id, front, reduced, lookAt, eye: camera.position })

      const tag = hooks.label(f.spec.id)
      if (tag) {
        v.set(0, f.top * f.root.scale.y, 0).add(f.root.position).project(camera)
        const visible = v.z < 1
        const x = (v.x * 0.5 + 0.5) * width
        const y = (-v.y * 0.5 + 0.5) * height
        tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`
        tag.style.opacity = visible ? String(0.55 + 0.45 * Math.max(0, front)) : '0'
        tag.style.zIndex = String(Math.round(front * 100) + 100)
        tag.style.visibility = visible ? 'visible' : 'hidden'
      }
    })

    if (!reduced) {
      halo.rotation.z = t * 0.03
      halo.rotation.x = Math.sin(t * 0.1) * 0.08
      halo2.rotation.z = -t * 0.05
      for (const r of rocks) { r.m.position.y = r.y + Math.sin(t * r.s + r.p) * 0.6; r.m.rotation.y += dt * r.s * 0.3 }
      for (let i = 0; i < MOTES; i++) {
        motePos[i * 3 + 1] += moteSpeed[i] * dt
        if (motePos[i * 3 + 1] > 10) motePos[i * 3 + 1] = 0
      }
      motes.geometry.attributes.position.needsUpdate = true
    }
    motes.position.z = radius
    far.position.z = radius

    composer.render(dt)
  }
  raf = requestAnimationFrame(frame)

  // --- API ------------------------------------------------------------------------
  function setItems(items: LobbyItem[]) {
    const now = clock.elapsedTime
    const keep = new Set(items.map((i) => i.spec.id))
    for (const f of figures) if (!keep.has(f.spec.id)) { disposeFigure(f); byId.delete(f.spec.id) }
    figures = items.map((item) => {
      let f = byId.get(item.spec.id)
      if (f && f.sig !== item.sig) {
        // Changed state: re-carve, with a smaller pop than a newcomer's.
        disposeFigure(f)
        f = buildFigure(kit, item.spec, item.sig, now - 0.3)
      } else if (!f) f = buildFigure(kit, item.spec, item.sig, now)
      else return f
      byId.set(item.spec.id, f)
      ring.add(f.root)
      setEmblem(f, item.icon, icons)
      return f
    })
    // Icons can arrive after the figure (the overlay renders them first).
    for (const item of items) {
      const f = byId.get(item.spec.id)
      if (f && !f.emblem.material.map) setEmblem(f, item.icon, icons)
    }
    layout = ringFor(Math.max(1, figures.length))
    focus(focusId)
  }

  function focus(id: string | null) {
    focusId = id
    const i = figures.findIndex((f) => f.spec.id === id)
    if (i >= 0) targetRot = rotationFor(i, layout, rot)
  }

  function setInsets(right: number, bottom: number) {
    insetR = right
    insetB = bottom
    applyView()
  }

  function dispose() {
    cancelAnimationFrame(raf)
    ro.disconnect()
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('pointercancel', onUp)
    el.removeEventListener('pointerleave', onLeave)
    el.removeEventListener('wheel', onWheel)
    figures.forEach(disposeFigure)
    icons.forEach((t) => t.dispose())
    kit.dispose()
    disposables.forEach((d) => d.dispose())
    bloom.dispose()
    composer.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    el.remove()
  }

  return { setItems, focus, setInsets, dispose }
}
