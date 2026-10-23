// Cell labels are computed by the GCS, not the drone.
// Cell label = column letter from floor(x/cell_size) (A..) + row number
// floor(y/cell_size)+1.  Arena frame: (0,0) bottom-left, x right, y up.

import type { Config } from './protocol'

export function colLetter(cx: number): string {
  let n = cx
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

export function cellLabel(x: number, y: number, cfg: Config): string {
  const cx = Math.floor(x / cfg.cell_size_m)
  const cy = Math.floor(y / cfg.cell_size_m)
  return `${colLetter(cx)}${cy + 1}`
}

export function cellLabelAtCell(cx: number, cy: number): string {
  return `${colLetter(cx)}${cy + 1}`
}

export interface CellRect {
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
}

export function cellRect(label: string, cfg: Config): CellRect | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(label.trim())
  if (!m) return null
  let cx = 0
  for (const ch of m[1].toUpperCase()) {
    cx = cx * 26 + (ch.charCodeAt(0) - 64)
  }
  cx -= 1
  const cy = parseInt(m[2], 10) - 1
  return {
    cx,
    cy,
    x: cx * cfg.cell_size_m,
    y: cy * cfg.cell_size_m,
    w: cfg.cell_size_m,
    h: cfg.cell_size_m,
  }
}

// Parse a label into grid indices without a config.
export function parseLabel(label: string): { cx: number; cy: number } | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(label.trim())
  if (!m) return null
  let cx = 0
  for (const ch of m[1].toUpperCase()) {
    cx = cx * 26 + (ch.charCodeAt(0) - 64)
  }
  return { cx: cx - 1, cy: parseInt(m[2], 10) - 1 }
}
