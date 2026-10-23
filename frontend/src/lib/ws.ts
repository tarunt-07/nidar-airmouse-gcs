// Auto-reconnecting websocket client for the /ws dashboard endpoint.
// Backoff is capped at 2 s. Callers register message/status handlers once.

import type { Command, ServerMessage } from './protocol'

type MessageHandler = (msg: ServerMessage) => void
type StatusHandler = (status: 'connecting' | 'open' | 'closed') => void

const messageHandlers = new Set<MessageHandler>()
const statusHandlers = new Set<StatusHandler>()

let socket: WebSocket | null = null
let backoff = 250
let started = false
let online = true

export function onWsMessage(fn: MessageHandler): () => void {
  messageHandlers.add(fn)
  return () => messageHandlers.delete(fn)
}

export function onWsStatus(fn: StatusHandler): () => void {
  statusHandlers.add(fn)
  return () => statusHandlers.delete(fn)
}

function emitStatus(status: 'connecting' | 'open' | 'closed') {
  statusHandlers.forEach((fn) => fn(status))
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

function scheduleReconnect() {
  if (!online) return
  const delay = Math.min(backoff, 2000)
  backoff = Math.min(backoff * 2, 2000)
  window.setTimeout(connectWs, delay)
}

export function connectWs(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return
  }
  started = true
  emitStatus('connecting')
  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl())
  } catch {
    scheduleReconnect()
    return
  }
  socket = ws

  ws.onopen = () => {
    backoff = 250
    emitStatus('open')
  }
  ws.onmessage = (ev) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    messageHandlers.forEach((fn) => fn(msg))
  }
  ws.onclose = () => {
    if (socket === ws) socket = null
    emitStatus('closed')
    scheduleReconnect()
  }
  ws.onerror = () => {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }
}

export function sendCommand(cmd: Command): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ cmd }))
  }
}

// When the browser loses/regains connectivity, reconnect immediately.
window.addEventListener('online', () => {
  online = true
  backoff = 250
  if (started) connectWs()
})
window.addEventListener('offline', () => {
  online = false
})
