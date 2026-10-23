// Pre-flight screen (state IDLE / PREFLIGHT / READY).
// The 5:00 SETUP countdown is purely local (no drone command). The checklist
// is driven by the drone's preflight message.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useConfig, useStore } from '../store'
import type { PreflightChecks } from '../lib/protocol'

const CHECK_LABELS: [keyof PreflightChecks, string][] = [
  ['link', 'Datalink'],
  ['video', 'Camera feed'],
  ['map_stream', 'Map stream'],
  ['battery', 'Battery'],
  ['sensors', 'Sensors'],
  ['failsafes', 'Failsafes'],
]

function fmt(s: number): string {
  const t = Math.max(0, Math.floor(s))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export default function PreflightScreen() {
  const cfg = useConfig()
  const preflight = useStore((s) => s.preflight)
  const mission = useStore((s) => s.mission)
  const wsStatus = useStore((s) => s.wsStatus)

  const [setupStarted, setSetupStarted] = useState(false)
  const [remaining, setRemaining] = useState(cfg.setup_s)
  const [seenPass, setSeenPass] = useState<Record<string, boolean>>({})
  const prevRef = useRef<Record<string, boolean>>({})

  useEffect(() => {
    if (!setupStarted) return
    const id = window.setInterval(() => {
      setRemaining((r) => (r > 0 ? r - 1 : 0))
    }, 1000)
    return () => window.clearInterval(id)
  }, [setupStarted])

  const checks = preflight?.checks
  useEffect(() => {
    if (!checks) return
    const next: Record<string, boolean> = {}
    for (const [k] of CHECK_LABELS) {
      const cur = checks[k]
      const prev = prevRef.current[k]
      next[k] = cur && !prev ? true : seenPass[k] ?? false
    }
    prevRef.current = { ...checks }
    setSeenPass(next)
  }, [checks, seenPass])

  const allGo = useMemo(
    () => !!checks && CHECK_LABELS.every(([k]) => checks[k]),
    [checks],
  )

  const state = mission?.state ?? 'IDLE'

  return (
    <div className="flex h-full w-full min-h-0 gap-4">
      <div className="panel flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-10">
        <div className="text-center">
          <div className="micro">PRE-FLIGHT</div>
          <div className="mt-2 text-5xl font-bold tracking-[0.3em] title-grad">SETUP</div>
        </div>

        <div
          className="num text-[96px] font-bold leading-none text-accent"
          style={{ fontVariantNumeric: 'tabular-nums', textShadow: '0 0 46px rgba(53,224,240,0.4)' }}
        >
          {fmt(remaining)}
        </div>

        {!setupStarted ? (
          <button
            type="button"
            onClick={() => setSetupStarted(true)}
            className="btn border-accent/60 px-8 py-3 text-sm tracking-[0.25em] text-accent"
          >
            Begin setup
          </button>
        ) : (
          <div className="micro">{remaining > 0 ? 'setup window running' : 'setup window elapsed'}</div>
        )}

        <div className="micro text-dim">
          ws {wsStatus} · state {state} · no flight commands are sent by this screen
        </div>
      </div>

      <div className="panel flex w-[420px] shrink-0 flex-col p-6">
        <div className="micro">SYSTEM CHECKS</div>
        <div className="mt-4 flex flex-1 flex-col gap-3">
          {CHECK_LABELS.map(([key, label]) => {
            const ok = checks ? checks[key] : false
            const passed = ok || seenPass[key]
            return (
              <div
                key={key}
                className={`flex items-center gap-3 rounded-[10px] border px-4 py-3 transition-all duration-250 ${
                  ok
                    ? 'border-ok/50 bg-ok/10 shadow-[0_0_24px_-12px_rgba(62,230,160,0.95)]'
                    : 'border-border bg-black/20'
                }`}
              >
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border text-[13px] font-bold ${
                    ok
                      ? 'tickpop border-ok bg-ok/20 text-ok'
                      : passed
                        ? 'border-warn/60 text-warn'
                        : 'border-border text-dim'
                  }`}
                >
                  {ok ? '✓' : passed ? '…' : '·'}
                </span>
                <span className="flex-1 text-sm font-semibold uppercase tracking-wider text-ink">
                  {label}
                </span>
                <span className={`num text-xs ${ok ? 'text-ok' : 'text-dim'}`}>
                  {ok ? 'GO' : 'WAIT'}
                </span>
              </div>
            )
          })}
        </div>

        <div
          className={`mt-4 rounded-[12px] border px-4 py-4 text-center transition-all duration-250 ${
            allGo
              ? 'border-ok bg-ok/15 shadow-[0_0_34px_-14px_rgba(62,230,160,0.95)]'
              : 'border-border bg-black/20'
          }`}
        >
          <div className={`text-lg font-bold uppercase tracking-[0.25em] ${allGo ? 'text-ok' : 'text-dim'}`}>
            {allGo ? 'All systems go' : 'Waiting for systems'}
          </div>
          <div className="micro mt-1">
            {allGo ? 'START control unlocked' : 'hold START becomes available when READY'}
          </div>
        </div>
      </div>
    </div>
  )
}
