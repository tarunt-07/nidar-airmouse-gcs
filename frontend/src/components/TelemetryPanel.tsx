// Telemetry tiles + mini compass + battery/speed sparklines.
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

const OK = '#34D399'
const ACC = '#22D3EE'

function Spark({ data, color, label }: { data: number[]; color: string; label: string }) {
  const W = 100
  const H = 34
  const min = data.length ? Math.min(...data) : 0
  const max = data.length ? Math.max(...data) : 0
  const span = max - min || 1
  const pts = data
    .map((v, i) => {
      const x = data.length > 1 ? (i / (data.length - 1)) * W : 0
      const y = H - ((v - min) / span) * (H - 4) - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <div className="min-h-0 tile">
      <div className="flex items-center justify-between">
        <span className="micro">{label}</span>
        <span className="num text-[10px] text-dim">
          {min.toFixed(1)}–{max.toFixed(1)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-1 w-full" style={{ height: H }}>
        {data.length > 1 && (
          <polyline points={pts} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
    </div>
  )
}

function Stat({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    <div className="tile">
      <div className="micro">{label}</div>
      <div className={`num text-[28px] font-bold leading-none ${color ?? 'text-ink'}`}>
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-dim">{unit}</span>}
      </div>
    </div>
  )
}

function Compass({ yaw }: { yaw: number }) {
  const deg = (((yaw * 180) / Math.PI) % 360 + 360) % 360
  return (
    <svg viewBox="0 0 64 64" className="h-14 w-14 shrink-0">
      <circle cx={32} cy={32} r={28} fill="none" stroke="#1B2A3F" strokeWidth={2} />
      <g transform={`rotate(${-deg} 32 32)`}>
        <polygon points="52,32 30,28 30,36" fill={ACC} />
        <polygon points="12,32 30,28 30,36" fill="#7C8DA6" opacity={0.45} />
      </g>
      <circle cx={32} cy={32} r={2.5} fill="#D7E3F4" />
    </svg>
  )
}

export default function TelemetryPanel() {
  const telemetry = useStore((s) => s.telemetry)
  const mission = useStore((s) => s.mission)

  const [battHist, setBattHist] = useState<number[]>([])
  const [speedHist, setSpeedHist] = useState<number[]>([])
  const lastTRef = useRef<number | null>(null)

  useEffect(() => {
    if (!telemetry) return
    const t = telemetry.t
    if (lastTRef.current != null && t - lastTRef.current < 0.5) return
    lastTRef.current = t
    setBattHist((h) => [...h, telemetry.battery.pct].slice(-120))
    setSpeedHist((h) => [...h, telemetry.speed].slice(-120))
  }, [telemetry])

  const yawDeg = telemetry ? ((((telemetry.pose.yaw * 180) / Math.PI) % 360) + 360) % 360 : 0
  const battPct = telemetry ? Math.round(telemetry.battery.pct) : null
  const battColor = battPct == null ? undefined : battPct > 50 ? 'text-ok' : battPct >= 25 ? 'text-warn' : 'text-crit'

  return (
    <div className="panel flex h-full w-full min-h-0 flex-col gap-2 overflow-hidden p-2">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="SPEED" value={telemetry ? telemetry.speed.toFixed(2) : '—'} unit="m/s" />
        <Stat label="ALTITUDE" value={telemetry ? telemetry.alt.toFixed(2) : '—'} unit="m" />
        <div className="flex items-center gap-2 tile">
          <Compass yaw={telemetry?.pose.yaw ?? 0} />
          <div>
            <div className="micro">HEADING</div>
            <div className="num text-[28px] font-bold leading-none text-ink">
              {telemetry ? `${yawDeg.toFixed(0)}°` : '—'}
            </div>
          </div>
        </div>
        <Stat label="DISTANCE" value={mission ? mission.distance_m.toFixed(1) : '—'} unit="m" />
        <Stat label="BATTERY" value={telemetry ? telemetry.battery.v.toFixed(2) : '—'} unit="V" />
        <Stat label="CHARGE" value={battPct != null ? `${battPct}%` : '—'} color={battColor} />
      </div>
      <div className="grid min-h-0 grid-cols-2 gap-2">
        <Spark data={speedHist} color={ACC} label="SPEED m/s" />
        <Spark data={battHist} color={OK} label="BATTERY %" />
      </div>
    </div>
  )
}
