// 1.5 s boot sequence shown on load.

import { useEffect, useRef, useState } from 'react'

const LINES = [
  'initialising mission core',
  'loading bundled fonts / assets',
  'binding telemetry websocket',
  'arming failsafe monitors',
  'gcs ready',
]

export default function BootSequence({ onDone }: { onDone: () => void }) {
  const [shown, setShown] = useState(0)
  const [fade, setFade] = useState(false)

  // The parent re-renders at telemetry rate; keep the latest callback in a ref
  // and run the boot timers exactly once so a busy link cannot restart them.
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    const t0 = performance.now()
    const id = window.setInterval(() => {
      const p = (performance.now() - t0) / 1500
      setShown(Math.min(LINES.length, Math.floor(p * LINES.length) + 1))
    }, 60)
    const done = window.setTimeout(() => setFade(true), 1500)
    const remove = window.setTimeout(() => onDoneRef.current(), 1900)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(done)
      window.clearTimeout(remove)
    }
  }, [])

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg transition-opacity duration-300 ${
        fade ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="h-8 w-8 rotate-45 rounded-[9px] border border-accent/50 bg-accent/10 shadow-glow" />
        <span className="text-3xl font-extrabold tracking-[0.35em]">
          <span className="title-grad">AIRMOUSE</span> <span className="text-accent">//</span>{' '}
          <span className="text-ink">GCS</span>
        </span>
      </div>
      <div className="num mt-8 w-80 space-y-1 text-xs text-dim">
        {LINES.slice(0, shown).map((l) => (
          <div key={l} className="flex items-center justify-between fade-in">
            <span>{l}</span>
            <span className="text-ok">[ ok ]</span>
          </div>
        ))}
      </div>
      <div className="mt-8 h-1 w-80 overflow-hidden rounded-full border border-border/60 bg-black/50">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent2 via-accent to-mint shadow-[0_0_14px_rgba(53,224,240,0.8)]"
          style={{ width: `${(shown / LINES.length) * 100}%`, transition: 'width 200ms linear' }}
        />
      </div>
    </div>
  )
}
