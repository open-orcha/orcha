import { useEffect, useState } from 'react'
import ManagerView from './components/ManagerView'
import OnboardingWizard from './onboarding/OnboardingWizard'

type AppMode = 'loading' | 'manager' | 'onboarding'

export default function App() {
  const [mode, setMode] = useState<AppMode>('loading')

  // Decide the initial mode before showing the manager: zero stacks → onboarding.
  useEffect(() => {
    let cancelled = false
    void window.orchaDesktop
      .listStacks()
      .then((stacks) => {
        if (!cancelled) setMode(stacks.length === 0 ? 'onboarding' : 'manager')
      })
      .catch(() => {
        if (!cancelled) setMode('manager') // Docker down → manager shows its banner
      })
    return () => {
      cancelled = true
    }
  }, [])

  // File→New Project (main) asks us to switch.
  useEffect(() => window.orchaDesktop.onNavigate((target) => setMode(target)), [])

  if (mode === 'loading') return <div className="h-full animate-fade-in" />
  if (mode === 'onboarding') return <OnboardingWizard onDone={() => setMode('manager')} />
  return <ManagerView onCreate={() => setMode('onboarding')} />
}
