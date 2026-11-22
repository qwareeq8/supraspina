/** Installs the browser mock when needed, and mounts the React root. */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installMockSupraspina } from './ipc/mock'
import './theme/global.css'

if (!window.supraspina) {
  installMockSupraspina()
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('Provide the #root container before starting the renderer.')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
