import { useEffect } from 'react'
import BootSequence from './components/BootSequence'
import TopBar from './components/TopBar'
import FailsafeStrip from './components/FailsafeStrip'
import MapPanel from './components/MapPanel'
import VideoPanel from './components/VideoPanel'
import SurvivorPanel from './components/SurvivorPanel'
import TelemetryPanel from './components/TelemetryPanel'
import EventLog from './components/EventLog'
import ControlBar from './components/ControlBar'
import PreflightScreen from './components/PreflightScreen'
import MissionEndOverlay from './components/MissionEndOverlay'
import ReplayBar from './components/ReplayBar'
import { FALLBACK_CONFIG, useStore } from './store'
import { isReplay } from './lib/replay'

export default function App() {
  const booted = useStore((s) => s.booted)
  const mission = useStore((s) => s.mission)
  const setConfig = useStore((s) => s.setConfig)

  const params = new URLSearchParams(location.search)
  const replay = isReplay()
  const kiosk = params.get('kiosk') === '1'

  useEffect(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((c) => setConfig(c))
      .catch(() => setConfig(FALLBACK_CONFIG))
  }, [setConfig])

  useEffect(() => {
    if (!kiosk) return
    document.body.classList.add('kiosk')
    const go = () => {
      document.documentElement.requestFullscreen?.().catch(() => {})
      window.removeEventListener('pointerdown', go)
    }
    window.addEventListener('pointerdown', go)
    return () => {
      document.body.classList.remove('kiosk')
      window.removeEventListener('pointerdown', go)
    }
  }, [kiosk])

  const state = mission?.state ?? 'IDLE'
  const preflight = state === 'IDLE' || state === 'PREFLIGHT' || state === 'READY'
  const showPreflight = preflight && !replay

  return (
    <>
      {!booted && <BootSequence onDone={() => useStore.getState().setBooted(true)} />}

      <div className="flex h-screen w-screen flex-col gap-2 overflow-hidden p-2">
        <div className="h-[76px] shrink-0">
          <TopBar />
        </div>

        <div className="h-11 shrink-0">
          <FailsafeStrip />
        </div>

        {replay && <ReplayBar />}

        <div className="flex min-h-0 flex-1 gap-2">
          {showPreflight ? (
            <div className="min-w-0 flex-1">
              <PreflightScreen />
            </div>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <MapPanel />
              </div>
              <div className="flex w-[38%] min-w-0 shrink-0 flex-col gap-2">
                <div className="panel relative h-[38%] min-h-0 overflow-hidden">
                  <VideoPanel />
                </div>
                <div className="min-h-0 flex-1">
                  <SurvivorPanel />
                </div>
                <div className="min-h-0 flex-1">
                  <TelemetryPanel />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex h-[164px] shrink-0 gap-2">
          <div className="min-h-0 flex-1">
            <EventLog />
          </div>
          <ControlBar />
        </div>
      </div>

      <MissionEndOverlay />
    </>
  )
}
