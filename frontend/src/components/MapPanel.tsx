// Hero 2D map. Canvas 2D only, requestAnimationFrame at 60 fps, decoupled
// from the 2 Hz map stream (occupancy layers are rebuilt only when a new map
// arrives). All drawing goes through drawScene so the same code powers the
// live view and the exported final-map PNG.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore, FALLBACK_CONFIG } from '../store'
import type { Config, MapState, Mission, PathMsg, Pose, Survivor } from '../lib/protocol'
import { cellLabel, cellLabelAtCell, colLetter } from '../lib/grid'
import { setMapExporter } from '../lib/mapExport'

interface View {
  scale: number
  offsetX: number
  offsetY: number
}

interface Snap {
  map: MapState | null
  path: PathMsg | null
  survivors: Record<number, Survivor>
  mission: Mission | null
  cfg: Config
}

interface Layers {
  occ: HTMLCanvasElement | null
  glow: HTMLCanvasElement | null
  tint: HTMLCanvasElement | null
  reveal: HTMLCanvasElement | null
  revealStart: number
  labels: { label: string; x: number; y: number; kind: 'room' | 'corridor' }[]
  w: number
  h: number
}

const C = {
  bg: '#070B12',
  grid: '#152030',
  cell: '#22364f',
  axis: '#7C8DA6',
  wall: '#22D3EE',
  ok: '#34D399',
  room: 'rgba(52,211,153,0.10)',
  corridor: 'rgba(34,211,238,0.05)',
  entry: '#34D399',
  drone: '#E2F5FF',
  accent: '#22D3EE',
  survivor: '#FB7185',
  dim: '#7C8DA6',
  ink: '#D7E3F4',
}

const UNKNOWN_RGBA = [9, 13, 20, 235]
const FREE_RGBA = [22, 58, 74, 96]

function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

function fitView(W: number, H: number, aw: number, ah: number): View {
  const scale = Math.min(W / aw, H / ah) * 0.92
  return {
    scale,
    offsetX: (W - aw * scale) / 2,
    offsetY: (H - ah * scale) / 2,
  }
}

