// Six survivor slots with grid-cell labels, confidence, thumbnails and find alerts.
import { useEffect, useRef, useState } from 'react'
import { useConfig, useStore } from '../store'
import { cellLabel } from '../lib/grid'

function fmtT(s: number): string {
  const t = Number.isFinite(s) && s > 0 ? s : 0
  const m = Math.floor(t / 60)
  const sec = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

const IDS = [1, 2, 3, 4, 5, 6]

export default function SurvivorPanel() {
  const cfg = useConfig()
  const survivors = useStore((s) => s.survivors)
  const survivorOrder = useStore((s) => s.survivorOrder)
  const count = Object.keys(survivors).length

  const [flashing, setFlashing] = useState<Record<number, boolean>>({})
  const [headerFlash, setHeaderFlash] = useState(false)
  const prevCountRef = useRef(0)
  const clearTimerRef = useRef<number | null>(null)
  const audioRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    const init = () => {
      try {
        if (!audioRef.current) {
          const Ctx: typeof AudioContext | undefined =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          if (Ctx) audioRef.current = new Ctx()
        }
      } catch {
        /* audio unavailable */
      }
      window.removeEventListener('pointerdown', init)
      window.removeEventListener('keydown', init)
    }
    window.addEventListener('pointerdown', init)
    window.addEventListener('keydown', init)
    return () => {
      window.removeEventListener('pointerdown', init)
      window.removeEventListener('keydown', init)
    }
  }, [])

  const beep = () => {
    try {
      const ctx = audioRef.current
      if (!ctx) return
      if (ctx.state === 'suspended') void ctx.resume()
      const t0 = ctx.currentTime
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(660, t0)
      osc.frequency.linearRampToValueAtTime(880, t0 + 0.1)
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + 0.14)
    } catch {
      /* never throw on audio */
    }
  }

  useEffect(() => {
    const prev = prevCountRef.current
    const next = survivorOrder.length
    prevCountRef.current = next
    if (next <= prev) return

    const added = survivorOrder.slice(prev)
    const patch: Record<number, boolean> = {}
    for (const id of added) patch[id] = true
    setFlashing((f) => ({ ...f, ...patch }))
    setHeaderFlash(true)
    beep()

    if (clearTimerRef.current != null) window.clearTimeout(clearTimerRef.current)
    clearTimerRef.current = window.setTimeout(() => {
      setFlashing((f) => {
        const c = { ...f }
        for (const id of added) delete c[id]
        return c
      })
      setHeaderFlash(false)
      clearTimerRef.current = null
    }, 1200)
  }, [survivorOrder])

  useEffect(
    () => () => {
      if (clearTimerRef.current != null) window.clearTimeout(clearTimerRef.current)
    },
    [],
  )

  const recent = survivorOrder.slice(-3)

  return (
    <div className="panel flex h-full w-full min-h-0 flex-col overflow-hidden">
      <div className="panel-head">
        <span className="micro">SURVIVORS</span>
        <span
          className={`num rounded-full border px-2 py-0.5 text-[11px] font-bold tracking-wider ${
            headerFlash
              ? 'flash border-survivor/70 bg-survivor/15 text-survivor'
              : 'border-border text-dim'
          }`}
        >
          FOUND {count}/6
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-y-auto p-2">
        {IDS.map((id) => {
          const s = survivors[id]
          const isRecent = recent.includes(id)
          if (!s) {
            return (
              <div
                key={id}
                className="group flex min-h-[80px] flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed border-border/60 bg-black/20 p-2 transition-colors duration-300 hover:border-accent/30"
              >
                <span className="micro">S{id}</span>
                <span className="relative flex h-6 w-6 items-center justify-center">
                  <span className="absolute inset-0 rounded-full border border-border/70" />
                  <span className="h-1 w-1 rounded-full bg-dim/70" />
                </span>
                <span className="text-xs text-dim">searching…</span>
              </div>
            )
          }
          const conf = Math.max(0, Math.min(1, s.conf))
          return (
            <div
              key={id}
              className={`relative flex min-h-[80px] gap-2 overflow-hidden rounded-[10px] border p-2 transition-all duration-300 ${
                flashing[id] ? 'flash ' : ''
              }${
                isRecent
                  ? 'border-survivor/70 bg-survivor/10 shadow-[0_0_28px_-10px_rgba(255,122,156,0.95)] ring-1 ring-survivor/40'
                  : 'border-border bg-gradient-to-b from-white/[0.03] to-black/20 hover:border-survivor/40'
              }`}
            >
              {s.snapshot ? (
                <img
                  src={'data:image/jpeg;base64,' + s.snapshot}
                  alt={`survivor ${id}`}
                  className="h-16 w-16 shrink-0 rounded-md object-cover ring-1 ring-black/50"
                />
              ) : (
                <div className="h-16 w-16 shrink-0 rounded-md bg-black/40 ring-1 ring-border/60" />
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center justify-between">
                  <span className="micro">S{id}</span>
                  <span className="num text-[10px] text-dim">T+{fmtT(s.t)}</span>
                </div>
                <div
                  className="num mt-0.5 text-[26px] font-bold leading-none text-survivor"
                  style={{ textShadow: '0 0 18px rgba(255,122,156,0.45)' }}
                >
                  {cellLabel(s.x, s.y, cfg)}
                </div>
                <div className="mt-auto flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/40">
                    <div
                      className="h-full rounded-full bg-survivor"
                      style={{ width: `${conf * 100}%` }}
                    />
                  </div>
                  <span className="num text-[10px] text-dim">{Math.round(conf * 100)}%</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
