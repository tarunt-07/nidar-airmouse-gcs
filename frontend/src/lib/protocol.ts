// Wire contract shared by the drone/simulator and the GCS backend.
// Keep in sync with AGENTS.md.

export interface Pose {
  x: number
  y: number
  yaw: number
}

export interface Battery {
  v: number
  pct: number
}

export interface LinkStat {
  rssi: number
  latency_ms: number
  loss_pct: number
}

export type MissionState =
  | 'IDLE'
  | 'PREFLIGHT'
  | 'READY'
  | 'EXPLORING'
  | 'RETURNING'
  | 'EXITED'
  | 'ABORTED'
  | 'FAILSAFE'

export interface Telemetry {
  type: 'telemetry'
  t: number
  pose: Pose
  speed: number
  alt: number
  battery: Battery
  link: LinkStat
}

export interface Mission {
  type: 'mission'
  state: MissionState
  elapsed_s: number
  explored_pct: number
  survivors_found: number
  distance_m: number
}

export interface MapMsg {
  type: 'map'
  res: number
  w: number
  h: number
  origin: { x: number; y: number }
  data: string
}

export interface PathMsg {
  type: 'path'
  trail: [number, number][]
  plan: [number, number][]
}

export interface Survivor {
  type: 'survivor'
  id: number
  x: number
  y: number
  conf: number
  t: number
  snapshot?: string
}

export interface Failsafe {
  low_battery: boolean
  link_loss: boolean
  geofence: boolean
  abort: boolean
  recall: boolean
}

export interface FailsafeMsg extends Failsafe {
  type: 'failsafe'
}

export interface PreflightChecks {
  link: boolean
  video: boolean
  map_stream: boolean
  battery: boolean
  sensors: boolean
  failsafes: boolean
}

export interface Preflight {
  type: 'preflight'
  checks: PreflightChecks
}

export interface EventMsg {
  type: 'event'
  level: 'info' | 'warn' | 'crit'
  msg: string
}

export interface GcsLink {
  type: 'gcs_link'
  ok: boolean
}

export interface Config {
  cell_size_m: number
  arena_w_m: number
  arena_h_m: number
  entry: { x: number; y: number }
  max_flight_s: number
  setup_s: number
  video_url: string
  map_res_m: number
}

export interface MapState {
  res: number
  w: number
  h: number
  origin: { x: number; y: number }
  grid: Int8Array
  version: number
}

export type ServerMessage =
  | Telemetry
  | Mission
  | MapMsg
  | PathMsg
  | Survivor
  | FailsafeMsg
  | Preflight
  | EventMsg
  | GcsLink

export type Command = 'START' | 'ABORT'
