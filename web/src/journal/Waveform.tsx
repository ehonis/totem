// The waveform under the record button.
//
// Two jobs, and the first is the important one: **prove the microphone is hearing
// you.** A 21-minute entry that turns out to be silence is 21 minutes you cannot
// get back, so the bars have to move while you talk, not merely spin. The second
// is the review: once you stop, the whole recording's envelope is drawn at once,
// so a run of flatline in the middle is visible before you press Save.
//
// Canvas rather than a library. wavesurfer.js has a record plugin that does this,
// but it is ~50 kB on a bundle already over 1.5 MB, and what is actually needed —
// draw N rounded bars from an array of numbers — is the sixty lines below. (The
// "find a library" rule in CLAUDE.md is about icon glyphs, where hand-drawing is
// reliably worse; this is a live visualisation off an AnalyserNode that is already
// wired up.)
//
// It reads the recorder's refs inside its own rAF loop and never calls setState,
// so a moving waveform costs no React renders at all.
import React, { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'

const BAR_W = 3
const GAP = 2
const PITCH = BAR_W + GAP
const MIN_BAR = 2

interface WaveformProps {
  /** Live amplitude history, newest last. Ignored when `samples` is given. */
  samplesRef?: MutableRefObject<number[]>
  levelRef?: MutableRefObject<number>
  /** A finished recording's envelope, drawn whole. Switches off the animation. */
  samples?: number[]
  /** Run the animation loop (recording). False freezes whatever is drawn. */
  live?: boolean
  paused?: boolean
  height?: number
  /** Element to write the `--level` CSS variable onto, for the button's halo. */
  haloRef?: MutableRefObject<HTMLElement | null>
  label?: string
}

/**
 * Squash an arbitrary-length envelope into exactly `bars` buckets, keeping peaks.
 *
 * `short` decides what to do when there is less audio than canvas, and the two
 * callers genuinely want opposite things. A live waveform must **pad**: the bars
 * arrive at the right edge and march left, so the newest moment is always in the
 * same place. A finished recording must **stretch**: a ten-second take should use
 * the whole width, not sit squashed against one end of an empty box.
 */
export function bucket(samples: number[], bars: number, short: 'pad' | 'stretch' = 'pad'): number[] {
  if (bars <= 0) return []
  if (!samples.length) return new Array(bars).fill(0)
  if (samples.length <= bars) {
    if (short === 'pad') return [...new Array(bars - samples.length).fill(0), ...samples]
    // Nearest-neighbour stretch. Each bar takes the sample it lands on, so a short
    // take reads as wider bars rather than as a gap.
    return Array.from({ length: bars }, (_, i) => samples[Math.min(samples.length - 1, Math.floor((i * samples.length) / bars))])
  }
  const out = new Array(bars).fill(0)
  const per = samples.length / bars
  for (let i = 0; i < bars; i += 1) {
    const from = Math.floor(i * per)
    const to = Math.max(from + 1, Math.floor((i + 1) * per))
    let peak = 0
    for (let j = from; j < to && j < samples.length; j += 1) if (samples[j] > peak) peak = samples[j]
    out[i] = peak
  }
  return out
}

export default function Waveform({
  samplesRef, levelRef, samples, live = false, paused = false, height = 56, haloRef, label,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const raf = useRef(0)
  // Props the loop needs without restarting it every render.
  const props = useRef({ live, paused, samples })
  props.current = { live, paused, samples }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0
    let dpr = 1
    const palette = { active: '#f0506e', idle: '#8a91a3', rail: '#262b38' }
    const readPalette = () => {
      const css = getComputedStyle(canvas)
      palette.active = css.getPropertyValue('--wave-active').trim() || palette.active
      palette.idle = css.getPropertyValue('--wave-idle').trim() || palette.idle
      palette.rail = css.getPropertyValue('--wave-rail').trim() || palette.rail
    }

    const resize = () => {
      dpr = Math.min(3, window.devicePixelRatio || 1)
      width = canvas.clientWidth
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      readPalette()
      draw()
    }

    const draw = () => {
      if (!width) return
      const bars = Math.max(1, Math.floor((width + GAP) / PITCH))
      const source = props.current.samples ?? samplesRef?.current ?? []
      // Live: the tail of the history, so it scrolls. Static: the whole thing.
      const data = props.current.samples
        ? bucket(source, bars, 'stretch')
        : bucket(source.slice(-bars), bars, 'pad')

      ctx.clearRect(0, 0, width, height)
      const mid = height / 2
      const usable = height - 6

      // A hairline through the middle, so an empty or silent stretch still reads
      // as "a recording that was quiet" rather than as a broken component.
      ctx.fillStyle = palette.rail
      ctx.fillRect(0, mid - 0.5, width, 1)

      const colour = props.current.live && !props.current.paused ? palette.active : palette.idle
      ctx.fillStyle = colour
      const offset = Math.max(0, (width - (bars * PITCH - GAP)) / 2)
      for (let i = 0; i < bars; i += 1) {
        const amp = Math.max(0, Math.min(1, data[i] || 0))
        const h = Math.max(MIN_BAR, amp * usable)
        const x = offset + i * PITCH
        const y = mid - h / 2
        ctx.beginPath()
        // roundRect is in every browser this app runs on (Safari 16+, Chrome 99+);
        // fall back to a square bar rather than throwing if it ever is not.
        if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, BAR_W, h, BAR_W / 2)
        else ctx.rect(x, y, BAR_W, h)
        ctx.fill()
      }
    }

    const loop = () => {
      draw()
      if (haloRef?.current && levelRef) {
        haloRef.current.style.setProperty('--level', String(props.current.paused ? 0 : levelRef.current))
      }
      raf.current = requestAnimationFrame(loop)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    if (live) {
      raf.current = requestAnimationFrame(loop)
    } else {
      draw()
      if (haloRef?.current) haloRef.current.style.setProperty('--level', '0')
    }

    return () => {
      observer.disconnect()
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
    }
    // `paused` is read through the ref, so pausing does not tear down the loop —
    // the bars freeze in place, which is what a paused recording should look like.
  }, [live, height, samplesRef, levelRef, haloRef, samples])

  return (
    <canvas
      ref={canvasRef}
      className={`wave${live ? ' live' : ''}${paused ? ' paused' : ''}`}
      style={{ height }}
      role="img"
      aria-label={label || (live ? 'Live microphone level' : 'Recording waveform')}
    />
  )
}
