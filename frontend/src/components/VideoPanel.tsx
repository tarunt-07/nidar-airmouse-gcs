// Live MJPEG feed with HUD, NO SIGNAL recovery and click-to-fullscreen.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfig, useStore } from '../store'

export default function VideoPanel() {
  const cfg = useConfig()
  const mission = useStore((s) => s.mission)
  const telemetry = useStore((s) => s.telemetry)

  const imgRef = useRef<HTMLImageElement>(null)
  const framesRef = useRef<number[]>([])
  const downSinceRef = useRef<number | null>(null)
  const retryRef = useRef<number | null>(null)
  const downTimerRef = useRef<number | null>(null)

  const [bust, setBust] = useState(0)
  const [ok, setOk] = useState(false)
  const [down, setDown] = useState(false)
  const [fps, setFps] = useState(15)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now())
      const cutoff = performance.now() - 1000
      framesRef.current = framesRef.current.filter((t) => t >= cutoff)
      setFps(framesRef.current.length > 0 ? framesRef.current.length : 15)
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(
    () => () => {
      if (retryRef.current != null) window.clearTimeout(retryRef.current)
      if (downTimerRef.current != null) window.clearTimeout(downTimerRef.current)
    },
    [],
  )

  const handleLoad = useCallback(() => {
    setOk(true)
    setDown(false)
    downSinceRef.current = null
    if (downTimerRef.current != null) {
      window.clearTimeout(downTimerRef.current)
      downTimerRef.current = null
    }
    framesRef.current.push(performance.now())
  }, [])

  const handleError = useCallback(() => {
    setOk(false)
    if (downSinceRef.current == null) {
      downSinceRef.current = Date.now()
      downTimerRef.current = window.setTimeout(() => setDown(true), 1500)
    }
    if (retryRef.current == null) {
      retryRef.current = window.setTimeout(() => {
        retryRef.current = null
        setBust((b) => b + 1)
      }, 900)
    }
  }, [])

  const toggleFs = useCallback(() => {
    try {
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {})
      } else if (imgRef.current) {
        void imgRef.current.requestFullscreen().catch(() => {})
      }
    } catch {
      /* fullscreen unavailable */
    }
  }, [])

  const sep = cfg.video_url.includes('?') ? '&' : '?'
  const src = `${cfg.video_url}${sep}cb=${bust}`
  const state = mission?.state ?? 'IDLE'
  const latency = telemetry?.link.latency_ms
  const ts = new Date(now).toLocaleTimeString('en-GB', { hour12: false })

  return (
    <div
      className="relative h-full w-full min-h-0 cursor-zoom-in overflow-hidden corner-brackets scanlines bg-black"
      onClick={toggleFs}
      title="click to toggle fullscreen"
    >
      <img
        ref={imgRef}
        src={src}
        alt="drone live feed"
        className="h-full w-full object-contain"
        onLoad={handleLoad}
        onError={handleError}
      />
      <div className="video-sweep" />
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{ background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)' }}
      />

      {!ok && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/70">
          <div className={`text-2xl font-bold tracking-[0.3em] ${down ? 'flash text-crit' : 'text-warn'}`}>
            NO SIGNAL
          </div>
          <div className="micro">{down ? 'retrying feed…' : 'acquiring…'}</div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 z-10 font-mono text-[11px]">
        <div className="absolute left-3 top-3 flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-crit opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-crit" />
          </span>
          <span className="font-semibold tracking-widest text-crit">LIVE</span>
          <span className="rounded border border-border/60 bg-panel/70 px-2 py-0.5 uppercase tracking-wider text-ink">
            {state}
          </span>
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-gradient-to-t from-black/80 to-transparent px-3 py-2">
          <span className="num text-dim">
            FPS <span className="text-ink">{fps}</span>
          </span>
          <span className="num text-dim">
            LAT <span className="text-ink">{latency != null ? `${Math.round(latency)} ms` : '—'}</span>
          </span>
          <span className="num text-dim">{ts}</span>
        </div>
      </div>
    </div>
  )
}