// --------------------------------------------------------------------------- //
// Occupancy / room layers (rebuilt only when the map changes)
// --------------------------------------------------------------------------- //
function buildLayers(map: MapState, cfg: Config): Layers {
  const { w, h, grid } = map
  const res = map.res

  const mk = (): HTMLCanvasElement => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  const occ = mk()
  const glow = mk()
  const tint = mk()
  const reveal = mk()

  const octx = occ.getContext('2d')!
  const gctx = glow.getContext('2d')!
  const tctx = tint.getContext('2d')!

  const occImg = octx.createImageData(w, h)
  const glowImg = gctx.createImageData(w, h)
  const tintImg = tctx.createImageData(w, h)

  const freeMask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y // flip so image row 0 = world y max
    for (let x = 0; x < w; x++) {
      const v = grid[y * w + x]
      const i = (row * w + x) * 4
      if (v < 0) {
        occImg.data[i] = UNKNOWN_RGBA[0]
        occImg.data[i + 1] = UNKNOWN_RGBA[1]
        occImg.data[i + 2] = UNKNOWN_RGBA[2]
        occImg.data[i + 3] = UNKNOWN_RGBA[3]
      } else if (v === 0) {
        freeMask[y * w + x] = 1
        occImg.data[i] = FREE_RGBA[0]
        occImg.data[i + 1] = FREE_RGBA[1]
        occImg.data[i + 2] = FREE_RGBA[2]
        occImg.data[i + 3] = FREE_RGBA[3]
      } else {
        occImg.data[i] = 34
        occImg.data[i + 1] = 211
        occImg.data[i + 2] = 238
        occImg.data[i + 3] = 255
        glowImg.data[i] = 34
        glowImg.data[i + 1] = 211
        glowImg.data[i + 2] = 238
        glowImg.data[i + 3] = 255
      }
    }
  }
  octx.putImageData(occImg, 0, 0)
  gctx.putImageData(glowImg, 0, 0)

  // room vs corridor classification via free run lengths
  const hRun = new Int32Array(w * h)
  const vRun = new Int32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (freeMask[i]) hRun[i] = x > 0 && freeMask[i - 1] ? hRun[i - 1] + 1 : 1
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const i = y * w + x
      if (freeMask[i]) vRun[i] = y > 0 && freeMask[i - w] ? vRun[i - w] + 1 : 1
    }
  }
  const roomThresh = Math.max(6, Math.round(1.6 / res))
  const roomCell = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    if (freeMask[i] && hRun[i] >= roomThresh && vRun[i] >= roomThresh) roomCell[i] = 1
  }

  // connected components over room cells
  const label = new Int32Array(w * h).fill(-1)
  const comps: { n: number; sx: number; sy: number }[] = []
  const stack: number[] = []
  for (let i = 0; i < w * h; i++) {
    if (!roomCell[i] || label[i] >= 0) continue
    const id = comps.length
    let n = 0
    let sx = 0
    let sy = 0
    stack.push(i)
    label[i] = id
    while (stack.length) {
      const j = stack.pop()!
      const jx = j % w
      const jy = (j / w) | 0
      n++
      sx += jx
      sy += jy
      const nb = [
        jx > 0 ? j - 1 : -1,
        jx < w - 1 ? j + 1 : -1,
        jy > 0 ? j - w : -1,
        jy < h - 1 ? j + w : -1,
      ]
      for (const k of nb) {
        if (k >= 0 && roomCell[k] && label[k] < 0) {
          label[k] = id
          stack.push(k)
        }
      }
    }
    comps.push({ n, sx: sx / n, sy: sy / n })
  }
  const minArea = Math.round(1.0 / (res * res))
  const labels: Layers['labels'] = []
  const order = comps
    .map((c, i) => ({ ...c, i }))
    .filter((c) => c.n >= minArea)
    .sort((a, b) => b.sy - a.sy || a.sx - b.sx)
  const rank = new Map<number, number>()
  order.forEach((c, r) => rank.set(c.i, r + 1))

  for (let y = 0; y < h; y++) {
    const row = h - 1 - y
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const o = (row * w + x) * 4
      if (roomCell[i]) {
        tintImg.data[o] = 52
        tintImg.data[o + 1] = 211
        tintImg.data[o + 2] = 153
        tintImg.data[o + 3] = 30
      } else if (freeMask[i]) {
        tintImg.data[o] = 34
        tintImg.data[o + 1] = 211
        tintImg.data[o + 2] = 238
        tintImg.data[o + 3] = 14
      }
    }
  }
  tctx.putImageData(tintImg, 0, 0)

  order.forEach((c) => {
    const r = rank.get(c.i)!
    if (r > 12) return
    labels.push({
      label: `R${r}`,
      x: (c.sx + 0.5) * res,
      y: (c.sy + 0.5) * res,
      kind: 'room',
    })
  })

  return { occ, glow, tint, reveal, revealStart: 0, labels, w, h }
}

function updateReveal(layers: Layers, map: MapState, prev: Int8Array | null): void {
  if (!layers.reveal) return
  const { w, h, grid } = map
  const ctx = layers.reveal.getContext('2d')!
  const img = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const wasUnknown = prev ? prev[i] < 0 : true
      if (grid[i] >= 0 && wasUnknown) {
        const o = (row * w + x) * 4
        img.data[o] = 34
        img.data[o + 1] = 211
        img.data[o + 2] = 238
        img.data[o + 3] = 255
      }
    }
  }
  ctx.putImageData(img, 0, 0)
  layers.revealStart = performance.now()
}

