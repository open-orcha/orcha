import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import TrayPanel from './tray/TrayPanel'

const isTray = window.location.hash === '#tray'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isTray ? <TrayPanel /> : <App />}</React.StrictMode>
)
