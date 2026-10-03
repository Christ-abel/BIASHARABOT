import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerServiceWorker, requestPersistentStorage } from './lib/pwa.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Installs the offline app shell and the background uploader for queued entries.
registerServiceWorker()

// Protects queued voice notes from being evicted before they upload.
requestPersistentStorage()
