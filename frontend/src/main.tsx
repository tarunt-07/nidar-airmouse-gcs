import React from 'react'
import { createRoot } from 'react-dom/client'

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'

import './index.css'
import App from './App'
import { connectWs, onWsMessage, onWsStatus } from './lib/ws'
import { isReplay, loadReplay } from './lib/replay'
import { useStore } from './store'

const replayFile = new URLSearchParams(location.search).get('file')

if (isReplay() && replayFile) {
  // Replay mode: the data source is a recorded log, not the live websocket.
  useStore.getState().setWsStatus('open')
  void loadReplay(replayFile)
} else {
  onWsMessage((msg) => useStore.getState().applyMessage(msg))
  onWsStatus((status) => useStore.getState().setWsStatus(status))
  connectWs()
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
