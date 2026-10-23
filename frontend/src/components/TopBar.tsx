// Top mission bar: identity, state, timer + ring, link, battery, survivors, explored.
import { useConfig, useStore } from '../store'
import type { MissionState } from '../lib/protocol'

const STATE_STYLE: Record<MissionState, string> = {
  IDLE: 'border-border text-dim bg-black/20',
  PREFLIGHT: 'border-warn/60 text-warn bg-warn/10',
  READY: 'border-accent/70 text-accent bg-accent/10 shadow-glow',
  EXPLORING: 'border-ok/70 text-ok bg-ok/10',
  RETURNING: 'border-accent2/70 text-accent2 bg-accent2/10',
  EXITED: 'border-ok/70 text-ok bg-ok/10',
  ABORTED: 'border-crit/70 text-crit bg-crit/10',
  FAILSAFE: 'border-crit/70 text-crit bg-crit/10',
}

const STATE_DOT: Record<MissionState, string> = {
  IDLE: 'bg-dim',
  PREFLIGHT: 'bg-warn',
  READY: 'bg-accent',
  EXPLORING: 'bg-ok',
  RETURNING: 'bg-accent2',
  EXITED: 'bg-ok',
  ABORTED: 'bg-crit',
  FAILSAFE: 'bg-crit',
}

const PULSE: MissionState[] = ['EXPLORING', 'RETURNING', 'PREFLIGHT']

