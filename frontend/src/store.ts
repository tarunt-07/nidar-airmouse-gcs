// Global zustand store. Holds the latest state of every message type.
// The map is decoded to an Int8Array with the built-in DecompressionStream.

import { create } from 'zustand'
import type {
  Config,
  Failsafe,
  MapState,
  Mission,
  PathMsg,
  Preflight,
  ServerMessage,
  Survivor,
  Telemetry,
} from './lib/protocol'

export interface LogEvent {
  id: number
  t: number
  level: 'info' | 'warn' | 'crit'
  msg: string
}

export const FALLBACK_CONFIG: Config = {
  cell_size_m: 1.0,
  arena_w_m: 15,
  arena_h_m: 15,
  entry: { x: 0.5, y: 0.5 },
  max_flight_s: 1800,
  setup_s: 300,
  video_url: 'http://localhost:8081/stream',
  map_res_m: 0.1,
}

const NO_FAILSAFE: Failsafe = {
  low_battery: false,
  link_loss: false,
  geofence: false,
  abort: false,
  recall: false,
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function inflateZlib(bytes: Uint8Array): Promise<Int8Array> {
  const ds = new DecompressionStream('deflate')
  const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(ds)
  const buf = await new Response(stream).arrayBuffer()
  return new Int8Array(buf)
}

let eventSeq = 0
let mapSeq = 0

interface State {
  config: Config | null
  telemetry: Telemetry | null
  mission: Mission | null
  map: MapState | null
  path: PathMsg | null
  survivors: Record<number, Survivor>
  survivorOrder: number[]
  failsafe: Failsafe
  preflight: Preflight | null
  events: LogEvent[]
  gcsLink: boolean
  wsStatus: 'connecting' | 'open' | 'closed'
  booted: boolean

  setBooted: (v: boolean) => void
  setConfig: (c: Config) => void
  setWsStatus: (s: 'connecting' | 'open' | 'closed') => void
  pushEvent: (e: { level: LogEvent['level']; msg: string }) => void
  applyMessage: (msg: ServerMessage) => void
  resetMission: () => void
}

export const useStore = create<State>((set, get) => ({
  config: null,
  telemetry: null,
  mission: null,
  map: null,
  path: null,
  survivors: {},
  survivorOrder: [],
  failsafe: NO_FAILSAFE,
  preflight: null,
  events: [],
  gcsLink: true,
  wsStatus: 'connecting',
  booted: false,

  setBooted: (v) => set({ booted: v }),
  setConfig: (c) => set({ config: c }),
  setWsStatus: (s) => set({ wsStatus: s }),

  pushEvent: (e) => {
    const t = get().mission?.elapsed_s ?? 0
    const ev: LogEvent = { id: ++eventSeq, t, level: e.level, msg: e.msg }
    set((st) => ({ events: [...st.events, ev].slice(-200) }))
  },

  resetMission: () =>
    set({
      telemetry: null,
      mission: null,
      map: null,
      path: null,
      survivors: {},
      survivorOrder: [],
      failsafe: NO_FAILSAFE,
      preflight: null,
      events: [],
    }),

  applyMessage: (msg) => {
    switch (msg.type) {
      case 'telemetry':
        set({ telemetry: msg })
        break
      case 'mission':
        set({ mission: msg })
        break
      case 'path':
        set({ path: msg })
        break
      case 'failsafe':
        set({ failsafe: msg })
        break
      case 'preflight':
        set({ preflight: msg })
        break
      case 'gcs_link':
        if (get().gcsLink !== msg.ok) {
          get().pushEvent({
            level: msg.ok ? 'info' : 'warn',
            msg: msg.ok ? 'drone link restored' : 'drone link lost',
          })
        }
        set({ gcsLink: msg.ok })
        break
      case 'event':
        get().pushEvent({ level: msg.level, msg: msg.msg })
        break
      case 'survivor': {
        const st = get()
        const order = st.survivorOrder.includes(msg.id)
          ? st.survivorOrder
          : [...st.survivorOrder, msg.id]
        set({ survivors: { ...st.survivors, [msg.id]: msg }, survivorOrder: order })
        break
      }
      case 'map': {
        inflateZlib(b64ToBytes(msg.data))
          .then((grid) => {
            set({
              map: {
                res: msg.res,
                w: msg.w,
                h: msg.h,
                origin: msg.origin,
                grid,
                version: ++mapSeq,
              },
            })
          })
          .catch(() => {
            /* ignore malformed frame */
          })
        break
      }
    }
  },
}))

export function useConfig(): Config {
  return useStore((s) => s.config) ?? FALLBACK_CONFIG
}
