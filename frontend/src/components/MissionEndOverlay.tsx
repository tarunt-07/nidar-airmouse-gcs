// Mission-end overlay. On EXITED shows the debrief; on ABORTED a red banner.
// On first entering a terminal state it automatically POSTs the final map PNG
// and a JSON report to /api/report (no operator input).

import { useEffect, useRef, useState } from 'react'
import { useConfig, useStore } from '../store'
import { cellLabel } from '../lib/grid'
import { exportFinalMap } from '../lib/mapExport'

function fmt(s: number): string {
  const t = Math.max(0, Math.floor(s))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export default function MissionEndOverlay() {
  const cfg = useConfig()
  const mission = useStore((s) => s.mission)
  const survivors = useStore((s) => s.survivors)
  const telemetry = useStore((s) => s.telemetry)
  const [reportState, setReportState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const sentRef = useRef(false)

  const state = mission?.state
  const active = state === 'EXITED' || state === 'ABORTED'

  useEffect(() => {
    if (!active) {
      sentRef.current = false
      setReportState('idle')
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

  if (!active) return null

  const found = Object.values(survivors).sort((a, b) => a.id - b.id)
  const aborted = state === 'ABORTED'

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-md fade-in">
      <div
        className={`panel rise w-[640px] max-w-[92vw] p-8 ${
          aborted ? 'border-crit/70 shadow-[0_0_60px_-20px_rgba(255,93,115,0.9)]' : 'border-ok/60 shadow-[0_0_60px_-20px_rgba(62,230,160,0.9)]'
        }`}
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="micro">{aborted ? 'MISSION ABORTED' : 'MISSION COMPLETE'}</div>
            <div className={`text-4xl font-bold tracking-[0.2em] ${aborted ? 'text-crit' : 'text-ok'}`}>
              {aborted ? 'ABORTED' : 'EXITED'}
            </div>
          </div>
          <div className="text-right">
            <div className="micro">TOTAL TIME</div>
            <div className="num text-4xl font-bold text-ink">{fmt(mission?.elapsed_s ?? 0)}</div>
          </div>
        </div>

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
      </div>
    </div>
  )
}