function fmtTime(s: number): string {
  const total = Number.isFinite(s) && s > 0 ? s : 0
  const m = Math.floor(total / 60)
  const sec = Math.floor(total % 60)
  const tenths = Math.floor((total * 10) % 10)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${tenths}`
}

export default function TopBar() {
  const cfg = useConfig()
  const mission = useStore((s) => s.mission)
  const telemetry = useStore((s) => s.telemetry)
  const survivors = useStore((s) => s.survivors)

  const count = Object.keys(survivors).length
  const state: MissionState = mission?.state ?? 'IDLE'
  const elapsed = mission?.elapsed_s ?? 0
  const explored = mission?.explored_pct ?? 0

  const maxS = cfg.max_flight_s > 0 ? cfg.max_flight_s : 1800
  const frac = Math.min(1, Math.max(0, elapsed / maxS))
  const R = 26
  const C = 2 * Math.PI * R
  const dash = C * (1 - frac)
  const ringColor = elapsed >= 1680 ? '#FF5D73' : elapsed >= 1500 ? '#FFC24B' : '#35E0F0'

  const link = telemetry?.link
  const batt = telemetry?.battery
  const dot = !link ? 'bg-dim' : link.rssi >= -60 ? 'bg-ok' : link.rssi >= -75 ? 'bg-warn' : 'bg-crit'
  const pct = batt ? Math.round(batt.pct) : null
  const battGrad =
    pct == null
      ? 'linear-gradient(90deg,#243a55,#2b4664)'
      : pct > 50
        ? 'linear-gradient(90deg,#159a70,#46F0C0)'
        : pct >= 25
          ? 'linear-gradient(90deg,#b07a1c,#FFC24B)'
          : 'linear-gradient(90deg,#a8324a,#FF5D73)'

  return (
    <div className="panel rise flex h-full w-full min-h-0 items-center gap-4 overflow-hidden px-4 py-2">
      <div className="flex shrink-0 items-center gap-3">
        <span className="relative flex h-9 w-9 items-center justify-center">
          <span className="absolute inset-0 rotate-45 rounded-[10px] border border-accent/50 bg-accent/10 shadow-glow" />
          <span className="absolute inset-[9px] rotate-45 rounded-[3px] bg-accent shadow-glow" />
        </span>
        <div className="leading-none">
          <div className="text-[15px] font-extrabold tracking-[0.22em]">
            <span className="title-grad">AIRMOUSE</span>{' '}
            <span className="text-accent">//</span>{' '}
            <span className="text-ink">GCS</span>
          </div>
          <div className="micro mt-1 text-[9px]">ground control · offline</div>
        </div>
      </div>

      <span
        className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider transition-colors duration-200 ${STATE_STYLE[state]}`}
      >
        <span className="relative flex h-2 w-2">
          {PULSE.includes(state) && (
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${STATE_DOT[state]} opacity-70`} />
          )}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${STATE_DOT[state]}`} />
        </span>
        {state}
      </span>

      <div className="flex shrink-0 items-center gap-3">
        <svg viewBox="0 0 64 64" className="h-14 w-14 -rotate-90">
          <circle cx={32} cy={32} r={R} fill="none" stroke="#16273d" strokeWidth={6} />
          <circle cx={32} cy={32} r={R} fill="none" stroke="#1E3350" strokeWidth={1} strokeDasharray="1 4" />
          <circle
            cx={32}
            cy={32}
            r={R}
            fill="none"
            stroke={ringColor}
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={dash}
            style={{
              transition: 'stroke-dashoffset 300ms linear, stroke 300ms linear',
              filter: `drop-shadow(0 0 5px ${ringColor})`,
            }}
          />
        </svg>
        <div className="leading-none">
          <div className="micro">MISSION TIME</div>
          <div
            className="num text-[40px] font-bold leading-none text-ink"
            style={{ textShadow: '0 0 22px rgba(53,224,240,0.25)' }}
          >
            {fmtTime(elapsed)}
          </div>
          <div className="num mt-1 text-[11px] text-dim">
            REM {fmtTime(Math.max(0, maxS - elapsed))} / {fmtTime(maxS)}
          </div>
        </div>
      </div>

      <div className="flex-1" />

      <div className="flex shrink-0 items-center gap-2 rounded-[10px] border border-border/70 bg-black/25 px-3 py-1.5">
        <span className={`h-2.5 w-2.5 rounded-full ${dot} shadow-[0_0_10px_currentColor]`} />
        <div className="leading-tight">
          <div className="micro">LINK</div>
          <div className="num text-xs text-ink">{link ? `${Math.round(link.rssi)} dBm` : '—'}</div>
          <div className="num text-[10px] text-dim">
            {link ? `${Math.round(link.latency_ms)} ms · ${link.loss_pct.toFixed(0)}%` : '—'}
          </div>
        </div>
      </div>

      <div className="w-32 shrink-0">
        <div className="flex items-center justify-between">
          <span className="micro">BATTERY</span>
          <span className="num text-xs text-ink">{pct != null ? `${pct}%` : '—'}</span>
        </div>
        <div className="relative mt-1 h-2 w-full overflow-hidden rounded-full border border-black/40 bg-black/50">
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${pct ?? 0}%`, background: battGrad, boxShadow: '0 0 10px -2px currentColor' }}
          />
        </div>
        <div className="num mt-0.5 text-[10px] text-dim">{batt ? `${batt.v.toFixed(2)} V` : '—'}</div>
      </div>

      <div className="shrink-0 rounded-[10px] border border-survivor/25 bg-survivor/5 px-3 py-1.5 text-center">
        <div className="micro">SURVIVORS</div>
        <div className="num text-xl font-bold text-survivor">{count}/6</div>
        <div className="mt-1 flex items-center justify-center gap-1">
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className={`h-1.5 w-1.5 rounded-full transition-colors duration-300 ${
                i < count ? 'bg-survivor shadow-[0_0_6px_currentColor]' : 'bg-border'
              }`}
            />
          ))}
        </div>
      </div>

      <div className="shrink-0 rounded-[10px] border border-accent/25 bg-accent/5 px-3 py-1.5 text-center">
        <div className="micro">EXPLORED</div>
        <div className="num text-xl font-bold text-accent">{Math.round(explored)}%</div>
        <div className="mt-1 h-1 w-20 overflow-hidden rounded-full bg-black/50">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent2 to-accent transition-[width] duration-500"
            style={{ width: `${Math.min(100, Math.max(0, explored))}%` }}
          />
        </div>
      </div>
    </div>
  )
}
