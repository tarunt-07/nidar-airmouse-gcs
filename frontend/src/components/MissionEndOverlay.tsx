// Mission-end overlay. Shows the debrief for EXITED, ABORTED and FAILSAFE.
// On first entering a terminal state it automatically POSTs the final map PNG
// and a JSON report to /api/report (no operator input).
//
// In simulator mode the overlay also offers a two-step RESET SIM control that
// returns the drone to READY and clears the dashboard for another run. This is
// a demo convenience only: it is never shown in replay mode and never sent to
// real drone hardware.

import { useEffect, useRef, useState } from 'react'
import { useConfig, useStore } from '../store'
import { cellLabel } from '../lib/grid'
import { exportFinalMap } from '../lib/mapExport'
import { isReplay } from '../lib/replay'

function fmt(s: number): string {
  const t = Math.max(0, Math.floor(s))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export default function MissionEndOverlay() {
  const cfg = useConfig()
  const mission = useStore((s) => s.mission)
  const survivors = useStore((s) => s.survivors)
  const telemetry = useStore((s) => s.telemetry)
  const failsafe = useStore((s) => s.failsafe)

  const [reportState, setReportState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const sentRef = useRef(false)

  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const resetTimer = useRef<number | null>(null)

  const state = mission?.state
  const active = state === 'EXITED' || state === 'ABORTED' || state === 'FAILSAFE'
  const replay = isReplay()
  const simMode = cfg.sim_mode === true

  useEffect(() => {
    if (!active) {
      sentRef.current = false
      setReportState('idle')
      setConfirmReset(false)
      setResetting(false)
      setResetError(null)
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current)
        resetTimer.current = null
      }
      return
    }
    if (sentRef.current) return
    sentRef.current = true
    setReportState('sending')

    const found = Object.values(survivors).sort((a, b) => a.id - b.id)
    const report = {
      state,
      elapsed_s: mission?.elapsed_s ?? 0,
      explored_pct: mission?.explored_pct ?? 0,
      survivors_found: found.length,
      distance_m: mission?.distance_m ?? 0,
      battery_pct: telemetry?.battery.pct ?? null,
      survivors: found.map((s) => ({
        id: s.id,
        x: s.x,
        y: s.y,
        cell: cellLabel(s.x, s.y, cfg),
        conf: s.conf,
      })),
      finished_at: new Date().toISOString(),
    }
    const png = exportFinalMap()

    fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report, png }),
    })
      .then((r) => (r.ok ? setReportState('done') : setReportState('error')))
      .catch(() => setReportState('error'))
  }, [active, state, mission, survivors, telemetry, cfg])

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    },
    [],
  )

  if (!active) return null

  const found = Object.values(survivors).sort((a, b) => a.id - b.id)
  const aborted = state === 'ABORTED'
  const failed = state === 'FAILSAFE'

  const doReset = () => {
    if (resetting) return
    setResetting(true)
    setResetError(null)
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => {
      resetTimer.current = null
      setResetting(false)
      setResetError('reset timed out — is the simulator still running?')
    }, 7000)

    fetch('/api/reset', { method: 'POST' })
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { detail?: string }
          throw new Error(body.detail ?? `HTTP ${r.status}`)
        }
      })
      .catch((err: unknown) => {
        if (resetTimer.current !== null) {
          window.clearTimeout(resetTimer.current)
          resetTimer.current = null
        }
        setResetting(false)
        setConfirmReset(false)
        setResetError(err instanceof Error ? err.message : 'reset failed')
      })
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-md fade-in">
      <div
        className={`panel rise w-[640px] max-w-[92vw] p-8 ${
          aborted
            ? 'border-crit/70 shadow-[0_0_60px_-20px_rgba(255,93,115,0.9)]'
            : failed
              ? 'border-warn/70 shadow-[0_0_60px_-20px_rgba(255,194,75,0.9)]'
              : 'border-ok/60 shadow-[0_0_60px_-20px_rgba(62,230,160,0.9)]'
        }`}
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="micro">
              {aborted ? 'MISSION ABORTED' : failed ? 'FAILSAFE TRIGGERED' : 'MISSION COMPLETE'}
            </div>
            <div
              className={`text-4xl font-bold tracking-[0.2em] ${
                aborted ? 'text-crit' : failed ? 'text-warn' : 'text-ok'
              }`}
            >
              {aborted ? 'ABORTED' : failed ? 'FAILSAFE' : 'EXITED'}
            </div>
          </div>
          <div className="text-right">
            <div className="micro">TOTAL TIME</div>
            <div className="num text-4xl font-bold text-ink">{fmt(mission?.elapsed_s ?? 0)}</div>
          </div>
        </div>

        {failed && (
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(failsafe)
              .filter(([, on]) => on)
              .map(([key]) => (
                <span
                  key={key}
                  className="rounded border border-crit/50 bg-crit/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-crit"
                >
                  {key.replace('_', ' ')}
                </span>
              ))}
          </div>
        )}

        <div className="mt-6 grid grid-cols-3 gap-3">
          {[
            ['SURVIVORS', `${found.length}/6`],
            ['EXPLORED', `${Math.round(mission?.explored_pct ?? 0)}%`],
            ['DISTANCE', `${(mission?.distance_m ?? 0).toFixed(1)} m`],
          ].map(([k, v]) => (
            <div key={k} className="tile p-3 text-center">
              <div className="micro">{k}</div>
              <div className="num mt-1 text-2xl font-bold text-ink">{v}</div>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <div className="micro mb-2">SURVIVOR TAGS</div>
          <div className="flex flex-wrap gap-2">
            {found.length === 0 && <span className="text-sm text-dim">none detected</span>}
            {found.map((s) => (
              <span
                key={s.id}
                className="rounded border border-survivor/50 bg-survivor/10 px-2 py-1 text-xs font-semibold text-survivor"
              >
                S{s.id} · {cellLabel(s.x, s.y, cfg)} · {(s.conf * 100).toFixed(0)}%
              </span>
            ))}
          </div>
        </div>

        <div className="micro mt-6 flex items-center justify-between text-[10px]">
          <span>
            report:{' '}
            {reportState === 'sending'
              ? 'saving…'
              : reportState === 'done'
                ? 'saved to logs/'
                : reportState === 'error'
                  ? 'save failed'
                  : 'idle'}
          </span>
          <span>final map PNG + JSON auto-saved</span>
        </div>

        <div className="mt-4 rounded-[12px] border border-border/70 bg-black/25 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="micro">SIMULATOR RESET</div>
              <div className="mt-1 text-xs text-dim">
                Return the drone to READY and clear the map, survivors and events for a new run.
              </div>
              <div className="micro mt-1 text-[9px]">
                simulator-only · never sent to real hardware
              </div>
            </div>

            {replay ? (
              <span className="micro shrink-0 text-dim">replay locked</span>
            ) : simMode ? (
              confirmReset ? (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmReset(false)
                      setResetError(null)
                    }}
                    className="btn border-border px-3 py-2 text-xs uppercase tracking-[0.16em] text-dim"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={doReset}
                    disabled={resetting}
                    className="btn border-crit/70 bg-crit/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-crit disabled:opacity-50"
                  >
                    {resetting ? 'Resetting…' : 'Confirm reset'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  className="btn shrink-0 border-warn/60 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-warn"
                >
                  Reset sim
                </button>
              )
            ) : (
              <span className="micro shrink-0 text-dim">run with --sim</span>
            )}
          </div>
          {resetError && <div className="mt-2 text-xs text-crit">{resetError}</div>}
        </div>
      </div>
    </div>
  )
}
