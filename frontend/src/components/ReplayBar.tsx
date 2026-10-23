// Replay transport bar. Only visible in replay mode.

import { useEffect, useState } from 'react'
import {
  onReplayStatus,
  pause,
  play,
  seek,
  setSpeed,
  type ReplayStatus,
} from '../lib/replay'

const SPEEDS = [1, 2, 4, 8]

function fmt(s: number): string {
  const t = Math.max(0, Math.floor(s))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export default function ReplayBar() {
  const [st, setSt] = useState<ReplayStatus>({
    ready: false,
    playing: false,
    speed: 1,
    t: 0,
    duration: 0,
    error: null,
  })

  useEffect(() => onReplayStatus(setSt), [])

  return (
    <div className="panel flex shrink-0 items-center gap-4 px-4 py-2">
      <span className="flash rounded border border-warn/60 bg-warn/15 px-2 py-1 text-xs font-bold tracking-[0.25em] text-warn">
        REPLAY
      </span>

      <button
        type="button"
        onClick={() => (st.playing ? pause() : play())}
        disabled={!st.ready}
        className="btn w-20 px-3 py-1 text-xs disabled:text-dim"
      >
        {st.playing ? 'Pause' : 'Play'}
      </button>

      <input
        type="range"
        min={0}
        max={Math.max(0.01, st.duration)}
        step={0.05}
        value={st.t}
        onChange={(e) => seek(Number(e.target.value))}
        disabled={!st.ready}
        className="flex-1 accent-accent"
      />

      <span className="num shrink-0 text-xs text-ink">
        {fmt(st.t)} / {fmt(st.duration)}
      </span>

      <div className="flex shrink-0 gap-1">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSpeed(s)}
            className={`btn px-2.5 py-1 text-xs ${
              st.speed === s ? 'border-accent/70 text-accent shadow-glow' : 'text-dim'
            }`}
          >
            {s}x
          </button>
        ))}
      </div>

      <span className="micro shrink-0 text-[9px]">
        {st.error ? st.error : st.ready ? 'recorded mission' : 'loading…'}
      </span>
    </div>
  )
}
