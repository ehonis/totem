import { describe, expect, it } from 'vitest'
import {
  chartFrame,
  chartYMax,
  columnLabels,
  hoverReading,
  niceCeil,
  placeMarkers,
  timeColumns,
  usesHourColumns,
  valueAt,
  windowed,
} from './poolChartLayout'
import type { PoolModel } from './poolModel'

const H = 3_600_000
const start = new Date(2026, 10, 20, 0, 0, 0).getTime()

function model(over: Partial<PoolModel> = {}): PoolModel {
  return {
    capacity: 150,
    accountCount: 2,
    current: 90,
    burnPerHour: 4,
    burnWindowHours: 3,
    recorded: [
      { t: start, v: 150 },
      { t: start + 10 * H, v: 110 },
      { t: start + 20 * H, v: 90 },
    ],
    projected: [
      { t: start + 20 * H, v: 90 },
      { t: start + 40 * H, v: 10 },
    ],
    recordedByAccount: { a: [100, 80, 70], b: [50, 30, 20] },
    projectedByAccount: { a: [70, 10], b: [20, 0] },
    recordedRate: [{ t: start, v: 2 }, { t: start + 20 * H, v: 7 }],
    projectedRate: [{ t: start + 20 * H, v: 4 }],
    resets: [],
    limitEvents: [
      { t: start + 30 * H, kind: 'weekly-out', labels: ['a'] },
      { t: start + 5 * H, kind: 'five-out', labels: ['b'], recorded: true },
    ],
    poolEmptyAtMs: null,
    firstEmpty: null,
    nextReset: null,
    horizonEndMs: start + 48 * H,
    accounts: [
      { key: 'a', label: 'Seat A', share: 100, emptyAtMs: null, nextResetMs: null },
      { key: 'b', label: 'Seat B', share: 50, emptyAtMs: null, nextResetMs: null },
    ],
    ...over,
  } as PoolModel
}

const frame = (width = 600) =>
  chartFrame({ startMs: start, endMs: start + 48 * H, width, height: 300, margin: { top: 40, right: 10, bottom: 40, left: 50 }, yMax: 150 })

describe('pool chart layout', () => {
  it('maps the view onto the plot', () => {
    const f = frame()
    expect(f.plotW).toBe(540)
    expect(f.x(start)).toBe(50)
    expect(f.x(start + 48 * H)).toBe(590)
    expect(f.y(150)).toBe(40)
    expect(f.y(0)).toBe(260)
    // Values past the scale sit on its edge.
    expect(f.y(400)).toBe(40)
  })

  it('reads a series between its points and keeps one point past each edge', () => {
    const series = model().recorded
    expect(valueAt(series, start + 5 * H)).toBe(130)
    expect(valueAt(series, start - 1)).toBeNull()
    expect(windowed(series, start + 11 * H, start + 12 * H).map((p) => p.v)).toEqual([110, 90])
  })

  it('tops the scale at the capacity, or a round number over the fastest drain', () => {
    expect(chartYMax(model(), false)).toBe(150)
    expect(chartYMax(model({ capacity: 60 }), false)).toBe(100)
    expect(chartYMax(model(), true)).toBe(10)
    expect(niceCeil(31)).toBe(40)
  })

  it('places a marker only where it happened or will, and keeps labels in the chart', () => {
    const now = start + 20 * H
    const markers = placeMarkers(model(), frame(), { now, eventKinds: ['weekly-out', 'five-out'], rows: [16, 33] })
    expect(markers.map((m) => m.event.kind)).toEqual(['five-out', 'weekly-out'])
    expect(markers.every((m) => m.labelY !== null)).toBe(true)
    // A projected marker before Now is not drawn.
    const late = placeMarkers(model(), frame(), { now: start + 35 * H, eventKinds: ['weekly-out'], rows: [16, 33] })
    expect(late).toEqual([])
  })

  it('labels day columns from today, and switches to hours for short views', () => {
    const f = frame()
    const now = start + 20 * H
    const days = timeColumns({ startMs: f.startMs, endMs: f.endMs, now, hourColumns: false, zoomed: false, plotW: f.plotW })
    expect(days).toHaveLength(2)
    expect(days[0].today).toBe(true)
    expect(columnLabels(days, f, false)).toHaveLength(2)
    expect(usesHourColumns(false, 2 * 24 * H)).toBe(true)
    expect(usesHourColumns(false, 7 * 24 * H)).toBe(false)
    const hours = timeColumns({ startMs: f.startMs, endMs: f.endMs, now, hourColumns: true, zoomed: false, plotW: f.plotW })
    // The whole page keeps 3- or 6-hour columns; 48 h across 540 px takes 6-hour ones.
    expect(hours.length).toBe(8)
    expect(hours.filter((c) => c.day !== '')).toHaveLength(2)
  })

  it('reads each account’s own level under the crosshair, not its share', () => {
    const f = frame()
    const m = model()
    const now = start + 20 * H
    const markers = placeMarkers(m, f, { now, eventKinds: ['weekly-out'], rows: [16, 33] })
    const hover = hoverReading({ model: m, frame: f, hoverT: start + 10 * H, now, rateMode: false, showAccounts: true, markers, overlay: null })
    expect(hover?.v).toBe(110)
    expect(hover?.isProjected).toBe(false)
    expect(hover?.accounts.map((a) => a.v)).toEqual([80, 60])
    expect(hoverReading({ model: m, frame: f, hoverT: start - H, now, rateMode: false, showAccounts: true, markers, overlay: null })).toBeNull()
    const near = hoverReading({ model: m, frame: f, hoverT: start + 30 * H, now, rateMode: false, showAccounts: false, markers, overlay: null })
    expect(near?.events.map((e) => e.kind)).toEqual(['weekly-out'])
    expect(near?.accounts).toEqual([])
  })
})
