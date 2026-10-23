// Scrollable event log, newest at the bottom, auto-scrolls on new events.
import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import type { LogEvent } from '../store'

function fmtT(s: number): string {
  const t = Number.isFinite(s) && s > 0 ? s : 0
  const m = Math.floor(t / 60)
  const sec = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

const TAG: Record<LogEvent['level'], string> = {
  info: 'text-dim',
  warn: 'text-warn',
  crit: 'text-crit',
}

const MSG: Record<LogEvent['level'], string> = {
  info: 'text-ink',
  warn: 'text-warn',
  crit: 'text-crit',
}

export default function EventLog() {
  const events = useStore((s) => s.events)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events])

  return (
    <div className="panel flex h-full w-full min-h-0 flex-col overflow-hidden">
      <div className="panel-head">
        <span className="micro">EVENT LOG</span>
        <span className="num rounded-full border border-border px-2 py-0.5 text-[10px] text-dim">
          {events.length}
        </span>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto bg-black/30 p-2">
        {events.length === 0 && <div className="p-2 text-xs text-dim">no events</div>}
        {events.map((e) => (
          <div
            key={e.id}
            className="flex items-start gap-2 border-b border-border/40 px-1 py-1 text-[12px] leading-snug transition-colors duration-200 last:border-0 hover:bg-white/[0.03]"
          >
            <span className="num shrink-0 text-dim">T+{fmtT(e.t)}</span>
            <span className={`shrink-0 font-semibold ${TAG[e.level]}`}>
              {e.level.toUpperCase()}
            </span>
            <span className={`break-words ${MSG[e.level]}`}>{e.msg}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
