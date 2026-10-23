// The ONLY place that can send flight commands. Two controls exist:
//   START  - press-and-hold 1.5 s, enabled only when the drone is READY
//   ABORT  - single press, enabled while airborne
// Nothing else in the app may call sendCommand().

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { sendCommand } from '../lib/ws'
import { isReplay } from '../lib/replay'

interface HoldButtonProps {
  label: string
  enabled: boolean
  holdMs?: number
  onComplete: () => void
  tone?: 'ok' | 'crit'
  doneLabel?: string
}

export function HoldButton({
  label,
  enabled,
  holdMs = 1500,
  onComplete,
  tone = 'ok',
  doneLabel = 'HOLD',
}: HoldButtonProps) {
  const [progress, setProgress] = useState(0)
  const holding = useRef(false)
  const raf = useRef(0)
  const start = useRef(0)

  const stop = useCallback(() => {
    holding.current = false
    cancelAnimationFrame(raf.current)
    setProgress(0)
  }, [])

  const tick = useCallback(
    (now: number) => {
      if (!holding.current) return
      const p = Math.min(1, (now - start.current) / holdMs)
      setProgress(p)
      if (p >= 1) {
        holding.current = false
        setProgress(0)
        onComplete()
        return
      }
      raf.current = requestAnimationFrame(tick)
    },
    [holdMs, onComplete],
  )

  const begin = useCallback(() => {
    if (!enabled || holding.current) return
    holding.current = true
    start.current = performance.now()
    raf.current = requestAnimationFrame(tick)
  }, [enabled, tick])

  useEffect(() => stop, [stop])

  const fill =
    tone === 'ok'
      ? 'linear-gradient(90deg, rgba(62,230,160,0.32), rgba(70,240,192,0.58))'
      : 'linear-gradient(90deg, rgba(255,93,115,0.32), rgba(255,122,156,0.58))'

  return (
    <button
      type="button"
      disabled={!enabled}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      className={`cmd-btn w-full px-4 py-3 text-sm font-bold uppercase tracking-[0.2em] ${
        tone === 'ok' ? 'cmd-ok' : 'cmd-crit'
      } ${enabled ? (tone === 'ok' ? 'breathe' : '') : 'cmd-disabled cursor-not-allowed text-dim'}`}
    >
      <span
        className="absolute inset-y-0 left-0 transition-[width] duration-75"
        style={{ width: `${progress * 100}%`, background: fill }}
      />
      {progress > 0 && (
        <span
          className="absolute inset-y-0 w-[2px] bg-white/80"
          style={{ left: `${progress * 100}%`, boxShadow: '0 0 10px rgba(255,255,255,0.9)' }}
        />
      )}
      <span className="relative">
        {holding.current && progress > 0 ? `${doneLabel} ${Math.round(progress * 100)}%` : label}
      </span>
    </button>
  )
}

export default function ControlBar() {
  const mission = useStore((s) => s.mission)
  const state = mission?.state ?? 'IDLE'
  const replay = isReplay()

  const canStart = !replay && state === 'READY'
  const canAbort =
    !replay &&
    (state === 'PREFLIGHT' || state === 'READY' || state === 'EXPLORING' || state === 'RETURNING')

  return (
    <div className="panel rise flex w-80 shrink-0 flex-col justify-center gap-2 px-4 py-2">
      <div className="flex items-center justify-between">
        <span className="micro flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_currentColor]" />
          COMMAND
        </span>
        <span
          className={`num rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
            canStart
              ? 'border-ok/60 bg-ok/10 text-ok'
              : 'border-border text-dim'
          }`}
        >
          {replay ? 'REPLAY — LOCKED' : state}
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <HoldButton
          label="Hold to START"
          doneLabel="STARTING"
          enabled={canStart}
          onComplete={() => sendCommand('START')}
          tone="ok"
        />
        <button
          type="button"
          disabled={!canAbort}
          onClick={() => sendCommand('ABORT')}
          className={`cmd-btn px-6 text-sm font-bold uppercase tracking-[0.2em] ${
            canAbort ? 'cmd-crit' : 'cmd-disabled cursor-not-allowed text-dim'
          }`}
        >
          ABORT
        </button>
      </div>
      <div className="micro text-center text-[9px] tracking-[0.16em]">
        {canStart ? 'all systems go — hold START to launch' : 'operator commands: START / ABORT only'}
      </div>
    </div>
  )
}