// --------------------------------------------------------------------------- //
// Scene
// --------------------------------------------------------------------------- //
interface DroneView {
  x: number
  y: number
  yaw: number
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  view: View,
  snap: Snap,
  layers: Layers | null,
  drone: DroneView,
  mode: 'live' | 'export',
  hover?: { x: number; y: number } | null,
  survivorSeen?: Map<number, number>,
): void {
  const { cfg, map } = snap
  const aw = cfg.arena_w_m
  const ah = cfg.arena_h_m
  const { scale, offsetX, offsetY } = view
  const sx = (wx: number) => wx * scale + offsetX
  const sy = (wy: number) => (ah - wy) * scale + offsetY

  ctx.save()
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)

  // clip to arena for map content
  const ax = sx(0)
  const ay = sy(ah)
  const awPx = aw * scale
  const ahPx = ah * scale

  // 1. fine grid (0.5 m) and bold cell grid
  ctx.save()
  ctx.beginPath()
  ctx.rect(ax, ay, awPx, ahPx)
  ctx.clip()
  ctx.lineWidth = 1
  ctx.strokeStyle = C.grid
  ctx.beginPath()
  for (let gx = 0; gx <= aw + 0.001; gx += 0.5) {
    const px = Math.round(sx(gx)) + 0.5
    ctx.moveTo(px, ay)
    ctx.lineTo(px, ay + ahPx)
  }
  for (let gy = 0; gy <= ah + 0.001; gy += 0.5) {
    const py = Math.round(sy(gy)) + 0.5
    ctx.moveTo(ax, py)
    ctx.lineTo(ax + awPx, py)
  }
  ctx.stroke()

  ctx.lineWidth = 1.5
  ctx.strokeStyle = C.cell
  ctx.beginPath()
  for (let gx = 0; gx <= aw + 0.001; gx += cfg.cell_size_m) {
    const px = Math.round(sx(gx)) + 0.5
    ctx.moveTo(px, ay)
    ctx.lineTo(px, ay + ahPx)
  }
  for (let gy = 0; gy <= ah + 0.001; gy += cfg.cell_size_m) {
    const py = Math.round(sy(gy)) + 0.5
    ctx.moveTo(ax, py)
    ctx.lineTo(ax + awPx, py)
  }
  ctx.stroke()
  ctx.restore()

  // 2. occupancy
  if (layers && map && layers.w === map.w && layers.h === map.h) {
    ctx.imageSmoothingEnabled = false
    if (layers.glow) {
      ctx.save()
      ctx.shadowColor = C.wall
      ctx.shadowBlur = 12
      ctx.globalAlpha = 0.55
      ctx.drawImage(layers.glow, ax, ay, awPx, ahPx)
      ctx.restore()
    }
    ctx.drawImage(layers.occ!, ax, ay, awPx, ahPx)
    ctx.imageSmoothingEnabled = true

    // 3. room / corridor tint
    ctx.drawImage(layers.tint!, ax, ay, awPx, ahPx)

    // scan reveal
    const age = performance.now() - layers.revealStart
    if (age >= 0 && age < 400) {
      ctx.save()
      ctx.globalAlpha = (1 - age / 400) * 0.9
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(layers.reveal!, ax, ay, awPx, ahPx)
      ctx.restore()
    }

    // room labels
    ctx.font = '600 12px Inter, sans-serif'
    for (const l of layers.labels) {
      ctx.fillStyle = hexToRgba(C.ok, 0.85)
      ctx.fillText(l.label, sx(l.x) + 4, sy(l.y) - 4)
    }
  }

  // arena border
  ctx.lineWidth = 2
  ctx.strokeStyle = hexToRgba(C.accent, 0.35)
  ctx.strokeRect(ax, ay, awPx, ahPx)

  // axis labels
  ctx.fillStyle = C.axis
  ctx.font = '600 12px Inter, sans-serif'
  ctx.textAlign = 'center'
  const cols = Math.round(aw / cfg.cell_size_m)
  for (let c = 0; c < cols; c++) {
    const px = sx((c + 0.5) * cfg.cell_size_m)
    ctx.fillText(colLetter(c), px, ay - 6)
  }
  ctx.textAlign = 'right'
  const rows = Math.round(ah / cfg.cell_size_m)
  for (let r = 0; r < rows; r++) {
    const py = sy((r + 0.5) * cfg.cell_size_m)
    ctx.fillText(String(r + 1), ax - 6, py + 4)
  }
  ctx.textAlign = 'left'

  // header for export
  if (mode === 'export') {
    ctx.fillStyle = C.ink
    ctx.font = '700 26px Inter, sans-serif'
    ctx.fillText('AIRMOUSE GCS — FINAL OCCUPANCY MAP', ax, ay - 34)
    const m = snap.mission
    if (m) {
      ctx.fillStyle = C.dim
      ctx.font = '400 15px "JetBrains Mono", monospace'
      const f = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
      ctx.fillText(
        `state ${m.state}  time ${f(m.elapsed_s)}  explored ${m.explored_pct.toFixed(0)}%  survivors ${m.survivors_found}/6  distance ${m.distance_m.toFixed(1)}m`,
        ax,
        ay - 12,
      )
    }
  }

  // 4. planned path (dashed) + trail gradient
  if (snap.path && snap.path.trail.length > 1) {
    const trail = snap.path.trail
    ctx.lineWidth = 2.5
    for (let i = 1; i < trail.length; i++) {
      const a = i / trail.length
      ctx.strokeStyle = hexToRgba(C.accent, 0.12 + a * 0.55)
      ctx.beginPath()
      ctx.moveTo(sx(trail[i - 1][0]), sy(trail[i - 1][1]))
      ctx.lineTo(sx(trail[i][0]), sy(trail[i][1]))
      ctx.stroke()
    }
  }
  if (snap.path && snap.path.plan.length > 0) {
    ctx.save()
    ctx.setLineDash([7, 6])
    ctx.lineWidth = 2
    ctx.strokeStyle = hexToRgba(C.accent, 0.9)
    ctx.beginPath()
    ctx.moveTo(sx(drone.x), sy(drone.y))
    for (const p of snap.path.plan) ctx.lineTo(sx(p[0]), sy(p[1]))
    ctx.stroke()
    ctx.restore()
  }

  // 5. entry / exit marker
  const ex = sx(cfg.entry.x)
  const ey = sy(cfg.entry.y)
  ctx.save()
  ctx.strokeStyle = C.entry
  ctx.fillStyle = hexToRgba(C.entry, 0.15)
  ctx.lineWidth = 2
  ctx.beginPath()
  const s = Math.max(6, scale * 0.22)
  ctx.moveTo(ex, ey - s)
  ctx.lineTo(ex + s, ey)
  ctx.lineTo(ex, ey + s)
  ctx.lineTo(ex - s, ey)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = C.entry
  ctx.font = '600 11px Inter, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('ENTRY/EXIT', ex, ey + s + 14)
  ctx.textAlign = 'left'
  ctx.restore()

  // 6. survivor markers
  const now = performance.now()
  for (const key of Object.keys(snap.survivors)) {
    const sv = snap.survivors[Number(key)]
    const px = sx(sv.x)
    const py = sy(sv.y)
    // glow the cell
    const cell = cellLabel(sv.x, sv.y, cfg)
    const cx0 = sx(Math.floor(sv.x / cfg.cell_size_m) * cfg.cell_size_m)
    const cy0 = sy((Math.floor(sv.y / cfg.cell_size_m) + 1) * cfg.cell_size_m)
    const pulse = 0.5 + 0.5 * Math.sin(now / 350)
    ctx.fillStyle = hexToRgba(C.survivor, 0.12 + 0.1 * pulse)
    ctx.fillRect(cx0 + 1, cy0 + 1, cfg.cell_size_m * scale - 2, cfg.cell_size_m * scale - 2)

    // ripple on first sight
    const seen = survivorSeen?.get(sv.id)
    if (seen != null) {
      const a = now - seen
      if (a >= 0 && a < 900) {
        ctx.strokeStyle = hexToRgba(C.survivor, 1 - a / 900)
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.arc(px, py, 8 + (a / 900) * 46, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // pulsing rings
    ctx.strokeStyle = hexToRgba(C.survivor, 0.5 + 0.4 * pulse)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(px, py, 9 + pulse * 3, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = hexToRgba(C.survivor, 0.35)
    ctx.beginPath()
    ctx.arc(px, py, 15, 0, Math.PI * 2)
    ctx.stroke()

    // icon
    ctx.fillStyle = C.survivor
    ctx.beginPath()
    ctx.arc(px, py - 3, 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(px - 4, py, 8, 8)

    // id badge
    const badge = `S${sv.id}`
    ctx.font = '700 11px Inter, sans-serif'
    const bw = ctx.measureText(badge).width + 10
    ctx.fillStyle = hexToRgba('#000000', 0.65)
    ctx.fillRect(px - bw / 2, py - 34, bw, 16)
    ctx.fillStyle = C.survivor
    ctx.textAlign = 'center'
    ctx.fillText(badge, px, py - 22)

    // cell label chip
    ctx.font = '600 10px "JetBrains Mono", monospace'
    const cw = ctx.measureText(cell).width + 10
    ctx.fillStyle = hexToRgba(C.survivor, 0.9)
    ctx.fillRect(px - cw / 2, py + 14, cw, 15)
    ctx.fillStyle = '#0b0f17'
    ctx.fillText(cell, px, py + 25)
    ctx.textAlign = 'left'
  }

  // 7. drone sprite + FOV wedge
  const dx = sx(drone.x)
  const dy = sy(drone.y)
  const ang = -drone.yaw
  const fov = Math.PI / 3
  ctx.save()
  ctx.translate(dx, dy)
  ctx.rotate(ang)
  const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 3.5 * scale)
  grad.addColorStop(0, hexToRgba(C.accent, 0.22))
  grad.addColorStop(1, hexToRgba(C.accent, 0))
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.arc(0, 0, 3.5 * scale, -fov / 2, fov / 2)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = C.drone
  ctx.strokeStyle = C.accent
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(12, 0)
  ctx.lineTo(-8, 7)
  ctx.lineTo(-8, -7)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()

  // HUD (live only)
  if (mode === 'live') {
    // legend
    const items: [string, string][] = [
      ['rgba(9,13,20,0.95)', 'unknown'],
      ['rgb(22,58,74)', 'free'],
      [C.wall, 'wall'],
      [C.survivor, 'survivor'],
      [C.entry, 'entry/exit'],
    ]
    ctx.fillStyle = hexToRgba('#000000', 0.5)
    ctx.fillRect(12, 12, 150, 22 + items.length * 18)
    ctx.font = '11px Inter, sans-serif'
    ctx.fillStyle = C.ink
    ctx.fillText('LEGEND', 22, 30)
    items.forEach(([col, name], i) => {
      const yy = 48 + i * 18
      ctx.fillStyle = col
      ctx.fillRect(22, yy - 8, 10, 10)
      ctx.fillStyle = C.dim
      ctx.fillText(name, 38, yy)
    })

    // scale bar
    const barM = 2
    const barPx = barM * scale
    const bx = 16
    const by = H - 22
    ctx.strokeStyle = C.ink
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.lineTo(bx + barPx, by)
    ctx.moveTo(bx, by - 4)
    ctx.lineTo(bx, by + 4)
    ctx.moveTo(bx + barPx, by - 4)
    ctx.lineTo(bx + barPx, by + 4)
    ctx.stroke()
    ctx.fillStyle = C.ink
    ctx.font = '11px "JetBrains Mono", monospace'
    ctx.fillText(`${barM} m`, bx + 4, by - 8)

    // minimap
    const mmW = 150
    const mmH = (mmW * ah) / aw
    const mmX = W - mmW - 16
    const mmY = H - mmH - 16
    ctx.fillStyle = 'rgba(6,10,16,0.85)'
    ctx.fillRect(mmX, mmY, mmW, mmH)
    ctx.strokeStyle = hexToRgba(C.accent, 0.4)
    ctx.lineWidth = 1
    ctx.strokeRect(mmX, mmY, mmW, mmH)
    const mxs = mmW / aw
    const mys = mmH / ah
    if (map && layers?.occ) {
      ctx.imageSmoothingEnabled = false
      ctx.globalAlpha = 0.85
      ctx.drawImage(layers.occ, mmX, mmY, mmW, mmH)
      ctx.globalAlpha = 1
      ctx.imageSmoothingEnabled = true
    }
    for (const key of Object.keys(snap.survivors)) {
      const sv = snap.survivors[Number(key)]
      ctx.fillStyle = C.survivor
      ctx.beginPath()
      ctx.arc(mmX + sv.x * mxs, mmY + (ah - sv.y) * mys, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = C.drone
    ctx.beginPath()
    ctx.arc(mmX + drone.x * mxs, mmY + (ah - drone.y) * mys, 2.5, 0, Math.PI * 2)
    ctx.fill()
    // viewport rect
    const vx0 = Math.max(0, (0 - offsetX) / scale)
    const vy0 = Math.max(0, (0 - offsetY) / scale)
    const vx1 = Math.min(aw, (W - offsetX) / scale)
    const vy1 = Math.min(ah, (H - offsetY) / scale)
    ctx.strokeStyle = hexToRgba(C.accent, 0.9)
    ctx.strokeRect(mmX + vx0 * mxs, mmY + (ah - vy1) * mys, (vx1 - vx0) * mxs, (vy1 - vy0) * mys)

    // hover tooltip
    if (hover && map) {
      const wx = (hover.x - offsetX) / scale
      const wy = ah - (hover.y - offsetY) / scale
      if (wx >= 0 && wx < aw && wy >= 0 && wy < ah) {
        const gx = Math.floor(wx / map.res)
        const gy = Math.floor(wy / map.res)
        const v = map.grid[gy * map.w + gx]
        const stateName = v == null ? '—' : v < 0 ? 'unknown' : v === 0 ? 'free' : 'wall'
        const label = cellLabel(wx, wy, cfg)
        const room = layers?.labels.find((l) => Math.hypot(l.x - wx, l.y - wy) < 1.2)
        const text = `${label}  ${stateName}${room ? '  ' + room.label : ''}`
        ctx.font = '12px "JetBrains Mono", monospace'
        const tw = ctx.measureText(text).width + 12
        ctx.fillStyle = 'rgba(6,10,16,0.92)'
        ctx.fillRect(hover.x + 12, hover.y + 12, tw, 22)
        ctx.strokeStyle = hexToRgba(C.accent, 0.5)
        ctx.strokeRect(hover.x + 12, hover.y + 12, tw, 22)
        ctx.fillStyle = C.ink
        ctx.fillText(text, hover.x + 18, hover.y + 27)
      }
    }
  }

  ctx.restore()
}

// --------------------------------------------------------------------------- //
export default function MapPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<View>({ scale: 40, offsetX: 0, offsetY: 0 })
  const layersRef = useRef<Layers | null>(null)
  const lastVersionRef = useRef(-1)
  const prevGridRef = useRef<Int8Array | null>(null)
  const survivorsSeenRef = useRef<Map<number, number>>(new Map())
  const hoverRef = useRef<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const sizeRef = useRef({ w: 800, h: 600 })
  // True once the operator pans/zooms; until then the view auto-fits the arena.
  const userViewRef = useRef(false)
  const poseRef = useRef<{ prev: Pose | null; cur: Pose | null; t: number }>({
    prev: null,
    cur: null,
    t: 0,
  })

  const [follow, setFollow] = useState(false)
  const followRef = useRef(false)

  // pose tracking for smooth interpolation
  const telemetry = useStore((s) => s.telemetry)
  useEffect(() => {
    if (telemetry) {
      poseRef.current = { prev: poseRef.current.cur, cur: telemetry.pose, t: performance.now() }
    }
  }, [telemetry])

  // register the map exporter for the mission-end report
  useEffect(() => {
    setMapExporter(() => {
      const snap = snapshot()
      const c = document.createElement('canvas')
      c.width = 1600
      c.height = 1600
      const ctx = c.getContext('2d')
      if (!ctx) return null
      const view = fitView(1600, 1600, snap.cfg.arena_w_m, snap.cfg.arena_h_m)
      const d = interpolatedPose()
      drawScene(ctx, 1600, 1600, view, snap, layersRef.current, d, 'export', null, survivorsSeenRef.current)
      try {
        return c.toDataURL('image/png')
      } catch {
        return null
      }
    })
    return () => setMapExporter(null)
  }, [])

  const snapshot = useCallback((): Snap => {
    const st = useStore.getState()
    return {
      map: st.map,
      path: st.path,
      survivors: st.survivors,
      mission: st.mission,
      cfg: st.config ?? FALLBACK_CONFIG,
    }
  }, [])

  const interpolatedPose = useCallback((): DroneView => {
    const n = poseRef.current
    if (!n.cur) return { x: 0.5, y: 0.5, yaw: Math.PI / 2 }
    if (!n.prev) return { x: n.cur.x, y: n.cur.y, yaw: n.cur.yaw }
    const t = Math.min(1, (performance.now() - n.t) / 100)
    const lerp = (a: number, b: number) => a + (b - a) * t
    let dyaw = n.cur.yaw - n.prev.yaw
    dyaw = ((dyaw + Math.PI) % (Math.PI * 2)) - Math.PI
    return { x: lerp(n.prev.x, n.cur.x), y: lerp(n.prev.y, n.cur.y), yaw: n.prev.yaw + dyaw * t }
  }, [])

  // size handling
  useEffect(() => {
    const el = containerRef.current
    const canvas = canvasRef.current
    if (!el || !canvas) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      sizeRef.current = { w: r.width, h: r.height }
      canvas.width = Math.max(1, Math.floor(r.width * dpr))
      canvas.height = Math.max(1, Math.floor(r.height * dpr))
      canvas.style.width = `${r.width}px`
      canvas.style.height = `${r.height}px`
      const st = useStore.getState()
      const cfg = st.config ?? FALLBACK_CONFIG
      if (followRef.current || !userViewRef.current) {
        viewRef.current = fitView(r.width, r.height, cfg.arena_w_m, cfg.arena_h_m)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // main render loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    let alive = true
    const loop = () => {
      if (!alive) return
      const st = useStore.getState()
      const cfg = st.config ?? FALLBACK_CONFIG
      const snap = snapshot()

      if (snap.map && snap.map.version !== lastVersionRef.current) {
        const fresh = snap.map.version !== lastVersionRef.current
        layersRef.current = buildLayers(snap.map, cfg)
        if (fresh) updateReveal(layersRef.current, snap.map, prevGridRef.current)
        prevGridRef.current = snap.map.grid
        lastVersionRef.current = snap.map.version
      }

      // track first-seen survivors for ripple
      for (const k of Object.keys(snap.survivors)) {
        const id = Number(k)
        if (!survivorsSeenRef.current.has(id)) survivorsSeenRef.current.set(id, performance.now())
      }

      const d = interpolatedPose()
      const { w, h } = sizeRef.current
      if (followRef.current) {
        const v = viewRef.current
        viewRef.current = {
          scale: v.scale,
          offsetX: w / 2 - d.x * v.scale,
          offsetY: h / 2 - (cfg.arena_h_m - d.y) * v.scale,
        }
      }

      const ctx = canvas.getContext('2d')
      if (ctx) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        drawScene(ctx, w, h, viewRef.current, snap, layersRef.current, d, 'live', hoverRef.current, survivorsSeenRef.current)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [snapshot, interpolatedPose])

  // pointer interaction
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const v = viewRef.current
    const cfg = useStore.getState().config ?? FALLBACK_CONFIG
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const nscale = Math.max(6, Math.min(400, v.scale * factor))
    const wx = (mx - v.offsetX) / v.scale
    const wy = cfg.arena_h_m - (my - v.offsetY) / v.scale
    viewRef.current = {
      scale: nscale,
      offsetX: mx - wx * nscale,
      offsetY: my - (cfg.arena_h_m - wy) * nscale,
    }
    userViewRef.current = true
    setFollow(false)
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, ox: viewRef.current.offsetX, oy: viewRef.current.offsetY }
    setFollow(false)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    hoverRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    if (dragRef.current) {
      userViewRef.current = true
      viewRef.current = {
        ...viewRef.current,
        offsetX: dragRef.current.ox + (e.clientX - dragRef.current.x),
        offsetY: dragRef.current.oy + (e.clientY - dragRef.current.y),
      }
    }
  }, [])
  const onPointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  const fit = useCallback(() => {
    const cfg = useStore.getState().config ?? FALLBACK_CONFIG
    const { w, h } = sizeRef.current
    viewRef.current = fitView(w, h, cfg.arena_w_m, cfg.arena_h_m)
    userViewRef.current = false
    setFollow(false)
  }, [])
  const zoom = useCallback((factor: number) => {
    userViewRef.current = true
    const v = viewRef.current
    const { w, h } = sizeRef.current
    const cx = w / 2
    const cy = h / 2
    const cfg = useStore.getState().config ?? FALLBACK_CONFIG
    const nscale = Math.max(6, Math.min(400, v.scale * factor))
    const wx = (cx - v.offsetX) / v.scale
    const wy = cfg.arena_h_m - (cy - v.offsetY) / v.scale
    viewRef.current = {
      scale: nscale,
      offsetX: cx - wx * nscale,
      offsetY: cy - (cfg.arena_h_m - wy) * nscale,
    }
    setFollow(false)
  }, [])

  const toggleFollow = useCallback(() => {
    setFollow((f) => {
      followRef.current = !f
      return !f
    })
  }, [])
  useEffect(() => {
    followRef.current = follow
  }, [follow])

  const btn = 'btn px-2.5 py-1 text-[11px] tracking-wider'

  return (
    <div ref={containerRef} className="panel rise relative h-full w-full min-h-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-crosshair"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          hoverRef.current = null
          dragRef.current = null
        }}
      />
      <div className="absolute right-3 top-3 flex gap-2">
        <button className={`${btn} ${follow ? 'border-accent/70 text-accent' : ''}`} onClick={toggleFollow}>
          Follow{follow ? ' ●' : ''}
        </button>
        <button className={btn} onClick={fit}>
          Fit arena
        </button>
        <button className={btn} onClick={() => zoom(1.2)}>
          +
        </button>
        <button className={btn} onClick={() => zoom(1 / 1.2)}>
          −
        </button>
      </div>
      <div className="micro absolute bottom-2 right-4">2D OCCUPANCY · LIVE</div>
    </div>
  )
}
