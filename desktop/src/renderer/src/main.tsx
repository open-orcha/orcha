import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import TrayPanel from './tray/TrayPanel'
import OnboardingApp from './onboarding/OnboardingApp'

const hash = window.location.hash

function Root() {
  if (hash === '#tray') return <TrayPanel />
  if (hash === '#onboarding') return <OnboardingApp />
  return <App />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
