// Replay engine. Feeds recorded ingest messages into the same zustand store
// that live mode uses - only the data source changes.

import { useStore } from '../store'
import type { ServerMessage } from './protocol'

interface Entry {
  t: number
  msg: ServerMessage
}

const MESSAGE_TYPES = new Set([
  'telemetry',
  'mission',
  'map',
  'path',
  'survivor',
  'failsafe',
  'preflight',
  'event',
])

export interface ReplayStatus {
  ready: boolean
  playing: boolean
  speed: number
  t: number
  duration: number
  error: string | null
}

const status: ReplayStatus = {
  ready: false,
  playing: false,
  speed: 1,
  t: 0,
  duration: 0,
  error: null,
}

let entries: Entry[] = []
let idx = 0
let clock = 0
let lastWall = 0
let lastEmit = 0
let raf = 0
const listeners = new Set<(s: ReplayStatus) => void>()

function snapshot(): ReplayStatus {
  return { ...status }
}

function emit(force = false) {
  const now = performance.now()
  if (!force && now - lastEmit < 100) return
  lastEmit = now
  const s = snapshot()
  listeners.forEach((fn) => fn(s))
}

export function onReplayStatus(fn: (s: ReplayStatus) => void): () => void {
  listeners.add(fn)
  fn(snapshot())
  return () => listeners.delete(fn)
}

export function isReplay(): boolean {
  return new URLSearchParams(location.search).has('file')
}

export async function loadReplay(file: string): Promise<void> {
  const name = file.replace(/^.*[\\/]/, '')
  status.error = null
  try {
    const res = await fetch(`/api/logs/${encodeURIComponent(name)}`)
    if (!res.ok) throw new Error(`log not found (${res.status})`)
    const text = await res.text()
    const rows: Entry[] = []
    let base = 0
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      if (rec.dir !== 'in') continue
      if (typeof rec.kind !== 'string' || !MESSAGE_TYPES.has(rec.kind)) continue
      const ts = Date.parse(String(rec.ts))
      if (Number.isNaN(ts)) continue
      if (base === 0) base = ts
      rows.push({ t: (ts - base) / 1000, msg: rec.payload as ServerMessage })
    }
    rows.sort((a, b) => a.t - b.t)
    entries = rows
    status.duration = rows.length ? rows[rows.length - 1].t : 0
    status.ready = true
    seek(0)
    emit(true)
  } catch (err) {
    status.error = err instanceof Error ? err.message : 'failed to load log'
    status.ready = false
    emit(true)
  }
}

function apply() {
  while (idx < entries.length && entries[idx].t <= clock) {
    useStore.getState().applyMessage(entries[idx].msg)
    idx++
  }
}

function loop() {
  if (!status.playing) return
  const now = performance.now()
  const dt = ((now - lastWall) / 1000) * status.speed
  lastWall = now
  clock = Math.min(status.duration, clock + dt)
  apply()
  emit()
  if (clock >= status.duration && idx >= entries.length) {
    status.playing = false
    status.t = clock
    emit(true)
    return
  }
  status.t = clock
  raf = requestAnimationFrame(loop)
}

export function play(): void {
  if (!status.ready || status.playing) return
  if (clock >= status.duration) seek(0)
  status.playing = true
  lastWall = performance.now()
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(loop)
  emit(true)
}

export function pause(): void {
  status.playing = false
  cancelAnimationFrame(raf)
  emit(true)
}

export function toggle(): void {
  if (status.playing) pause()
  else play()
}

export function setSpeed(speed: number): void {
  status.speed = speed
  emit(true)
}

export function seek(to: number): void {
  const target = Math.max(0, Math.min(status.duration, to))
  useStore.getState().resetMission()
  clock = target
  status.t = target
  idx = 0
  apply()
  lastWall = performance.now()
  emit(true)
}
