import { useCallback, useEffect, useState } from 'react'
import type { Stack, WizardVariant } from '../../shared/types'
import ProjectsHome from './home/ProjectsHome'
import OnboardingWizard from './onboarding/OnboardingWizard'
import TopBar from './components/TopBar'

type AppMode = 'loading' | 'manager' | 'onboarding'

/** Single-window shell: the project-cards home screen (ProjectsHome) is the app's only
 *  navigation surface now — the old left icon rail is gone. When a project is open, a slim
 *  TopBar ("← Projects" + name + status dot) sits above the embedded portal WebContentsView
 *  (main draws that view itself; this bar is native chrome the view never covers — see
 *  main/viewBounds.ts, which now reserves TOP space instead of LEFT). */
export default function App() {
  const [mode, setMode] = useState<AppMode>('loading')
  // Which framing the wizard uses when mode === 'onboarding'. Defaults to 'first-run' —
  // the zero-stack path below sets it explicitly; add-project entry points override it.
  const [wizardVariant, setWizardVariant] = useState<WizardVariant>('first-run')
  // Which stack's embedded portal view (main-process WebContentsView) is currently showing.
  // null = the renderer's own content (home/manager or the wizard) is on screen — no TopBar.
  // Main is the source of truth (a notification click or deep link can change this without
  // any click here), mirrored via onPortalActive; we also keep the live Stack object (not
  // just its project id) so TopBar can show a name + running dot without a second fetch.
  const [activeProject, setActiveProject] = useState<string | null>(null)
  const [stacks, setStacks] = useState<Stack[]>([])

  const refreshStacks = useCallback(async () => {
    try {
      setStacks(await window.orchaDesktop.listStacks())
    } catch {
      setStacks([])
    }
  }, [])

  // Decide the initial mode before showing the home screen: zero stacks → onboarding.
  useEffect(() => {
    let cancelled = false
    void window.orchaDesktop
      .listStacks()
      .then((s) => {
        if (cancelled) return
        setStacks(s)
        setWizardVariant('first-run')
        setMode(s.length === 0 ? 'onboarding' : 'manager')
      })
      .catch(() => {
        if (!cancelled) setMode('manager') // Docker down → ProjectsHome shows its banner
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Keep a live stack list for the TopBar's name/status lookup — cheap poll, independent of
  // ProjectsHome's own (richer, per-container) refresh cycle.
  useEffect(() => {
    const timer = setInterval(() => void refreshStacks(), 5000)
    return () => clearInterval(timer)
  }, [refreshStacks])

  // Main is the source of truth for which portal view is showing (tray/notification/deep
  // link can change it without a click in this window).
  useEffect(() => window.orchaDesktop.onPortalActive(({ project }) => setActiveProject(project)), [])

  // File→Add Project (main) asks us to switch. Main already hides any embedded portal view
  // before sending this (wizard/home = no view visible), so just follow its lead here too.
  useEffect(
    () =>
      window.orchaDesktop.onNavigate(({ target, variant }) => {
        if (target === 'onboarding') {
          setWizardVariant(variant ?? 'add-project')
          setActiveProject(null)
        }
        setMode(target)
      }),
    []
  )

  const showHome = useCallback(() => {
    void window.orchaDesktop.portalHide()
    setMode('manager')
  }, [])

  const startAddProject = useCallback(() => {
    // Wizard/home = no view visible — hide any embedded portal before mounting the wizard.
    void window.orchaDesktop.portalHide()
    setWizardVariant('add-project')
    setMode('onboarding')
  }, [])

  if (mode === 'loading') return <div className="h-full animate-fade-in" />

  const activeStack = activeProject !== null ? stacks.find((s) => s.project === activeProject) : undefined

  return (
    <div className="flex h-full flex-col">
      {mode === 'manager' && activeStack && <TopBar stack={activeStack} onBack={showHome} />}
      <div className="min-w-0 flex-1">
        {mode === 'onboarding' ? (
          <OnboardingWizard
            variant={wizardVariant}
            onDone={() => setMode('manager')}
            onCancel={wizardVariant === 'add-project' ? () => setMode('manager') : undefined}
          />
        ) : (
          // The home grid renders underneath the embedded portal view even while a project is
          // open (the WebContentsView draws above it) — cheap to leave mounted, and it's
          // instantly there once the TopBar's back button hides the view.
          <ProjectsHome onCreate={startAddProject} />
        )}
      </div>
    </div>
  )
}
