// Failsafe chips plus a GCS link-loss banner.
import { useStore } from '../store'
import type { Failsafe } from '../lib/protocol'

const CHIPS: { key: keyof Failsafe; label: string }[] = [
  { key: 'low_battery', label: 'LOW BATTERY' },
  { key: 'link_loss', label: 'LINK LOSS' },
  { key: 'geofence', label: 'GEOFENCE' },
  { key: 'abort', label: 'ABORT' },
  { key: 'recall', label: 'RECALL' },
]

export default function FailsafeStrip() {
  const failsafe = useStore((s) => s.failsafe)
  const gcsLink = useStore((s) => s.gcsLink)

  return (
    <div className="panel flex h-full w-full min-h-0 flex-col gap-1 overflow-hidden p-2">
      {!gcsLink && (
        <div className="flash w-full rounded-[10px] border border-crit bg-crit/20 px-3 py-1 text-center text-xs font-bold uppercase tracking-widest text-crit">
          GCS LINK LOST — DRONE TELEMETRY STALE
        </div>
      )}
      <div className="flex flex-1 items-center gap-2">
        {CHIPS.map((c) => {
          const on = failsafe[c.key]
          return (
            <div
              key={c.key}
              className={`flex flex-1 items-center justify-center gap-2 rounded-[10px] border px-2 py-1 text-center text-[11px] font-semibold uppercase tracking-wider transition-colors duration-300 ${
                on
                  ? 'flash border-crit bg-crit/20 text-crit shadow-[0_0_22px_-8px_rgba(255,93,115,0.9)]'
                  : 'border-ok/25 bg-gradient-to-b from-ok/[0.07] to-transparent text-ok/80'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  on ? 'bg-crit shadow-[0_0_8px_currentColor]' : 'bg-ok/60'
                }`}
              />
              {c.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}
